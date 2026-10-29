/**
 * The owner pays their own shop's one-time registration fee online (owner
 * request, 26 Oct 2026: Add my shop → fee payment).
 *
 * Nothing new about the money: the payment is a payment intent with purpose
 * SHOP_REGISTRATION_FEE for the shop — the same one an operator's fee request
 * makes (operator-limited.ts) — so the capture handler there writes it to the
 * shop's immutable ledger (shop_payments, method ONLINE), the shop's fee status
 * follows, and the auto-approval rule runs. This file only lets the owner start
 * that checkout and check on it when the gateway sends them back.
 *
 * A fee is charged once: a live checkout for the same amount is reused (a second
 * press opens the same payment), a paid fee refuses a new one, and the capture
 * handler is idempotent per gateway payment.
 */
import { eq } from "drizzle-orm";

import { conflict, notFound } from "@/lib/errors";
import { db } from "@/server/db";
import { shops, type Shop } from "@/server/db/schema";
import {
  createPaymentIntent,
  getPaymentIntentRow,
  isLive,
  listIntentsFor,
  redirectUrlOf,
} from "@/server/payments/intents";
import { reconcileIntent } from "@/server/payments/processing";
import { assertDocumentsAllowPayment } from "./shop-document-gate";

interface Owner {
  id: string;
  name: string | null;
  email: string;
}

/** What is still owed on a shop's registration fee, in paise (0 when settled or waived). */
export function registrationFeeDue(shop: Pick<Shop, "registrationFeePaise" | "amountPaidPaise" | "feePaymentStatus">): number {
  if (shop.feePaymentStatus === "PAID" || shop.feePaymentStatus === "CANCELLED" || shop.feePaymentStatus === "REFUNDED") return 0;
  return Math.max(0, (shop.registrationFeePaise ?? 0) - shop.amountPaidPaise);
}

/** The caller's own shop, or 404 — another owner's shop is not even confirmed to exist. */
export async function ownShopForFee(shopId: string, ownerId: string): Promise<Shop> {
  const [shop] = await db.select().from(shops).where(eq(shops.id, shopId));
  if (!shop || shop.ownerId !== ownerId || shop.deletedAt) throw notFound("Shop");
  return shop;
}

/**
 * Starts (or reopens) the checkout for what is still due. Returns where to send
 * the browser: the gateway's hosted page, or our page that opens its SDK.
 */
export async function startRegistrationFeeCheckout(
  shopId: string,
  owner: Owner,
): Promise<{ intentId: string; amountPaise: number; redirectUrl: string }> {
  const shop = await ownShopForFee(shopId, owner.id);
  const due = registrationFeeDue(shop);
  if (due === 0) throw conflict("Nothing is due: the registration fee is already settled.");
  // Owner decision 29 Oct 2026: documents verified (or the 30-day promise) before the fee.
  await assertDocumentsAllowPayment(shop);

  const previous = await listIntentsFor("SHOP_REGISTRATION_FEE", shop.id);
  // A checkout still open for this owner and amount is reused — pressing Pay
  // twice, or coming back to the page, never starts a second charge.
  const open = previous.find((row) => isLive(row) && row.userId === owner.id && row.amountPaise === due && row.mode === "CHECKOUT");
  const openUrl = open ? redirectUrlOf(open) : null;
  if (open && openUrl) return { intentId: open.id, amountPaise: due, redirectUrl: openUrl };

  const created = await createPaymentIntent({
    purpose: "SHOP_REGISTRATION_FEE",
    referenceId: shop.id,
    userId: owner.id,
    amountPaise: due,
    customer: { id: owner.id, name: owner.name ?? shop.ownerName, email: owner.email || shop.email, phone: shop.phone },
    description: `GoKesari registration fee — ${shop.name}`,
    // Same attempt → same intent (two presses at once charge once); after a
    // failed or expired attempt the count has moved on, so a retry is new.
    idempotencyKey: `shop-registration-fee:owner:${shop.id}:${previous.length}`,
    mode: "CHECKOUT",
    returnPath: `/shop/registration-fee?shop=${shop.id}`,
  });
  const checkout = created.checkout;
  const redirectUrl = checkout ? (checkout.kind === "HOSTED_URL" ? checkout.url : (checkout.url ?? null)) : null;
  if (!redirectUrl) throw conflict("Online payment is not available right now. Please try again in a few minutes.");
  return { intentId: created.intent.id, amountPaise: due, redirectUrl };
}

/**
 * Back from the gateway with `?intent=`: asks the gateway how that payment went
 * (the webhook usually got there first) and returns the shop as it is now. Only
 * the owner's own intent for this shop is looked at; anything else is ignored.
 */
export async function checkRegistrationFeePayment(shopId: string, intentId: string | null, ownerId: string): Promise<Shop> {
  const shop = await ownShopForFee(shopId, ownerId);
  if (!intentId || !/^[0-9a-f-]{36}$/i.test(intentId)) return shop;
  const intent = await getPaymentIntentRow(intentId);
  if (!intent || intent.purpose !== "SHOP_REGISTRATION_FEE" || intent.referenceId !== shop.id || intent.userId !== ownerId) return shop;
  if (isLive(intent)) {
    try {
      await reconcileIntent(intent.id);
    } catch (error) {
      // The webhook and the reconciliation job settle it anyway; the page says "checking".
      console.error("[registration-fee] could not check the payment with the gateway", intent.id, error);
    }
  }
  return ownShopForFee(shopId, ownerId);
}

/** The latest attempt's state, for the page: "PAID", "FAILED", "EXPIRED", "PENDING" … or null. */
export async function latestRegistrationFeeAttempt(shopId: string, ownerId: string) {
  const [latest] = (await listIntentsFor("SHOP_REGISTRATION_FEE", shopId)).filter((row) => row.userId === ownerId);
  return latest ? { id: latest.id, status: latest.status, amountPaise: latest.amountPaise, live: isLive(latest) } : null;
}
