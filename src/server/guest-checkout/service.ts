/**
 * docs/guest-checkout-2026-11 (owner brief 23-Nov-2026, Module 1): checkout without a sign-up form.
 *
 * Design (keeps the data model safe): a guest order is placed by a lightweight, verified, ordinary
 * customer account — never by a null user id — so every order, refund, cancel and shop-isolation
 * rule is reused untouched.
 *
 *   1. startGuestCheckout   name + mobile + e-mail (+ address) → a sign-in code to the e-mail
 *                           (the existing e-mail sign-in, requested with the mobile so a verified
 *                           code links it), and a code by SMS to the mobile when SMS is set up
 *                           (SMS_PROVIDER + rule otp.smsEnabled: the mock outbox on the test site).
 *   2. completeGuestCheckout the code(s) → verifyLoginOtp finds or creates the account (the same
 *                           path as /signin, Terms consent recorded), marks a new one guest_created,
 *                           saves the name, the proven mobile (phone_verified_at) and the address.
 *   3. The caller then signs the account in with a normal session (Auth.js login ticket), the
 *      browser cart is merged (GuestCartMerge), and the customer picks payment on the normal /cart
 *      checkout, which calls the normal checkout().
 *
 * Real SMS is BLOCKED until a vendor with DLT templates exists (decision D2): without it the mobile
 * is saved unverified, exactly as e-mail sign-in does today.
 */
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { isValidEmail, normalizeEmail, parseIndianMobile } from "@/lib/contact";
import { validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { addresses, users } from "@/server/db/schema";
import {
  guestMobileCodesAvailable,
  requestGuestMobileOtp,
  requestLoginOtp,
  verifyGuestMobileOtp,
  verifyLoginOtp,
} from "@/server/otp/service";
import { createAddress } from "@/server/services/addresses";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { featureNotAvailable } from "@/server/services/feature-flags";
import { isGuestCheckoutOn } from "./tracking";

export const guestContactSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80, "Name: at most 80 characters."),
  mobile: z.string().trim().min(10).max(16),
  email: z.string().trim().max(254),
});

export const guestAddressSchema = z.object({
  line1: z.string().trim().min(1, "Enter the address.").max(200),
  line2: z.string().trim().max(200).nullish(),
  area: z.string().trim().max(120).nullish(),
  city: z.string().trim().min(1, "Enter the city.").max(80),
  state: z.string().trim().max(80).nullish(),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code."),
  landmark: z.string().trim().max(120).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});
export type GuestAddress = z.infer<typeof guestAddressSchema>;

export const guestStartSchema = guestContactSchema.extend({ address: guestAddressSchema });
export const guestCompleteSchema = guestStartSchema.extend({
  emailCode: z.string().trim().min(4).max(12),
  mobileCode: z.string().trim().max(12).nullish(),
  acceptedTerms: z.boolean(),
});

/** Contact details checked the same way sign-in checks them; throws a field-named refusal. */
export function parseGuestContact(input: { name: string; mobile: string; email: string }): { name: string; email: string; e164: string } {
  const name = input.name.trim();
  if (name.length < 2) throw validationFailed("Enter your name.", { fields: { name: "Enter your name." } });
  const mobile = parseIndianMobile(input.mobile);
  if (!mobile.ok) throw validationFailed(mobile.error, { fields: { mobile: mobile.error } });
  if (!isValidEmail(input.email)) {
    const message = "Enter a valid email address, e.g. name@example.com.";
    throw validationFailed(message, { fields: { email: message } });
  }
  return { name, email: normalizeEmail(input.email), e164: mobile.e164 };
}

async function assertOn(): Promise<void> {
  if (!(await isGuestCheckoutOn())) throw featureNotAvailable("guest_checkout_enabled");
}

export interface GuestStartResult {
  maskedEmail: string;
  /** True when a code was also sent by SMS and must be entered. */
  mobileCodeSent: boolean;
  resendAfterSeconds: number;
  expiryMinutes: number;
}

