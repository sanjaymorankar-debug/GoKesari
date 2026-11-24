"use server";

/**
 * docs/guest-checkout-2026-11: guest checkout, step 2 — checks the code(s), finds or creates the
 * customer account (completeGuestCheckout), then opens a normal session the way /signin does (a
 * short-lived login ticket handed to Auth.js, never to the browser) and returns to /cart, where the
 * browser cart is merged and the customer picks payment on the usual checkout.
 */
import { headers } from "next/headers";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { toClientError } from "@/lib/errors";
import { OTP_TICKET_PROVIDER_ID, signIn } from "@/server/auth";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { completeGuestCheckout, guestCompleteSchema } from "@/server/guest-checkout/service";
import { createLoginTicket } from "@/server/otp/service";

/** Where a verified guest lands: the cart, with the checkout below it (address already saved). */
const AFTER_VERIFY = "/cart?guest=1";

export async function verifyGuestCheckoutAction(raw: unknown): Promise<{ error: string; fields?: Record<string, string> } | undefined> {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  let ticket: string;
  try {
    enforceRateLimit(`guest-checkout-verify:${ip ?? "unknown"}`, { limit: 20, windowMs: 600_000 });
    const parsed = guestCompleteSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.filter((p) => typeof p === "string").join(".") || "form";
      return { error: issue?.message ?? "Check the details and try again.", fields: { [field]: issue?.message ?? "" } };
    }
    const { userId } = await completeGuestCheckout(parsed.data, ip);
    ticket = createLoginTicket(userId);
  } catch (error) {
    const body = toClientError(error).body.error as { message: string; details?: { fields?: Record<string, string> } };
    return { error: body.message, ...(body.details?.fields ? { fields: body.details.fields } : {}) };
  }
  try {
    await signIn(OTP_TICKET_PROVIDER_ID, { ticket, redirectTo: AFTER_VERIFY });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof AuthError) return { error: "Your details are checked, but we could not sign you in. Please try again." };
    throw error;
  }
}
