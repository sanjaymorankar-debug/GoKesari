/**
 * Dealer-assisted shop registration (docs/dealer-programme, GKS-SH-002).
 *
 * 1. The dealer (or their employee, picked here) enters the owner's name,
 *    mobile and email. A one-time code goes to the OWNER — by SMS to their own
 *    mobile, or by email where SMS is not set up on the site. Without the code
 *    nothing is registered.
 * 2. The dealer enters the code the owner tells them. The owner's account is
 *    the one for that email (made if new), exactly as for operator onboarding.
 * 3. Within assistedConsentMinutes the dealer enters the shop's details, the
 *    owner having accepted the terms. The shop is registered under the owner,
 *    with the same checks, documents, duplicate rules and fee as a shop the
 *    owner registers — the dealer's code (or the employee's) is attached
 *    automatically. The registration fee is the owner's to pay, from their own
 *    account (My shop); the owner is told so. Approval is unchanged: dealer
 *    assistance bypasses nothing.
 */
import { and, eq } from "drizzle-orm";

import { isValidEmail, maskEmailAddress, normalizeEmail } from "@/lib/contact";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { dealerAssistedSessions, dealerSalespeople, shops, users, type Dealer, type DealerAssistedSession, type Shop, type UserRole } from "@/server/db/schema";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { requestShopOnboardingConsentOtp, verifyShopOnboardingConsentOtp } from "@/server/otp/service";
import { sendRegistrationOtp, verifyRegistrationOtp } from "@/server/registration/otp";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { notify } from "@/server/services/notifications";
import { ownerAccountFor } from "@/server/services/operator-limited";
import { attributeShopToCode } from "@/server/services/referrals";
import { getRule } from "@/server/services/settings";
import { registerShop, type RegisterShopInput } from "@/server/services/shops";
import { isTextChannelAvailable } from "@/server/messaging/sms-whatsapp";
import { recordShopAttributionSafely } from "./attribution";
import { activeCodeFor } from "./codes";

