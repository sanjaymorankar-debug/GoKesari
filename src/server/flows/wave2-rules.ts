/**
 * Flow spec v3, wave 2 (docs/flows-v3/wave2.md): the rules the order flows read, with the wave-2 values laid over
 * them while the matching feature flag is on. With a flag off each function returns the stored rule exactly as
 * before, so callers that switch to these helpers behave the same.
 *
 *   flow_f19  shopAcceptance (10 min, on, cancel on timeout), dispatch (search stops after 20 min),
 *             dispatchBroadcast (on; the radius widens every 5 min)
 *   flow_f16  cancellation (customer may cancel until packing), afterPackingCancellation (off: a packed order
 *             is cancelled only with the shop's agreement), returns (2-day window, photo only where listed)
 *
 * Values come from rule orderFlowsV3 (admin-editable); the older rules' defaults are never changed.
 */
import type { FeatureFlagKey } from "@/server/db/schema";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

/** A wave-2 flag; never throws (a flag read that fails counts as off). */
export async function flowOn(key: Extract<FeatureFlagKey, `flow_${string}`>): Promise<boolean> {
  try {
    return await isFeatureEnabled(key);
  } catch {
    return false;
  }
}

export function flowsV3Rule() {
  return getRule("orderFlowsV3");
}

export async function shopAcceptanceRule() {
  const rule = await getRule("shopAcceptance");
  if (!(await flowOn("flow_f19"))) return rule;
  const v3 = await flowsV3Rule();
  return { ...rule, enabled: true, acceptMinutes: v3.shopAcceptMinutes, reminderAtFraction: v3.acceptReminderAtFraction, onTimeout: "CANCEL" as const };
}

export async function dispatchRule() {
  const rule = await getRule("dispatch");
  if (!(await flowOn("flow_f19"))) return rule;
  const v3 = await flowsV3Rule();
  return { ...rule, maxSearchMinutes: v3.riderGiveUpMinutes };
}

export async function dispatchBroadcastRule() {
  const rule = await getRule("dispatchBroadcast");
  if (!(await flowOn("flow_f19"))) return rule;
  const v3 = await flowsV3Rule();
  return { ...rule, enabled: true, stepSeconds: Math.min(900, v3.riderWidenAfterMinutes * 60) };
}

export async function cancellationRule() {
  const rule = await getRule("cancellation");
  if (!(await flowOn("flow_f16"))) return rule;
  return { ...rule, customerMayCancelUntil: "PREPARING" as const };
}

export async function afterPackingCancellationRule() {
  const rule = await getRule("afterPackingCancellation");
  if (!(await flowOn("flow_f16"))) return rule;
  // A packed order is cancelled only when the shop agrees (order_cancel_requests), never by the customer alone.
  return { ...rule, enabled: false };
}

export async function returnsRule() {
  const rule = await getRule("returns");
  if (!(await flowOn("flow_f16"))) return rule;
  const v3 = await flowsV3Rule();
  const photo = new Set(v3.returnPhotoReasons);
  const reasons = Object.fromEntries(
    Object.entries(rule.reasons).map(([reason, policy]) => [reason, { ...policy, requiresImages: photo.has(reason) }]),
  ) as typeof rule.reasons;
  return { ...rule, windowHours: v3.returnWindowHours, reasons };
}
