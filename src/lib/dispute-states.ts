/**
 * Dispute case vocabulary (GS-058) — shared by the server (state machine) and
 * the browser (labels, which buttons to show). No database or server imports,
 * the same contract as return-states.ts.
 *
 *   Open → Triage → Investigate → Propose a resolution → Resolve
 *                                      ↑
 *                            Escalate (from any live state)
 *
 * A dispute is the case *about* a complaint, not the complaint itself.
 * `grievances` stays what it is — the statutory redressal record a Grievance
 * Officer points to — and a dispute may reference the grievance that started
 * it without inheriting its purpose.
 */

export const DISPUTE_STATUSES = [
  "OPEN",
  "TRIAGED",
  "INVESTIGATING",
  "RESOLUTION_PROPOSED",
  "ESCALATED",
  "RESOLVED",
  "REJECTED",
  "WITHDRAWN",
] as const;

export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, string> = {
  OPEN: "Open",
  TRIAGED: "Triaged",
  INVESTIGATING: "Investigating",
  RESOLUTION_PROPOSED: "Resolution proposed",
  ESCALATED: "Escalated",
  RESOLVED: "Resolved",
  REJECTED: "Rejected",
  WITHDRAWN: "Withdrawn",
};

/**
 * Legal moves. Anything not listed is refused by the service.
 *
 * ESCALATED is reachable from every live state and is not a dead end: a
 * second-line reviewer carries on from there, so it leads back into
 * investigation as well as forward to an outcome. A case that could only be
 * escalated *out* of the workflow would strand it.
 */
export const DISPUTE_TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  OPEN: ["TRIAGED", "ESCALATED", "REJECTED", "WITHDRAWN"],
  TRIAGED: ["INVESTIGATING", "RESOLUTION_PROPOSED", "ESCALATED", "REJECTED", "WITHDRAWN"],
  INVESTIGATING: ["RESOLUTION_PROPOSED", "ESCALATED", "REJECTED", "WITHDRAWN"],
  // Back to INVESTIGATING when the customer rejects what was proposed.
  RESOLUTION_PROPOSED: ["RESOLVED", "INVESTIGATING", "ESCALATED", "REJECTED", "WITHDRAWN"],
  ESCALATED: ["INVESTIGATING", "RESOLUTION_PROPOSED", "RESOLVED", "REJECTED", "WITHDRAWN"],
  RESOLVED: [],
  REJECTED: [],
  WITHDRAWN: [],
};

export const DISPUTE_TERMINAL: readonly DisputeStatus[] = ["RESOLVED", "REJECTED", "WITHDRAWN"];

export function isDisputeTerminal(status: DisputeStatus): boolean {
  return DISPUTE_TERMINAL.includes(status);
}

export function canMoveDispute(from: DisputeStatus, to: DisputeStatus): boolean {
  return DISPUTE_TRANSITIONS[from].includes(to);
}

/** Who owns the case now. L1 is operations; L2 is an administrator. */
export const DISPUTE_LEVELS = ["L1", "L2"] as const;
export type DisputeLevel = (typeof DISPUTE_LEVELS)[number];

export const DISPUTE_LEVEL_LABELS: Record<DisputeLevel, string> = {
  L1: "Operations",
  L2: "Administrator",
};

/** Why a case sits at L2. Recorded so an automatic escalation is distinguishable from a judgement. */
export const ESCALATION_TRIGGERS = ["MANUAL", "AGE", "AMOUNT"] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

export const ESCALATION_TRIGGER_LABELS: Record<EscalationTrigger, string> = {
  MANUAL: "Escalated by a reviewer",
  AGE: "Escalated automatically — open too long",
  AMOUNT: "Escalated automatically — amount above the review limit",
};

export const DISPUTE_REASONS = [
  "ITEM_NOT_RECEIVED",
  "ITEM_DAMAGED",
  "WRONG_ITEM",
  "SHORT_QUANTITY",
  "QUALITY_ISSUE",
  "OVERCHARGED",
  "NOT_AS_DESCRIBED",
  "OTHER",
] as const;

export type DisputeReason = (typeof DISPUTE_REASONS)[number];

export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  ITEM_NOT_RECEIVED: "Item not received",
  ITEM_DAMAGED: "Item damaged",
  WRONG_ITEM: "Wrong item",
  SHORT_QUANTITY: "Short quantity",
  QUALITY_ISSUE: "Quality issue",
  OVERCHARGED: "Overcharged",
  NOT_AS_DESCRIBED: "Not as described",
  OTHER: "Other",
};

/**
 * What resolving the case decided. The money itself always moves through the
 * finance refund, never from here — this records which way the decision went.
 */
export const DISPUTE_OUTCOMES = ["REFUND_FULL", "REFUND_PARTIAL", "NO_REFUND", "REPLACEMENT_AGREED"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];

export const DISPUTE_OUTCOME_LABELS: Record<DisputeOutcome, string> = {
  REFUND_FULL: "Refunded in full",
  REFUND_PARTIAL: "Partially refunded",
  NO_REFUND: "No refund",
  REPLACEMENT_AGREED: "Replacement agreed",
};

/** Outcomes that must come with money. Checked by the service, not by the caller. */
export function outcomeRequiresRefund(outcome: DisputeOutcome): boolean {
  return outcome === "REFUND_FULL" || outcome === "REFUND_PARTIAL";
}
