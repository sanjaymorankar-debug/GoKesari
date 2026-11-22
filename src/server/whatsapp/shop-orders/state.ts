/**
 * Is the WhatsApp shop-order feature live? (docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md). Two switches, both needed:
 *
 *   flag whatsapp_shop_orders_enabled   (admin → Feature flags; per district)
 *   WHATSAPP_PROVIDER=meta + META_WA_* keys (server environment)
 *
 * With the flag on and the keys missing, the feature stays dormant: nothing
 * is queued or sent, the reason is logged once per process and shown on the
 * admin log page. The rest of the app is unaffected either way.
 */
import { metaWhatsAppProblem } from "@/server/notifications/providers/whatsapp-meta";
import { isFeatureEnabled, isFeatureEnabledForShop } from "@/server/services/feature-flags";

export const WHATSAPP_FLAG = "whatsapp_shop_orders_enabled" as const;

export interface WhatsAppFeatureState {
  /** Flag on (somewhere) and the provider can send. */
  live: boolean;
  flagOn: boolean;
  /** Why the provider cannot send (missing keys, test recipient on production …), or null. */
  providerProblem: string | null;
}

let loggedProblem: string | null = null;

function logDormant(problem: string): void {
  if (loggedProblem === problem) return;
  loggedProblem = problem;
  console.warn(`[whatsapp-shop-orders] flag ${WHATSAPP_FLAG} is on but WhatsApp stays dormant: ${problem}`);
}

export async function whatsAppFeatureState(): Promise<WhatsAppFeatureState> {
  const flagOn = await isFeatureEnabled(WHATSAPP_FLAG);
  const providerProblem = metaWhatsAppProblem();
  if (flagOn && providerProblem) logDormant(providerProblem);
  return { live: flagOn && !providerProblem, flagOn, providerProblem };
}

/** Live for this shop: the flag covers its district and the provider can send. */
export async function whatsAppLiveForShop(shop: string | { pincode: string | null }): Promise<boolean> {
  if (!(await isFeatureEnabledForShop(WHATSAPP_FLAG, shop))) return false;
  const problem = metaWhatsAppProblem();
  if (problem) {
    logDormant(problem);
    return false;
  }
  return true;
}
