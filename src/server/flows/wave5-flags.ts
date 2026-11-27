/**
 * Flow spec v3, wave 5 (docs/flows-v3/wave5.md; migration 0224): the three switches. A failed read counts as off,
 * so a flag problem never changes today's behaviour.
 *   flow_f11  delivery partner: photo, verified mobile and e-mail on the application
 *   flow_f15  society onboarding: authorised person, proof, gate hours, rider suspension, approved riders only
 *   flow_f18  account recovery and closure
 */
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const flowF11On = (): Promise<boolean> => isFeatureEnabled("flow_f11").catch(() => false);
export const flowF15On = (): Promise<boolean> => isFeatureEnabled("flow_f15").catch(() => false);
export const flowF18On = (): Promise<boolean> => isFeatureEnabled("flow_f18").catch(() => false);