/** Step 1: send the code(s). Nothing is created yet. */
export async function startGuestCheckout(input: z.infer<typeof guestStartSchema>, ip: string | null): Promise<GuestStartResult> {
  await assertOn();
  const contact = parseGuestContact(input);
  guestAddressSchema.parse(input.address);
  const sent = await requestLoginOtp({ email: contact.email, mobile: contact.e164, ip });
  if (sent.status !== "SENT") throw validationFailed("Enter your email address.");
  let mobileCodeSent = false;
  if (await guestMobileCodesAvailable()) {
    await requestGuestMobileOtp({ email: contact.email, mobile: contact.e164, ip });
    mobileCodeSent = true;
  }
  return { maskedEmail: sent.maskedEmail, mobileCodeSent, resendAfterSeconds: sent.resendAfterSeconds, expiryMinutes: sent.expiryMinutes };
}

export interface GuestCompleteResult {
  userId: string;
  isNewUser: boolean;
  addressId: string;
  phoneVerified: boolean;
}

/**
 * Step 2: check the code(s) and find or create the account. The mobile code (when SMS is set up)
 * is checked first, so a wrong mobile code does not use up the e-mail code.
 */
export async function completeGuestCheckout(input: z.infer<typeof guestCompleteSchema>, ip: string | null): Promise<GuestCompleteResult> {
  await assertOn();
  const contact = parseGuestContact(input);
  const address = guestAddressSchema.parse(input.address);

  let phoneVerified = false;
  if (await guestMobileCodesAvailable()) {
    if (!input.mobileCode?.trim()) {
      const message = "Enter the code we sent to your mobile.";
      throw validationFailed(message, { fields: { mobileCode: message } });
    }
    await verifyGuestMobileOtp({ email: contact.email, mobile: contact.e164, code: input.mobileCode, ip });
    phoneVerified = true;
  }

  // The same path as /signin: finds the account by e-mail or creates it (Terms consent recorded),
  // and links the mobile when it is free (MOBILE_IN_USE otherwise — the guest is asked to sign in).
  const { user, isNewUser } = await verifyLoginOtp({
    email: contact.email,
    mobile: contact.e164,
    code: input.emailCode,
    acceptedTerms: input.acceptedTerms === true,
    ip,
  });

  const patch: Partial<typeof users.$inferInsert> = {};
  if (isNewUser) patch.guestCreated = true;
  if (!user.name) patch.name = contact.name;
  if (phoneVerified && user.phoneE164 === contact.e164 && !user.phoneVerifiedAt) patch.phoneVerifiedAt = new Date();
  if (Object.keys(patch).length > 0) {
    await db.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, user.id));
  }

  const addressId = await saveGuestAddress(user.id, contact, address);

  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.GUEST_CHECKOUT_VERIFIED,
    entityType: "user",
    entityId: user.id,
    newValue: { newAccount: isNewUser, phoneVerified, addressId },
    ipAddress: ip,
  });
  return { userId: user.id, isNewUser, addressId, phoneVerified };
}

/** Reuses an identical saved address, else saves a new one (default when it is the first). */
async function saveGuestAddress(userId: string, contact: { name: string; e164: string }, a: GuestAddress): Promise<string> {
  const existing = await db
    .select({ id: addresses.id, line1: addresses.line1, pincode: addresses.pincode })
    .from(addresses)
    .where(and(eq(addresses.userId, userId), isNull(addresses.deletedAt)));
  const same = existing.find((r) => r.line1.trim().toLowerCase() === a.line1.trim().toLowerCase() && r.pincode === a.pincode);
  if (same) return same.id;
  const created = await createAddress(userId, {
    label: "Home",
    recipientName: contact.name,
    recipientPhone: contact.e164.slice(3),
    addressType: "HOME",
    line1: a.line1,
    line2: a.line2 ?? null,
    area: a.area ?? null,
    city: a.city,
    state: a.state ?? null,
    pincode: a.pincode,
    landmark: a.landmark ?? null,
    latitude: a.latitude ?? null,
    longitude: a.longitude ?? null,
    isDefault: existing.length === 0,
  });
  return created.id;
}