interface Actor {
  id: string;
  role: UserRole;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const smsText = (dealerName: string) => (code: string, minutes: number) =>
  `${code} is your code to let ${dealerName}, a GoKesari dealer, register your shop. Share it only if you agree. Expires in ${minutes} min.`;

const emailText = (dealerName: string) => (code: string, expiryMinutes: number) => ({
  subject: `${code} — your code to let ${dealerName} register your shop on GoKesari`,
  text:
    `${dealerName}, an authorised GoKesari dealer, is registering your shop on GoKesari for you.\n\n` +
    `If you agree, tell them this code: ${code}\n\nIt works once and expires in ${expiryMinutes} minutes. ` +
    `If you did not ask for this, do not share the code — nothing will be registered without it.\n`,
  html:
    `<p><strong>${escapeHtml(dealerName)}</strong>, an authorised GoKesari dealer, is registering your shop on GoKesari for you.</p>` +
    `<p>If you agree, tell them this code:</p><p style="font-size:28px;letter-spacing:6px;font-weight:600">${escapeHtml(code)}</p>` +
    `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. If you did not ask for this, do not share the code — nothing will be registered without it.</p>`,
});

export interface AssistedSessionView {
  id: string;
  status: DealerAssistedSession["status"];
  channel: "SMS" | "EMAIL";
  sentTo: string;
  ownerName: string;
  consentExpiresAt: Date | null;
  shopId: string | null;
}

const toView = (s: DealerAssistedSession): AssistedSessionView => ({
  id: s.id,
  status: s.status,
  channel: s.otpChannel,
  sentTo: s.otpChannel === "SMS" ? `+91••••••${s.ownerMobileE164.slice(-4)}` : maskEmailAddress(s.ownerEmail),
  ownerName: s.ownerName,
  consentExpiresAt: s.consentExpiresAt,
  shopId: s.shopId,
});

async function ownSession(dealer: Dealer, sessionId: string): Promise<DealerAssistedSession> {
  const [s] = await db.select().from(dealerAssistedSessions).where(and(eq(dealerAssistedSessions.id, sessionId), eq(dealerAssistedSessions.dealerId, dealer.id)));
  if (!s) throw notFound("Registration");
  return s;
}

/** Step 1: the owner's details; the code goes to the owner. */
export async function startAssistedRegistration(
  dealer: Dealer,
  input: { ownerName: string; ownerMobile: string; ownerEmail: string; salespersonId?: string | null },
  actor: Actor,
  ip: string | null,
): Promise<AssistedSessionView> {
  if (dealer.status !== "APPROVED") throw forbidden("Your dealer account is not active.");
  const ownerName = input.ownerName.trim().replace(/\s+/g, " ").slice(0, 120);
  if (ownerName.length < 2) throw validationFailed("Enter the owner's name.", { fields: { ownerName: "Required." } });
  const digits = input.ownerMobile.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (!/^[6-9][0-9]{9}$/.test(digits)) throw validationFailed("Enter the owner's 10-digit mobile number.", { fields: { ownerMobile: "10 digits." } });
  const email = normalizeEmail(input.ownerEmail);
  if (!isValidEmail(email)) throw validationFailed("Enter the owner's email address (they sign in with it to pay the fee).", { fields: { ownerEmail: "Invalid email." } });
  if (input.salespersonId) {
    const [person] = await db
      .select({ status: dealerSalespeople.status })
      .from(dealerSalespeople)
      .where(and(eq(dealerSalespeople.id, input.salespersonId), eq(dealerSalespeople.dealerId, dealer.id)));
    if (!person) throw notFound("Employee");
    if (person.status !== "ACTIVE") throw conflict("That employee is not active.");
  }
  const mobile = `+91${digits}`;
  const channel: "SMS" | "EMAIL" = isTextChannelAvailable("SMS") ? "SMS" : "EMAIL";
  if (channel === "SMS") await sendRegistrationOtp(mobile, ip, smsText(dealer.legalName));
  else await requestShopOnboardingConsentOtp({ email, operatorId: actor.id, ip, render: emailText(dealer.legalName) });
  const [session] = await db
    .insert(dealerAssistedSessions)
    .values({ dealerId: dealer.id, salespersonId: input.salespersonId ?? null, ownerName, ownerMobileE164: mobile, ownerEmail: email, otpChannel: channel, createdBy: actor.id })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_ASSISTED_STEP,
    entityType: "dealer",
    entityId: dealer.id,
    newValue: { sessionId: session.id, step: "OTP_SENT", channel },
  });
  return toView(session);
}

/** Step 2: the code the owner told the dealer. */
export async function verifyAssistedOwner(dealer: Dealer, sessionId: string, code: string, actor: Actor, ip: string | null): Promise<AssistedSessionView> {
  const session = await ownSession(dealer, sessionId);
  if (session.status !== "OTP_SENT") throw conflict("The owner's code was already entered for this registration.");
  if (session.otpChannel === "SMS") await verifyRegistrationOtp(session.ownerMobileE164, code);
  else await verifyShopOnboardingConsentOtp({ email: session.ownerEmail, code, operatorId: actor.id, ip });
  const owner = await ownerAccountFor(session.ownerEmail);
  // A new account gets the owner's name and mobile; an existing one keeps its own.
  if (owner.created) {
    await db.update(users).set({ name: session.ownerName, phoneE164: session.ownerMobileE164, phone: session.ownerMobileE164.slice(-10), updatedAt: new Date() }).where(eq(users.id, owner.id));
  }
  const rule = await getRule("dealerProgramme");
  const now = new Date();
  const [row] = await db
    .update(dealerAssistedSessions)
    .set({ status: "OWNER_VERIFIED", verifiedAt: now, ownerUserId: owner.id, consentExpiresAt: new Date(now.getTime() + rule.assistedConsentMinutes * 60_000), updatedAt: now })
    .where(and(eq(dealerAssistedSessions.id, session.id), eq(dealerAssistedSessions.status, "OTP_SENT")))
    .returning();
  if (!row) throw conflict("The owner's code was already entered for this registration.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_ASSISTED_STEP,
    entityType: "dealer",
    entityId: dealer.id,
    newValue: { sessionId: session.id, step: "OWNER_VERIFIED", ownerUserId: owner.id, newOwnerAccount: owner.created },
  });
  return toView(row);
}

