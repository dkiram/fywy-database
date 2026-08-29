/**
 * Single source of truth for every status pill in the app.
 *
 * Previously StatusBadge was redeclared in four separate files with four
 * different colour maps, which is how `assigned` (primary) and `completed`
 * (tertiary) ended up rendering as literally the same colour.
 *
 * Mapping principle: colour means EXCEPTION, not category.
 *   neutral  routine states — open, pending, cancelled, closed
 *   info     in flight — assigned, match review, imported
 *   warning  needs attention — in progress, overdue, awaiting reconnection
 *   success  terminal good — active, serviced, completed, paid
 *   danger   actually wrong — declined, disconnected, voided, failed
 *
 * A normal ticket queue therefore renders as a calm grey list with a couple
 * of amber rows, instead of the wall of red it used to be (status `open`
 * was mapped to bg-error/10).
 */

export type BadgeTone = "neutral" | "info" | "warning" | "success" | "danger";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "badge badge-neutral",
  info: "badge badge-info",
  warning: "badge badge-warning",
  success: "badge badge-success",
  danger: "badge badge-danger",
};

/** Every status string used across customers, tickets, applications and payments. */
const TONE_BY_STATUS: Record<string, BadgeTone> = {
  // Customers
  active: "success",
  disconnected: "danger",
  pending_reconnection: "warning",
  closed: "neutral",
  archived: "neutral",
  // Service is off for both of these, but neither is a fault: 'offline' is an
  // unresolved outage awaiting a decision, 'suspended' is a paying customer who
  // asked us to stop. Warning, not danger.
  offline: "warning",
  suspended: "warning",
  terminated: "neutral",

  // Service tickets
  open: "neutral",
  assigned: "info",
  in_progress: "warning",
  completed: "success",
  cancelled: "neutral",

  // Applications
  pending: "neutral",
  serviced: "success",
  declined: "danger",
  legacy_unresolved: "warning",
  match_review: "info",

  // Payments
  imported: "neutral",
  new_system: "info",
  voided: "danger",
  paid: "success",
};

export function toneForStatus(status: string): BadgeTone {
  return TONE_BY_STATUS[status] ?? "neutral";
}

export function humanizeStatus(status: string) {
  return status.replace(/_/g, " ");
}

type StatusBadgeProps = {
  status: string;
  /** Override the derived tone for a status this map doesn't cover. */
  tone?: BadgeTone;
  /** Override the derived label. */
  label?: string;
};

function StatusBadge({ status, tone, label }: StatusBadgeProps) {
  return (
    <span className={TONE_CLASS[tone ?? toneForStatus(status)]}>
      {label ?? humanizeStatus(status)}
    </span>
  );
}

/** Standalone pill for things that aren't a status enum (counts, sources, flags). */
export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
}) {
  return <span className={TONE_CLASS[tone]}>{children}</span>;
}

export default StatusBadge;
