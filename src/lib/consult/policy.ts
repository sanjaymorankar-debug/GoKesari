/**
 * Consultant appointments: cancellation, reschedule and refund rules, and the
 * money a firm is owed. Pure — the booking service calls these with the
 * policy copied onto the booking when it was made.
 */

export interface PolicyShape {
  freeCancelHours: number;
  lateCancelRefundPct: number;
  noShowRefundPct: number;
  rescheduleMinHours: number;
  maxReschedules: number;
}

export const DEFAULT_POLICY: PolicyShape = {
  freeCancelHours: 24,
  lateCancelRefundPct: 50,
  noShowRefundPct: 0,
  rescheduleMinHours: 4,
  maxReschedules: 2,
};

export type CancelSide = "CUSTOMER" | "CONSULTANT" | "ADMIN" | "SYSTEM";

export interface RefundDecision {
  refundPaise: number;
  pct: number;
  reason: string;
}

const HOUR = 3_600_000;

/**
 * What goes back to the customer when a booking is cancelled. The consultant,
 * staff or the system cancelling → everything paid online. The customer →
 * everything up to `freeCancelHours` before the start, then
 * `lateCancelRefundPct` (rounded down to the paisa).
 */
export function cancellationRefund(policy: PolicyShape, input: { paidOnlinePaise: number; refundedPaise?: number; startsAt: Date; now: Date; by: CancelSide }): RefundDecision {
  const refundable = Math.max(0, input.paidOnlinePaise - (input.refundedPaise ?? 0));
  if (refundable === 0) return { refundPaise: 0, pct: 0, reason: "Nothing was paid online." };
  if (input.by !== "CUSTOMER") return { refundPaise: refundable, pct: 100, reason: "Cancelled by the consultant or GoKesari: full refund." };
  const hoursBefore = (input.startsAt.getTime() - input.now.getTime()) / HOUR;
  if (hoursBefore >= policy.freeCancelHours) return { refundPaise: refundable, pct: 100, reason: `Cancelled at least ${policy.freeCancelHours} hours before: full refund.` };
  const pct = clampPct(policy.lateCancelRefundPct);
  return {
    refundPaise: Math.floor((refundable * pct) / 100),
    pct,
    reason: `Cancelled less than ${policy.freeCancelHours} hours before: ${pct}% refund under the consultant's policy.`,
  };
}

/** What goes back when the customer did not come. */
export function noShowRefund(policy: PolicyShape, paidOnlinePaise: number, refundedPaise = 0): RefundDecision {
  const refundable = Math.max(0, paidOnlinePaise - refundedPaise);
  const pct = clampPct(policy.noShowRefundPct);
  return { refundPaise: Math.floor((refundable * pct) / 100), pct, reason: `No-show: ${pct}% refund under the consultant's policy.` };
}

export interface RescheduleCheck {
  ok: boolean;
  reason?: string;
}

/** May the customer move this booking? (The consultant may always move it, with notice to the customer.) */
export function customerMayReschedule(policy: PolicyShape, input: { startsAt: Date; now: Date; rescheduleCount: number }): RescheduleCheck {
  if (input.rescheduleCount >= policy.maxReschedules) {
    return { ok: false, reason: policy.maxReschedules === 0 ? "This consultant does not allow changing the time." : `This booking was already moved ${input.rescheduleCount} time(s), the most the consultant allows.` };
  }
  const hoursBefore = (input.startsAt.getTime() - input.now.getTime()) / HOUR;
  if (hoursBefore < policy.rescheduleMinHours) return { ok: false, reason: `The time can be changed only up to ${policy.rescheduleMinHours} hours before the appointment.` };
  return { ok: true };
}

/** May the customer still cancel (any time before the start)? */
export function customerMayCancel(input: { startsAt: Date; now: Date }): RescheduleCheck {
  return input.now.getTime() < input.startsAt.getTime() ? { ok: true } : { ok: false, reason: "The appointment time has passed. Raise a dispute if something went wrong." };
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Plain-words summary of a policy, shown before booking. */
export function policySummary(p: PolicyShape): string[] {
  const lines = [
    p.freeCancelHours > 0 ? `Free cancellation up to ${p.freeCancelHours} hours before the appointment.` : "Free cancellation any time before the appointment.",
  ];
  if (p.freeCancelHours > 0) lines.push(p.lateCancelRefundPct > 0 ? `After that, ${p.lateCancelRefundPct}% of the online payment is refunded.` : "After that, the online payment is not refunded.");
  lines.push(p.noShowRefundPct > 0 ? `If you do not come, ${p.noShowRefundPct}% is refunded.` : "If you do not come, the online payment is not refunded.");
  lines.push(p.maxReschedules > 0 ? `You can change the time up to ${p.maxReschedules} time(s), until ${p.rescheduleMinHours} hours before.` : "The time cannot be changed once booked.");
  lines.push("If the consultant cancels, you get a full refund.");
  return lines;
}

/** GoKesari's commission on a booking's fee (basis points, rounded to the paisa). */
export function commissionOnFee(feeValuePaise: number, rateBp: number): number {
  return Math.round((Math.max(0, feeValuePaise) * Math.max(0, rateBp)) / 10_000);
}

export interface GstSplit {
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  totalPaise: number;
}

/** A GST-inclusive fee split into taxable value and CGST + SGST (intra-state supply of a local service). */
export function gstInclusiveSplit(totalPaise: number, rateBp: number): GstSplit {
  if (rateBp <= 0 || totalPaise <= 0) return { taxablePaise: totalPaise, cgstPaise: 0, sgstPaise: 0, totalPaise };
  const taxable = Math.round((totalPaise * 10_000) / (10_000 + rateBp));
  const tax = totalPaise - taxable;
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst, totalPaise };
}

/** What the firm is owed for a booking that ended, and what GoKesari keeps. */
export interface SettlementShape {
  /** Online money kept (paid online minus refunded) — paid to the firm in its next payout. */
  onlineKeptPaise: number;
  /** The fee value commission is charged on: online kept + collected at the visit. */
  commissionBasePaise: number;
  commissionPaise: number;
}

export function settlementFor(input: { paidOnlinePaise: number; refundPaise: number; paidOfflinePaise: number; commissionBp: number }): SettlementShape {
  const onlineKept = Math.max(0, input.paidOnlinePaise - input.refundPaise);
  const base = onlineKept + Math.max(0, input.paidOfflinePaise);
  return { onlineKeptPaise: onlineKept, commissionBasePaise: base, commissionPaise: commissionOnFee(base, input.commissionBp) };
}
