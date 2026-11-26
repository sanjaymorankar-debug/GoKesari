/**
 * Flow spec v3, wave 4 (docs/flows-v3/wave4.md): the flags and the rule the franchise, team and commission flows read.
 * Every caller checks its flag first; with a flag off nothing here is used and the flow behaves exactly as before.
 *
 *   flow_f7   paid franchise needs a live shop; v2 franchisees renew without PAN, for the plan's term
 *   flow_f8   downgrading a team lead moves his agents
 *   flow_f9   recurring commission: own shops anywhere, the zone's first franchise keeps the others
 *   flow_f10  the tail ends at most tailCapYears after the first start
 *   flow_f12  customer and shop referral codes made whenever the account's codes are listed
 *   flow_f21  one hold per dealer, released at hold + holdGraceMinutes, a lost slot refunded automatically
 *   flow_f22  commission payable commissionHoldDays after it is earned; GST + invoice for GST-registered dealers
 *
 * Values come from rule franchiseFlowsV3 (admin-editable); existing rules and franchise settings are never changed.
 */
import { allocationExpiry } from "@/lib/franchise";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export type Wave4Flag = "flow_f7" | "flow_f8" | "flow_f9" | "flow_f10" | "flow_f12" | "flow_f21" | "flow_f22";

/** A wave-4 flag; never throws (a flag read that fails counts as off). */
export async function flow4On(key: Wave4Flag): Promise<boolean> {
  try {
    return await isFeatureEnabled(key);
  } catch {
    return false;
  }
}

export function wave4Rule() {
  return getRule("franchiseFlowsV3");
}

/**
 * F10 (owner 27-Nov-2026): a paid franchise earns for 12 months + a 2-year tail — commission stops `capYears` after
 * its FIRST start, renewals included. The tail never ends before the paid term does (a franchise still paid up keeps
 * earning); it is never longer than the uncapped tail.
 */
export function cappedTailEnd(input: { firstStartAt: Date; expiresAt: Date; tailEnd: Date; capYears: number }): Date {
  const cap = allocationExpiry(input.firstStartAt, input.capYears * 12);
  const capped = input.tailEnd.getTime() < cap.getTime() ? input.tailEnd : cap;
  return capped.getTime() < input.expiresAt.getTime() ? input.expiresAt : capped;
}

/** F21: when a held slot is really released — the hold's end plus the grace. */
export function holdReleaseAt(holdExpiresAt: Date, graceMinutes: number): Date {
  return new Date(holdExpiresAt.getTime() + graceMinutes * 60_000);
}

/** F22: entries earned before this instant are payable now (earned at least `holdDays` days ago). */
export function commissionPayableBefore(now: Date, holdDays: number): Date {
  return new Date(now.getTime() - holdDays * 86_400_000);
}
