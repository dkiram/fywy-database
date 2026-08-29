/**
 * Serializes CLI access per OLT and briefly caches read-only port scans.
 *
 * The MA5680T / MA5608T units are ~2014 hardware whose management plane
 * serializes SSH internally and degrades badly under any concurrency: a
 * second session while one is active routinely means connection resets,
 * multi-minute stalls, and unconfirmable saves. Every path that opens a CLI
 * session - staff Verify, Sync, account actions, and both automation loops -
 * runs through withOltLock, so at most one session per management IP is ever
 * in flight for this process.
 *
 * The read helpers additionally share a short-lived cache of the last
 * `display ont info <port> all` scan. Repeated lookups for different ONTs on
 * the same PON port (a bulk sweep, a busy support afternoon, a profile
 * reload) then reuse one read instead of reconnecting per customer.
 */
import type { OntLogResult } from "./parseOntLog.js";

// ---------------------------------------------------------------------------
// Per-OLT serialization
// ---------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>();
const queueDepth = new Map<string, number>();

// A stampede (every staff member plus a bulk script hitting one OLT) must not
// build an unbounded backlog. Past this many waiters, reject fast instead.
const MAX_QUEUE_DEPTH = 25;

/** Thrown when an OLT already has too many operations waiting. */
export class OltBusyError extends Error {
  constructor(public readonly managementIp: string) {
    super(
      `The OLT at ${managementIp} has too many operations queued right now. ` +
        "Try again in a few minutes."
    );
    this.name = "OltBusyError";
  }
}

/**
 * Run `task` once every earlier task for the same OLT has settled. The chain
 * tail never rejects, so one failed task does not poison the queue. The
 * `chains` map holds one settled promise per OLT (a handful of entries) and is
 * never cleared; `queueDepth` tracks only the live backlog.
 */
export function withOltLock<T>(
  managementIp: string,
  task: () => Promise<T>
): Promise<T> {
  const depth = queueDepth.get(managementIp) ?? 0;
  if (depth >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new OltBusyError(managementIp));
  }
  queueDepth.set(managementIp, depth + 1);

  const previous = chains.get(managementIp) ?? Promise.resolve();
  const result = previous.then(task, task);

  chains.set(
    managementIp,
    result.then(
      () => undefined,
      () => undefined
    )
  );

  return result.finally(() => {
    const remaining = (queueDepth.get(managementIp) ?? 1) - 1;
    if (remaining <= 0) queueDepth.delete(managementIp);
    else queueDepth.set(managementIp, remaining);
  });
}

// ---------------------------------------------------------------------------
// Short-lived port-scan cache
// ---------------------------------------------------------------------------

/** Default freshness window for an opt-in cached read. */
export const OLT_PORT_SCAN_TTL_MS = 10 * 60_000;

type PortKey = {
  managementIp: string;
  frameNumber: number;
  slotNumber: number;
  ponPortNumber: number;
};

const portScans = new Map<string, { at: number; result: OntLogResult }>();

function keyFor(target: PortKey): string {
  return (
    `${target.managementIp}|` +
    `${target.frameNumber}/${target.slotNumber}/${target.ponPortNumber}`
  );
}

/** A cached scan no older than `maxAgeMs`, or null. */
export function getCachedPortScan(
  target: PortKey,
  maxAgeMs: number
): OntLogResult | null {
  if (maxAgeMs <= 0) return null;
  const hit = portScans.get(keyFor(target));
  if (!hit) return null;
  if (Date.now() - hit.at > maxAgeMs) {
    portScans.delete(keyFor(target));
    return null;
  }
  return hit.result;
}

// A live network has a few hundred PON ports at most; this only guards against
// unbounded growth over a long uptime as ports and OLT IPs change.
const MAX_CACHED_PORTS = 600;

export function setCachedPortScan(target: PortKey, result: OntLogResult): void {
  const key = keyFor(target);
  portScans.delete(key);
  portScans.set(key, { at: Date.now(), result });
  if (portScans.size > MAX_CACHED_PORTS) {
    const oldest = portScans.keys().next().value;
    if (oldest !== undefined) portScans.delete(oldest);
  }
}

/** Forget one PON port's scan - call after any write that changed it. */
export function invalidatePortScan(target: PortKey): void {
  portScans.delete(keyFor(target));
}

/** Forget every cached scan for one OLT. */
export function invalidateOltScans(managementIp: string): void {
  const prefix = `${managementIp}|`;
  for (const key of portScans.keys()) {
    if (key.startsWith(prefix)) portScans.delete(key);
  }
}
