/**
 * Flow spec v3 F2, customer order (docs/flows-v3/wave2.md; flag flow_f2).
 *
 *   - No referral code is asked before the first order and the admin setting MANDATORY does not block checkout
 *     (customer-signup-referrals.ts, onboarding page). The code is optional after the first order is paid: while the
 *     customer has only their first checkout's orders and gave no code, the order page offers the box and the code
 *     is accepted for that first checkout (the same exemption onboarding v2 uses).
 *   - The checkout payment is chosen explicitly (Online / cash on delivery): /api/checkout refuses a personal order
 *     without a method, and the cart preselects none (assertExplicitPayment, cart page).
 */
import { eq } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import { flowOn } from "./wave2-rules";

export const CHOOSE_PAYMENT_METHOD = "Choose how to pay: online or cash on delivery.";

/** /api/checkout (flag flow_f2): a personal order names its payment method. */
export async function assertExplicitPayment(body: { paymentMethod?: string | null; orderType?: string | null }): Promise<void> {
  if ((body.orderType ?? "PERSONAL") !== "PERSONAL" || body.paymentMethod) return;
  if (!(await flowOn("flow_f2"))) return;
  throw validationFailed(CHOOSE_PAYMENT_METHOD, { fields: { paymentMethod: CHOOSE_PAYMENT_METHOD } });
}

/**
 * The first checkout's order ids when the customer may still give a referral code after paying it (flag flow_f2,
 * codes asked, none given, no order outside the first checkout); else an empty list.
 */
export async function referralAfterFirstOrderIds(userId: string): Promise<string[]> {
  if (!(await flowOn("flow_f2"))) return [];
  const { getSignupReferral, isSignupReferralAsked } = await import("@/server/services/customer-signup-referrals");
  if (!(await isSignupReferralAsked()) || (await getSignupReferral(userId))) return [];
  const mine = await db.select({ id: orders.id }).from(orders).where(eq(orders.userId, userId));
  if (mine.length === 0) return [];
  const { firstCheckoutOrderIds } = await import("@/server/onboarding-v2/customer");
  const first = await firstCheckoutOrderIds(userId, mine.map((o) => o.id));
  return mine.every((o) => first.includes(o.id)) ? first : [];
}
