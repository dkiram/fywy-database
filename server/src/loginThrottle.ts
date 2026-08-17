/**
 * In-memory brute-force protection for the login endpoint.
 *
 * Two independent counters run side by side:
 *
 *   - Per username. The primary defence. Someone guessing at one staff
 *     account gets a small number of tries before that username is put on
 *     a cooldown, regardless of which machine the guesses come from.
 *
 *   - Per client IP. A looser backstop that catches a single machine
 *     spraying guesses across many different usernames, which the
 *     per-username counter would never notice.
 *
 * Both counters expire on their own. There is no admin unlock and no
 * permanent lock: a member of staff who genuinely forgets their password
 * waits out the cooldown rather than phoning the home office.
 *
 * State lives in this process only. The API runs as a single Node process
 * in one container, so that is sufficient, and it keeps the login path free
 * of database writes. The trade-off is that restarting the container clears
 * every counter. For an internal system with a handful of staff that is an
 * acceptable loss; if this ever needs to survive restarts or run more than
 * one API process, this module is the single place to swap for a Postgres or
 * Redis backed store.
 */

/** Reads a positive integer from the environment, falling back when unset or junk. */
function readPositiveInt(
  variableName: string,
  fallback: number
): number {
  const raw = process.env[variableName];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `${variableName} is not a positive integer ("${raw}"). Using ${fallback}.`
    );

    return fallback;
  }

  return parsed;
}

const MINUTE = 60 * 1000;

/**
 * Failed attempts allowed against one username before it is locked.
 * Five is enough room for ordinary typos and a forgotten caps lock.
 */
const USERNAME_MAX_ATTEMPTS = readPositiveInt(
  "LOGIN_THROTTLE_USERNAME_ATTEMPTS",
  5
);

/** How long a locked username has to wait. */
const USERNAME_LOCK_MS =
  readPositiveInt("LOGIN_THROTTLE_USERNAME_LOCK_MINUTES", 15) * MINUTE;

/**
 * Failed attempts allowed from one IP across all usernames.
 *
 * Kept deliberately loose. Traffic from the remote offices arrives through
 * the Cloudflare tunnel, so several staff can share one apparent address,
 * and a limit that is too tight would lock out a whole branch on a bad
 * morning. This is a backstop against username spraying, not the main
 * defence.
 */
const IP_MAX_ATTEMPTS = readPositiveInt(
  "LOGIN_THROTTLE_IP_ATTEMPTS",
  30
);

/** How long a locked IP has to wait. */
const IP_LOCK_MS =
  readPositiveInt("LOGIN_THROTTLE_IP_LOCK_MINUTES", 15) * MINUTE;

/**
 * A run of failures has to be reasonably recent to count. Someone who
 * mistyped twice this morning starts fresh in the afternoon.
 */
const ATTEMPT_WINDOW_MS =
  readPositiveInt("LOGIN_THROTTLE_WINDOW_MINUTES", 15) * MINUTE;

/**
 * Upper bound on tracked keys, so an attacker cycling through thousands of
 * invented usernames cannot grow this map without limit. When the cap is
 * hit the least recently touched entries are dropped first.
 */
const MAX_TRACKED_KEYS = readPositiveInt(
  "LOGIN_THROTTLE_MAX_KEYS",
  10_000
);

/** Set LOGIN_THROTTLE_DISABLED=true to turn the whole thing off. */
const THROTTLE_DISABLED =
  process.env.LOGIN_THROTTLE_DISABLED === "true";

type AttemptRecord = {
  /** Consecutive failures inside the current window. */
  failures: number;

  /** When the most recent failure was recorded. */
  lastFailureAt: number;

  /** Epoch milliseconds the lock lifts, or null when not locked. */
  lockedUntil: number | null;
};

type Bucket = {
  label: string;
  entries: Map<string, AttemptRecord>;
  maxAttempts: number;
  lockMs: number;
};

const usernameBucket: Bucket = {
  label: "username",
  entries: new Map(),
  maxAttempts: USERNAME_MAX_ATTEMPTS,
  lockMs: USERNAME_LOCK_MS,
};

const ipBucket: Bucket = {
  label: "IP",
  entries: new Map(),
  maxAttempts: IP_MAX_ATTEMPTS,
  lockMs: IP_LOCK_MS,
};

const allBuckets = [usernameBucket, ipBucket];

/**
 * True once a record is safe to forget: not locked, and its failures are
 * older than the window.
 */
function isExpired(record: AttemptRecord, now: number): boolean {
  if (record.lockedUntil !== null && record.lockedUntil > now) {
    return false;
  }

  return now - record.lastFailureAt >= ATTEMPT_WINDOW_MS;
}

/** Drops entries that no longer affect any decision. */
function sweep(now: number = Date.now()): void {
  for (const bucket of allBuckets) {
    for (const [key, record] of bucket.entries) {
      if (isExpired(record, now)) {
        bucket.entries.delete(key);
      }
    }
  }
}

/**
 * Enforces MAX_TRACKED_KEYS. Map iterates in insertion order and every
 * write re-inserts, so the first keys out are the least recently touched.
 * Locked entries are preserved where possible so eviction cannot be used
 * to clear an active lock.
 */
