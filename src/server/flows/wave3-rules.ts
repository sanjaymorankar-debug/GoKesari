/**
 * Flow spec v3, wave 3 (docs/flows-v3/wave3.md): the switches of rule shopFlowsV3, each read only while its flag
 * is on (flow_f4 shop onboarding, flow_f5 licence reminders, flow_f6 shop subscription). With a flag off every
 * helper answers false / returns the stored rule unchanged, so callers behave exactly as before.
 */
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export type Wave3Flag = "flow_f4" | "flow_f5" | "flow_f6";

/** A wave-3 flag; never throws (a flag read that fails counts as off). */
export async function wave3FlowOn(key: Wave3Flag): Promise<boolean> {
  try {
    return await isFeatureEnabled(key);
  } catch {
    return false;
  }
}

type Switch = "askContactAtRegistration" | "agreementEmailOnAcceptance" | "registrationLicencesToRegister" | "subscriptionStartsAtGoLive" | "remindersAndRenewalOn";

const FLAG_OF: Record<Switch, Wave3Flag> = {
  askContactAtRegistration: "flow_f4",
  agreementEmailOnAcceptance: "flow_f4",
  registrationLicencesToRegister: "flow_f5",
  subscriptionStartsAtGoLive: "flow_f6",
  remindersAndRenewalOn: "flow_f6",
};

/** True when the switch's flag is on and the switch itself (rule shopFlowsV3) is on. */
export async function wave3Switch(name: Switch): Promise<boolean> {
  if (!(await wave3FlowOn(FLAG_OF[name]))) return false;
  try {
    return (await getRule("shopFlowsV3"))[name];
  } catch {
    return false;
  }
}

/**
 * Rule shopMembership as the reminder job and the renewal checkout read it: with flow_f6 (and
 * shopFlowsV3.remindersAndRenewalOn) the reminders and online renewal are on; otherwise the stored rule as it is.
 */
export async function shopMembershipRuleForFlows() {
  const rule = await getRule("shopMembership");
  if (!(await wave3Switch("remindersAndRenewalOn"))) return rule;
  return { ...rule, remindersEnabled: true, renewalCheckoutEnabled: true };
}
