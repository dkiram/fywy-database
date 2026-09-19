/** Parses and formats the time a technician agreed to come back (migration 080). */

/**
 * Turns a datetime-local value into an instant.
 *
 * The input arrives as "2026-09-20T09:00" with no zone: it is the time on the
 * screen of whoever typed it, and every screen this system has is in Jamaica.
 * Jamaica does not observe daylight saving, so pinning -05:00 is exact rather
 * than approximately right, and it keeps this from depending on whatever TZ
 * the container happens to run in.
 *
 * Returns null for anything unparseable, in the past, or absurdly far out - a
 * customer asking for "next Tuesday" is real; a typo landing in 2062 is not.
 *
 * Shared by the technician app and the office, so a time set from either side
 * is checked by the same clock and stored the same way.
 */
export function parseAppointment(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;

  const when = new Date(`${text}:00-05:00`);
  if (Number.isNaN(when.getTime())) return null;

  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;

  if (when.getTime() < now - fiveMinutes) return null;
  if (when.getTime() > now + ninetyDays) return null;

  return when;
}

/** "Sat 20 Sept, 9:00 am" in Jamaica time, for history rows and audit lines. */
export function formatAppointment(when: Date) {
  return new Intl.DateTimeFormat("en-JM", {
    timeZone: "America/Jamaica",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(when);
}

/** The sentence every reschedule refusal uses, so the phone and the office agree. */
export const APPOINTMENT_ERROR =
  "Pick a date and time that is still to come, within the next three months.";