function evictIfOversized(bucket: Bucket, now: number): void {
  if (bucket.entries.size <= MAX_TRACKED_KEYS) {
    return;
  }

  for (const [key, record] of bucket.entries) {
    if (bucket.entries.size <= MAX_TRACKED_KEYS) {
      break;
    }

    const isLocked =
      record.lockedUntil !== null && record.lockedUntil > now;

    if (!isLocked) {
      bucket.entries.delete(key);
    }
  }

  // Everything left is locked and we are still over the cap. Drop from the
  // front anyway rather than growing without bound.
  while (bucket.entries.size > MAX_TRACKED_KEYS) {
    const oldestKey = bucket.entries.keys().next().value;

    if (oldestKey === undefined) {
      break;
    }

    bucket.entries.delete(oldestKey);
  }
}

// Periodic tidy-up so idle entries do not linger for hours. unref() keeps
// this timer from holding the process open during shutdown.
const sweepTimer = setInterval(() => sweep(), 5 * MINUTE);

if (typeof sweepTimer.unref === "function") {
  sweepTimer.unref();
}

export type ThrottleDecision =
  | { allowed: true }
  | {
      allowed: false;

      /** Whole seconds until the lock lifts. Always at least 1. */
      retryAfterSeconds: number;

      /** Ready-to-send message for the login screen. */
      message: string;

      /** "username" or "IP", for logging. Not sent to the client. */
      reason: string;
    };

/** Turns a millisecond remainder into wording staff will understand. */
function describeWait(remainingMs: number): string {
  const totalSeconds = Math.ceil(remainingMs / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(totalSeconds / 60);

  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Normalises a username so casing and stray spaces cannot dodge the counter. */
function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Reports whether this login attempt may proceed. Call before verifying the
 * password so that locked accounts never reach bcrypt, which is the
 * expensive part of a login and the thing an attacker would use to load the
 * server.
 */
export function checkLoginAllowed(
  username: string,
  ip: string | undefined
): ThrottleDecision {
  if (THROTTLE_DISABLED) {
    return { allowed: true };
  }

  const now = Date.now();

  const candidates: Array<[Bucket, string]> = [
    [usernameBucket, usernameKey(username)],
  ];

  if (ip) {
    candidates.push([ipBucket, ip]);
  }

  for (const [bucket, key] of candidates) {
    const record = bucket.entries.get(key);

    if (!record || record.lockedUntil === null) {
      continue;
    }

    if (record.lockedUntil <= now) {
      // The lock has quietly expired. Clear it so the next failure starts a
      // fresh count rather than re-locking immediately.
      bucket.entries.delete(key);
      continue;
    }

    const remainingMs = record.lockedUntil - now;

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
      reason: bucket.label,
      message:
        `Too many failed sign-in attempts. Please wait ` +
        `${describeWait(remainingMs)} and try again.`,
    };
  }

  return { allowed: true };
}

/**
 * Records one failed attempt against both the username and the IP.
 *
 * Call this for every failure, including attempts on usernames that do not
 * exist. Skipping unknown usernames would leave an attacker free to
 * enumerate valid accounts at full speed.
 */
export function recordFailedLogin(
  username: string,
  ip: string | undefined
): void {
  if (THROTTLE_DISABLED) {
    return;
  }

  const now = Date.now();

  const targets: Array<[Bucket, string]> = [
    [usernameBucket, usernameKey(username)],
  ];

  if (ip) {
    targets.push([ipBucket, ip]);
  }

  for (const [bucket, key] of targets) {
    const existing = bucket.entries.get(key);

    // Already locked: leave the record exactly as it is. Extending the lock
    // on each further attempt would let anyone keep a colleague's account
    // shut simply by hammering it, and it would flood the log with a line
    // per attempt. The cooldown is a fixed wait from the moment it started.
    if (
      existing !== undefined &&
      existing.lockedUntil !== null &&
      existing.lockedUntil > now
    ) {
      continue;
    }

    // A run that went quiet for longer than the window starts over.
    const carriesOver =
      existing !== undefined &&
      now - existing.lastFailureAt < ATTEMPT_WINDOW_MS;

    const failures = carriesOver ? existing.failures + 1 : 1;

    const record: AttemptRecord = {
      failures,
      lastFailureAt: now,
      lockedUntil:
        failures >= bucket.maxAttempts ? now + bucket.lockMs : null,
    };

    // Delete first so the re-insert moves this key to the end of the
    // iteration order, which is what makes eviction least-recently-used.
    bucket.entries.delete(key);
    bucket.entries.set(key, record);

    if (record.lockedUntil !== null) {
      console.warn(
        `Login throttle: locked ${bucket.label} "${key}" for ` +
          `${Math.round(bucket.lockMs / MINUTE)} minutes after ` +
          `${failures} failed attempts.`
      );
    }

    evictIfOversized(bucket, now);
  }
}

/**
 * Clears the username's counter after a successful sign-in.
 *
 * The IP counter is deliberately left alone. One correct password should
 * not wipe the evidence of a spray attack coming from the same address.
 */
export function clearFailedLogins(username: string): void {
  usernameBucket.entries.delete(usernameKey(username));
}

/** Test seam: wipes all state. Not used by the running server. */
export function resetLoginThrottleForTesting(): void {
  for (const bucket of allBuckets) {
    bucket.entries.clear();
  }
}

/** Test seam: exposes the tuning actually in effect. */
export const loginThrottleSettings = {
  usernameMaxAttempts: USERNAME_MAX_ATTEMPTS,
  usernameLockMs: USERNAME_LOCK_MS,
  ipMaxAttempts: IP_MAX_ATTEMPTS,
  ipLockMs: IP_LOCK_MS,
  attemptWindowMs: ATTEMPT_WINDOW_MS,
  disabled: THROTTLE_DISABLED,
};