/** What the dealer fills in: the ordinary registration, never the owner, fee, date or code. */
export type AssistedShopInput = Omit<RegisterShopInput, "ownerId" | "registrationFeePaise" | "registrationDate" | "referralCode">;

/** Step 3: the shop, registered under the owner with the dealer's code; the owner pays the fee. */
export async function submitAssistedShop(
  dealer: Dealer,
  sessionId: string,
  input: AssistedShopInput,
  ownerAcceptedTerms: boolean,
  actor: Actor,
): Promise<{ shop: Shop; feeDuePaise: number; code: string | null }> {
  if (dealer.status !== "APPROVED") throw forbidden("Your dealer account is not active.");
  const session = await ownSession(dealer, sessionId);
  if (session.status !== "OWNER_VERIFIED" || !session.ownerUserId) throw forbidden("The owner has not confirmed: send the code to the owner and enter it first.");
  if (!session.consentExpiresAt || session.consentExpiresAt.getTime() <= Date.now()) throw forbidden("The owner's confirmation has expired. Start again and send a new code.");
  if (!ownerAcceptedTerms) throw validationFailed("The owner must accept GoKesari's terms for sellers.", { fields: { ownerAcceptedTerms: "Required." } });
  if ((await getRule("registrationFeeByTurnover")).enabled && input.annualTurnoverRupees == null) {
    throw validationFailed("Please check the highlighted fields.", { fields: { annualTurnover: "Enter the shop's annual turnover — it sets the registration fee." } });
  }
  const code = await activeCodeFor(dealer.id, session.salespersonId) ?? (await activeCodeFor(dealer.id, null));

  const sanitized = { ...(input as RegisterShopInput & Record<string, unknown>) };
  for (const k of ["ownerId", "registrationFeePaise", "registrationDate", "referralCode"]) delete sanitized[k];
  let shop: Shop;
  try {
    // `privileged` only so the shop is registered under the verified owner; the staff-only fields were removed above.
    shop = await registerShop({ ...sanitized, ownerId: session.ownerUserId }, actor, { privileged: true });
  } catch (error) {
    // A duplicate must not tell a dealer about another owner's shop.
    if (error instanceof AppError && error.code === "CONFLICT" && error.details?.reason === "DUPLICATE_SHOP") {
      throw conflict("This shop looks already registered on GoKesari. If you believe it is new, contact GoKesari support.", { reason: "DUPLICATE_SHOP" });
    }
    throw error;
  }
  if (code && !shop.referralCodeId) {
    await attributeShopToCode(shop.id, code, actor).catch((e) => console.error("[dealer-assisted] could not attach the dealer code", shop.id, e instanceof Error ? e.message : e));
  }
  await db
    .update(dealerAssistedSessions)
    .set({ status: "SHOP_SUBMITTED", shopId: shop.id, updatedAt: new Date() })
    .where(eq(dealerAssistedSessions.id, session.id));
  await recordShopAttributionSafely(shop.id, actor, { assisted: { dealerId: dealer.id, salespersonId: session.salespersonId } });
  const [after] = await db.select().from(shops).where(eq(shops.id, shop.id));
  const feeDuePaise = Math.max(0, (after.registrationFeePaise ?? 0) - after.amountPaidPaise);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_ASSISTED_STEP,
    entityType: "shop",
    entityId: shop.id,
    newValue: { sessionId: session.id, step: "SHOP_SUBMITTED", dealerId: dealer.id, ownerUserId: session.ownerUserId, code, feeDuePaise },
  });
  await notify({
    userId: session.ownerUserId,
    type: NOTIFICATION_TYPES.DEALER_ASSISTED_SHOP_REGISTERED,
    vars: { dealerName: dealer.legalName, shopName: after.name },
    actionUrl: "/shop",
    dedupeKey: `dealer-assisted:${shop.id}`,
  });
  return { shop: after, feeDuePaise, code };
}

export async function listAssistedSessions(dealer: Dealer): Promise<AssistedSessionView[]> {
  const rows = await db.select().from(dealerAssistedSessions).where(eq(dealerAssistedSessions.dealerId, dealer.id)).orderBy(dealerAssistedSessions.createdAt);
  return rows.map(toView);
}
