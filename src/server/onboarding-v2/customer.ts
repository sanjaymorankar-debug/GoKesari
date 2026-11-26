/**
 * Onboarding v2, Flow 1 — the customer signs in only at checkout (docs/onboarding-v2-2026-11, flag onboarding_v2).
 *
 *   0. Guest mode: no sign-in before checkout. v2 implies the browser (guest) cart, whatever guest_cart_enabled says.
 *   1. Login sheet at "Place order": the Terms & Privacy tick. A guest has no account yet, so the tick (version +
 *      time) rides in a short-lived signed cookie and is written to user_consents AND policy_acceptances as soon
 *      as the account exists; a signed-in customer's tick is written at once.
 *   2. E-mail verified: Google, or the e-mailed sign-in link (in the app: Google or the e-mailed code).
 *   3. Mobile verified by an SMS code (rule onboardingV2.mobileOtpFallbackWhenNoSms decides what happens where no
 *      SMS can be sent). Account and wallet exist from step 2; the wallet is ensured again here.
 *   4–6. Checkout (ONLINE or COD chosen explicitly), then the delivery location after payment for delivery orders:
 *      checkout() places them with orders.address_pending_since set and rider dispatch waits for it.
 *
 * External side effects (SMS, rider dispatch) never run inside a db.transaction here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";

import { conflict, forbidden, isUniqueViolation, notFound, validationFailed } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { parseIndianMobile } from "@/lib/contact";
import { maskPhone } from "@/lib/phone";
import { db } from "@/server/db";
import {
  accounts,
  addresses,
  orders,
  policyAcceptances,
  shopReferralCodes,
  shops,
  userConsents,
  users,
  wallets,
  type OrderStatus,
  type PolicyAcceptanceChannel,
  type User,
  type UserRole,
} from "@/server/db/schema";
import { consumeSmsCode, markPhoneVerified, sendSmsCode, smsCodesAvailable } from "@/server/otp/second-factor";
import { assertPhoneFree, MOBILE_IN_USE } from "@/server/otp/service";
import { formatIstStamp, onboardingV2Enabled } from "@/server/onboarding-v2/roles";
import { createAddress } from "@/server/services/addresses";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { featureNotAvailable, isFeatureEnabled } from "@/server/services/feature-flags";
import { listCurrentVersions } from "@/server/services/policy-versions";
import { shopServiceability } from "@/server/services/serviceability";
import { getRule } from "@/server/services/settings";

export { onboardingV2Enabled };

/* ------------------------------------------------------------- guest mode */

/** The browser cart is on for guests: flag guest_cart_enabled, or onboarding_v2 (v2 implies the guest cart). */
export async function isGuestCartOn(): Promise<boolean> {
  const [guestCart, v2] = await Promise.all([isFeatureEnabled("guest_cart_enabled").catch(() => false), onboardingV2Enabled()]);
  return guestCart || v2;
}

/** The guest-cart routes' gate: as requireFeature("guest_cart_enabled"), but on as well while onboarding_v2 is on. */
export async function requireGuestCart(): Promise<void> {
  if (!(await isGuestCartOn())) throw featureNotAvailable("guest_cart_enabled");
}

/**
 * /r/<code> for a guest while onboarding_v2 is on: no forced sign-in. A shop's code (its QR) opens the shop's page;
 * a customer code opens the home page. The code stays remembered by the route's cookies (gk_ref / gk_ref_link) and
 * is offered after the first payment. null = keep the route's own landing (dealer / agent / franchise codes →
 * Add my shop). DEFAULT – confirm with Sanjay.
 */
export async function v2GuestReferralLanding(target: { code: string; kind?: string; audience: "shop-owner" | "customer" }): Promise<string | null> {
  if (target.kind === "SHOP" || (!target.kind && /^SHOP/i.test(target.code))) {
    const [row] = await db
      .select({ slug: shops.slug })
      .from(shopReferralCodes)
      .innerJoin(shops, eq(shops.id, shopReferralCodes.shopId))
      .where(eq(shopReferralCodes.code, target.code.toUpperCase()));
    return row ? `/shops/${encodeURIComponent(row.slug)}` : null;
  }
  return target.audience === "customer" ? "/" : null;
}

/* ---------------------------------------------------- step 1: Terms tick */

/** The guest's tick, carried until the account exists. */
export const V2_TERMS_COOKIE = "gk_ov2_terms";
/** DEFAULT – confirm with Sanjay: the tick is kept 2 hours while the guest verifies the e-mail (a new tick after that). */
export const V2_TERMS_MAX_AGE_S = 2 * 60 * 60;
/** user_consents.source of a tick given on the checkout login sheet. */
export const V2_CONSENT_SOURCE = "CHECKOUT_LOGIN_SHEET";

export interface TermsTick {
  version: string;
  acceptedAt: Date;
}

function termsMac(payload: string): string {
  return createHmac("sha256", getEnv().AUTH_SECRET).update(`ov2-terms:${payload}`).digest("base64url");
}

/** `<version>.<epoch ms>.<mac>` — proof that this browser ticked the box at that time. Carries nothing personal. */
export function createTermsToken(tick: TermsTick): string {
  const payload = `${tick.version}.${tick.acceptedAt.getTime()}`;
  return `${payload}.${termsMac(payload)}`;
}

export function readTermsToken(token: string | null | undefined, now = Date.now()): TermsTick | null {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  const [version, at, mac] = parts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(version) || !/^\d{10,15}$/.test(at)) return null;
  const expected = Buffer.from(termsMac(`${version}.${at}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const acceptedAt = Number(at);
  if (acceptedAt > now + 60_000 || now - acceptedAt > V2_TERMS_MAX_AGE_S * 1000) return null;
  return { version, acceptedAt: new Date(acceptedAt) };
}

export interface ConsentEvidence {
  channel: Extract<PolicyAcceptanceChannel, "WEB" | "APP">;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes the tick: one user_consents row (TERMS_AND_PRIVACY, the version shown, source CHECKOUT_LOGIN_SHEET, at the
 * time it was ticked) and one policy_acceptances row each for terms and privacy-policy (the published version
 * where an admin published one, else the site's CURRENT_POLICY_VERSION) with the channel. Times are stored as UTC
 * instants and shown in IST.
 */
export async function recordCheckoutConsent(userId: string, tick: TermsTick, evidence: ConsentEvidence): Promise<TermsTick> {
  const current = await listCurrentVersions().catch(() => []);
  const versionOf = (doc: "terms" | "privacy-policy") => current.find((c) => c.doc === doc)?.latest?.version ?? tick.version;
  const userAgent = evidence.userAgent ? evidence.userAgent.slice(0, 500) : null;
  await db.transaction(async (tx) => {
    await tx.insert(userConsents).values({
      userId,
      consentType: "TERMS_AND_PRIVACY",
      version: tick.version,
      granted: true,
      ipAddress: evidence.ip ?? null,
      source: V2_CONSENT_SOURCE,
      userAgent,
      createdAt: tick.acceptedAt,
    });
    await tx.insert(policyAcceptances).values(
      (["terms", "privacy-policy"] as const).map((doc) => ({
        userId,
        doc,
        version: versionOf(doc),
        channel: evidence.channel,
        ipAddress: evidence.ip ?? null,
        userAgent,
        acceptedAt: tick.acceptedAt,
      })),
    );
    await recordAudit(
      {
        actorId: userId,
        action: AUDIT_ACTIONS.CONSENT_RECORDED,
        entityType: "user",
        entityId: userId,
        newValue: { consentType: "TERMS_AND_PRIVACY", version: tick.version, source: V2_CONSENT_SOURCE, channel: evidence.channel, acceptedAt: tick.acceptedAt.toISOString() },
        ipAddress: evidence.ip ?? null,
      },
      tx,
    );
  });
  return tick;
}

/** The latest Terms & Privacy grant of the account (any version), or null. */
async function latestTermsConsent(userId: string): Promise<{ version: string; at: Date } | null> {
  const [row] = await db
    .select({ version: userConsents.version, at: userConsents.createdAt, granted: userConsents.granted })
    .from(userConsents)
    .where(and(eq(userConsents.userId, userId), eq(userConsents.consentType, "TERMS_AND_PRIVACY")))
    .orderBy(desc(userConsents.createdAt))
    .limit(1);
  return row?.granted ? { version: row.version, at: row.at } : null;
}

/* ----------------------------------------------------------- the status */

export type CustomerSheetStep = "CONSENT" | "EMAIL" | "MOBILE" | "DONE";

export const NO_SMS_BLOCKED =
  "We cannot send a code to your mobile right now, so new orders cannot be placed. Please try again later or contact support.";

export interface CustomerLoginStatus {
  step: CustomerSheetStep;
  consent: { version: string; acceptedAtIst: string } | null;
  emailVerified: boolean;
  mobile: { masked: string; verified: boolean } | null;
  smsAvailable: boolean;
  /** Set when step MOBILE cannot be finished on this site (no SMS and the fallback rule off). */
  blockedReason: string | null;
}

async function emailIsVerified(user: User): Promise<boolean> {
  if (user.emailPlaceholder) return false;
  if (user.emailVerified) return true;
  // Google proves the address; Auth.js leaves emailVerified empty for an OAuth sign-up.
  const [google] = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(and(eq(accounts.userId, user.id), eq(accounts.provider, "google")))
    .limit(1);
  return Boolean(google);
}

/**
 * Mobile step done: a verified mobile; or — no SMS can be sent and rule onboardingV2.mobileOtpFallbackWhenNoSms is
 * on (DEFAULT, documented in the README) — any mobile saved on the account.
 */
async function mobileState(user: User): Promise<{ done: boolean; smsAvailable: boolean; blockedReason: string | null }> {
  const smsAvailable = await smsCodesAvailable();
  if (user.phoneE164 && user.phoneVerifiedAt) return { done: true, smsAvailable, blockedReason: null };
  if (smsAvailable) return { done: false, smsAvailable, blockedReason: null };
  const { mobileOtpFallbackWhenNoSms } = await getRule("onboardingV2");
  if (mobileOtpFallbackWhenNoSms) return { done: Boolean(user.phoneE164), smsAvailable, blockedReason: null };
  return { done: false, smsAvailable, blockedReason: NO_SMS_BLOCKED };
}

/** Where a signed-in customer stands in the login sheet. Returning customers with everything done get DONE. */
export async function customerLoginStatus(userId: string): Promise<CustomerLoginStatus> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw notFound("Account");
  const [consent, emailVerified, mobile] = await Promise.all([latestTermsConsent(userId), emailIsVerified(user), mobileState(user)]);
  // DEFAULT – confirm with Sanjay: a returning customer who accepted the Terms before (any version) is not asked
  // again here; a newer required version is asked by the existing re-consent flow (policy_reconsent_enabled).
  const step: CustomerSheetStep = !consent ? "CONSENT" : !emailVerified ? "EMAIL" : !mobile.done ? "MOBILE" : "DONE";
  return {
    step,
    consent: consent ? { version: consent.version, acceptedAtIst: formatIstStamp(consent.at) } : null,
    emailVerified,
    mobile: user.phoneE164 ? { masked: maskPhone(user.phoneE164), verified: Boolean(user.phoneVerifiedAt) } : null,
    smsAvailable: mobile.smsAvailable,
    blockedReason: mobile.done ? null : mobile.blockedReason,
  };
}

/* ------------------------------------------------------ step 3: mobile */

/** Idempotent: one wallet per account (unique index). */
export async function ensureCustomerWallet(userId: string): Promise<void> {
  await db.insert(wallets).values({ userId }).onConflictDoNothing();
}

function parseMobileOrRefuse(mobile: string): string {
  const parsed = parseIndianMobile(mobile);
  if (!parsed.ok) throw validationFailed(parsed.error, { fields: { mobile: parsed.error } });
  return parsed.e164;
}

async function loadUser(userId: string): Promise<User> {
  const [user] = await db.select().from(users).where(and(eq(users.id, userId), isNull(users.deletedAt)));
  if (!user || user.status !== "ACTIVE") throw forbidden("This account cannot place orders.");
  return user;
}

export type MobileStartResult =
  | { status: "CODE_SENT"; maskedPhone: string; resendAfterSeconds: number; expiryMinutes: number }
  | { status: "SAVED_UNVERIFIED"; maskedPhone: string };

/** Step 3a: an SMS code to the number; where no SMS can be sent, the fallback rule decides. */
export async function startMobileVerification(userId: string, mobile: string, ip: string | null): Promise<MobileStartResult> {
  const user = await loadUser(userId);
  const e164 = parseMobileOrRefuse(mobile);
  await assertPhoneFree(e164, user.id);
  if (await smsCodesAvailable()) {
    const sent = await sendSmsCode(user, e164, "LOGIN_SMS", ip);
    return { status: "CODE_SENT", maskedPhone: sent.maskedPhone, resendAfterSeconds: sent.resendAfterSeconds, expiryMinutes: sent.expiryMinutes };
  }
  if (!(await getRule("onboardingV2")).mobileOtpFallbackWhenNoSms) throw conflict(NO_SMS_BLOCKED, { noSms: true });
  // DEFAULT (README #8): saved unverified, like e-mail sign-in does today; phone_verified_at stays empty.
  if (user.phoneE164 !== e164) {
    try {
      await db.update(users).set({ phoneE164: e164, phone: e164.slice(3), phoneVerifiedAt: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict(MOBILE_IN_USE);
      throw error;
    }
    await recordAudit({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.PHONE_LINKED,
      entityType: "user",
      entityId: user.id,
      newValue: { phone: maskPhone(e164), verified: false, reason: "onboarding_v2_no_sms" },
      ipAddress: ip,
    });
  }
  await ensureCustomerWallet(user.id);
  return { status: "SAVED_UNVERIFIED", maskedPhone: maskPhone(e164) };
}

/** Step 3b: the code checked; the number saved as the account's verified mobile; the wallet ensured. */
export async function confirmMobileVerification(userId: string, mobile: string, code: string, ip: string | null): Promise<CustomerLoginStatus> {
  const user = await loadUser(userId);
  const e164 = parseMobileOrRefuse(mobile);
  await consumeSmsCode(user, e164, "LOGIN_SMS", String(code ?? "").trim(), ip);
  await markPhoneVerified(user, e164);
  await ensureCustomerWallet(user.id);
  return customerLoginStatus(user.id);
}

/* -------------------------------------------- step 5: address after payment */

/** Orders whose delivery location may still be given (not cancelled, failed, delivered or refunded). */
export const ADDRESS_OPEN_STATUSES: readonly OrderStatus[] = ["PENDING", "CONFIRMED", "ACCEPTED", "PREPARING", "READY"];

/** True while rider dispatch must wait for the customer's delivery location. */
export function awaitingDeliveryAddress(order: { addressPendingSince: Date | null }): boolean {
  return order.addressPendingSince != null;
}

export interface AwaitingAddressOrder {
  id: string;
  orderNumber: string;
  shopName: string;
  totalPaise: number;
  status: OrderStatus;
  paymentMethod: string;
  orderGroupId: string | null;
  pendingSinceIst: string;
}

export async function listOrdersAwaitingAddress(userId: string): Promise<AwaitingAddressOrder[]> {
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      shopName: shops.name,
      totalPaise: orders.totalPaise,
      status: orders.status,
      paymentMethod: orders.paymentMethod,
      orderGroupId: orders.orderGroupId,
      pendingSince: orders.addressPendingSince,
    })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .where(and(eq(orders.userId, userId), isNotNull(orders.addressPendingSince), inArray(orders.status, [...ADDRESS_OPEN_STATUSES])))
    .orderBy(desc(orders.createdAt))
    .limit(20);
  return rows.map(({ pendingSince, ...r }) => ({ ...r, pendingSinceIst: formatIstStamp(pendingSince) }));
}

export interface NewDeliveryAddress {
  line1: string;
  area?: string | null;
  city: string;
  state?: string | null;
  pincode: string;
  landmark?: string | null;
  /** From the device GPS or the map pin — mandatory for a new address. */
  latitude: number;
  longitude: number;
}

export interface DeliveryLocationInput {
  orderIds: string[];
  /** A saved address of the customer… */
  addressId?: string | null;
  /** …or a new one from GPS + map pin. */
  address?: NewDeliveryAddress | null;
  /** Keep the new address in "My addresses" (else it is used for these orders only). */
  saveAddress?: boolean;
  /** Optional: the customer's name (kept on the account if it has none) and the recipient on the address. */
  name?: string | null;
  /** Optional referral code — the existing signup-referral policy decides whether it is accepted. */
  referralCode?: string | null;
}

export interface DeliveryLocationResult {
  orders: { id: string; orderNumber: string }[];
  addressId: string;
  referral: { applied: boolean; message: string | null } | null;
}

/**
 * Step 5: the delivery location for orders placed before it was known. Only the customer who placed them, only
 * while they wait for it, and only where every shop delivers to it. Afterwards a READY order goes to rider dispatch.
 */
export async function setDeliveryLocationAfterPayment(
  actor: { id: string; role: UserRole },
  input: DeliveryLocationInput,
): Promise<DeliveryLocationResult> {
  const ids = [...new Set(input.orderIds)];
  if (ids.length === 0 || ids.length > 20) throw validationFailed("Choose the orders to deliver.");
  if (!input.addressId && !input.address) throw validationFailed("Choose a saved address or set the delivery location on the map.");
  const rows = await db.select().from(orders).where(inArray(orders.id, ids));
  if (rows.length !== ids.length) throw notFound("Order");
  for (const o of rows) {
    if (o.userId !== actor.id) throw forbidden("This is not your order.");
    if (!o.addressPendingSince) throw conflict(`Order ${o.orderNumber} already has its delivery address.`);
    if (!ADDRESS_OPEN_STATUSES.includes(o.status)) throw conflict(`Order ${o.orderNumber} can no longer be changed.`);
  }

  // The location to check: a saved address, or the new pin.
  let location: { line1: string; line2?: string | null; area?: string | null; city: string; pincode: string; latitude: string | null; longitude: string | null; landmark?: string | null; deliveryInstructions?: string | null };
  if (input.addressId) {
    const [saved] = await db
      .select()
      .from(addresses)
      .where(and(eq(addresses.id, input.addressId), eq(addresses.userId, actor.id), isNull(addresses.deletedAt)));
    if (!saved) throw notFound("Address");
    location = {
      line1: saved.line1,
      line2: saved.line2,
      area: saved.area,
      city: saved.city,
      pincode: saved.pincode,
      latitude: saved.latitude,
      longitude: saved.longitude,
      landmark: saved.landmark,
      deliveryInstructions: saved.deliveryInstructions,
    };
  } else {
    const a = input.address!;
    if (!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude) || Math.abs(a.latitude) > 90 || Math.abs(a.longitude) > 180) {
      throw validationFailed("Set your delivery location with GPS or the map pin.", { fields: { location: "Set the pin." } });
    }
    location = { line1: a.line1, area: a.area ?? null, city: a.city, pincode: a.pincode, latitude: String(a.latitude), longitude: String(a.longitude), landmark: a.landmark ?? null };
  }

  // Every shop must deliver there (radius / PIN list). A shop paused since the order was placed still delivers it.
  const shopRows = await db.select().from(shops).where(inArray(shops.id, [...new Set(rows.map((o) => o.shopId))]));
  for (const shop of shopRows) {
    const check = shopServiceability(
      { ...shop, ordersPaused: false },
      {
        label: "delivery-location",
        pincode: location.pincode,
        latitude: location.latitude != null ? Number(location.latitude) : null,
        longitude: location.longitude != null ? Number(location.longitude) : null,
        source: "ADDRESS" as const,
        addressId: input.addressId ?? null,
        societyId: null,
      },
    );
    if (!check.deliversHere) {
      // DEFAULT – confirm with Sanjay: an address the shop does not deliver to is refused; the customer picks
      // another or cancels the order (existing cancel + refund rules).
      throw conflict(`${shop.name} does not deliver to this location. ${check.reason ?? ""} Choose another address, or cancel the order for a refund.`.trim());
    }
  }

  const name = input.name?.trim().slice(0, 80) || null;
  let addressId = input.addressId ?? null;
  let createdForOrderOnly = false;
  if (!addressId) {
    const a = input.address!;
    const created = await createAddress(actor.id, {
      line1: a.line1,
      area: a.area ?? null,
      city: a.city,
      state: a.state ?? null,
      pincode: a.pincode,
      landmark: a.landmark ?? null,
      latitude: a.latitude,
      longitude: a.longitude,
      recipientName: name,
      addressType: "HOME",
      // DEFAULT – confirm with Sanjay: a saved address becomes the default only when it is the customer's first.
      isDefault: input.saveAddress === true && (await db.select({ id: addresses.id }).from(addresses).where(and(eq(addresses.userId, actor.id), isNull(addresses.deletedAt))).limit(1)).length === 0,
    });
    addressId = created.id;
    createdForOrderOnly = input.saveAddress !== true;
  }

  const snapshot = {
    line1: location.line1,
    line2: location.line2 ?? null,
    area: location.area ?? null,
    city: location.city,
    pincode: location.pincode,
    latitude: location.latitude,
    longitude: location.longitude,
    landmark: location.landmark ?? null,
    deliveryInstructions: location.deliveryInstructions ?? null,
  };

  const updated = await db.transaction(async (tx) => {
    // Only orders still waiting: a second tab or a double tap changes nothing twice.
    const done = await tx
      .update(orders)
      .set({ addressId, deliveryAddressSnapshot: snapshot, addressPendingSince: null, updatedAt: new Date() })
      .where(and(inArray(orders.id, ids), eq(orders.userId, actor.id), isNotNull(orders.addressPendingSince)))
      .returning({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status });
    if (done.length !== ids.length) throw conflict("These orders changed meanwhile. Refresh and try again.");
    for (const o of done) {
      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action: AUDIT_ACTIONS.ORDER_DELIVERY_ADDRESS_SET,
          entityType: "order",
          entityId: o.id,
          newValue: { addressId, pincode: snapshot.pincode, hasCoordinates: snapshot.latitude != null },
        },
        tx,
      );
    }
    // Not kept in "My addresses": the row stays for the order (orders.address_id) but is hidden from the list.
    if (createdForOrderOnly && addressId) await tx.update(addresses).set({ deletedAt: new Date() }).where(eq(addresses.id, addressId));
    // DEFAULT – confirm with Sanjay: the optional name is saved on the account only when it has none.
    if (name) await tx.update(users).set({ name, updatedAt: new Date() }).where(and(eq(users.id, actor.id), isNull(users.name)));
    return done;
  });

  // After commit: a READY order now looks for a rider (it waited for this address).
  const { dispatchReadyOrder } = await import("@/server/services/delivery-assignment");
  for (const o of updated) {
    if (o.status !== "READY") continue;
    await dispatchReadyOrder(o.id, { id: actor.id, role: actor.role }, "AUTO_READY").catch((error) =>
      console.error("[onboarding-v2] dispatch after delivery address failed", o.id, error),
    );
  }

  let referral: DeliveryLocationResult["referral"] = null;
  if (input.referralCode?.trim()) {
    const { applySignupReferralCode } = await import("@/server/services/customer-signup-referrals");
    try {
      await applySignupReferralCode(actor.id, input.referralCode, actor, { firstOrderIds: await firstCheckoutOrderIds(actor.id, ids) });
      referral = { applied: true, message: null };
    } catch (error) {
      // The address is saved either way; the referral answer is shown next to its box.
      referral = { applied: false, message: error instanceof Error ? error.message : "This referral code could not be used." };
    }
  }

  return { orders: updated.map((o) => ({ id: o.id, orderNumber: o.orderNumber })), addressId: addressId!, referral };
}

/**
 * The orders of the customer's FIRST checkout (one request id; a multi-shop checkout is one order per shop) when
 * `ids` belong to it, else none — the referral exemption covers that first checkout, never a later order.
 */
export async function firstCheckoutOrderIds(userId: string, ids: string[]): Promise<string[]> {
  const [first] = await db
    .select({ id: orders.id, checkoutKey: orders.checkoutKey, orderGroupId: orders.orderGroupId })
    .from(orders)
    .where(eq(orders.userId, userId))
    .orderBy(orders.createdAt, orders.id)
    .limit(1);
  if (!first) return [];
  const all = await db
    .select({ id: orders.id, checkoutKey: orders.checkoutKey, orderGroupId: orders.orderGroupId })
    .from(orders)
    .where(eq(orders.userId, userId));
  // checkout key = "checkout:<user>:<request id>:<shop>" (orders.ts).
  const requestOf = (key: string | null) => (key?.startsWith(`checkout:${userId}:`) ? key.slice(0, key.lastIndexOf(":")) : null);
  const firstRequest = requestOf(first.checkoutKey);
  const sameCheckout = all.filter(
    (o) => o.id === first.id || (firstRequest != null && requestOf(o.checkoutKey) === firstRequest) || (first.orderGroupId != null && o.orderGroupId === first.orderGroupId),
  );
  // Only when these orders belong to that first checkout; then all of it is exempt (e.g. its pickup order too).
  const firstIds = sameCheckout.map((o) => o.id);
  return firstIds.some((id) => ids.includes(id)) ? firstIds : [];
}

/* ------------------------------------------------------ step 4: checkout */

export const CHOOSE_PAYMENT = "Choose how to pay: online or cash on delivery.";

/**
 * The /api/checkout gate while onboarding_v2 is on (null when off — nothing changes). A personal order needs the
 * login sheet finished (Terms, e-mail, mobile) and a payment method chosen explicitly — v2 preselects none.
 * Refused with 409 { details: { loginSheet: true, step } } so the cart opens the sheet at that step.
 */
export async function assertV2CheckoutReady(
  userId: string,
  body: { paymentMethod?: string | null; orderType?: string | null },
): Promise<{ v2: true } | null> {
  if (!(await onboardingV2Enabled())) return null;
  if ((body.orderType ?? "PERSONAL") !== "PERSONAL") return { v2: true };
  const status = await customerLoginStatus(userId);
  if (status.step !== "DONE") {
    throw conflict(status.blockedReason ?? "Finish signing in to place your order.", { loginSheet: true, step: status.step });
  }
  if (!body.paymentMethod) throw validationFailed(CHOOSE_PAYMENT, { fields: { paymentMethod: CHOOSE_PAYMENT } });
  return { v2: true };
}

/* --------------------------------------------- safety net: auto-cancel */

export const ADDRESS_PENDING_TIMEOUT_REASON = "No delivery location was given in time";

/**
 * Cron (every 5 minutes): delivery orders still waiting for the customer's delivery location longer than rule
 * onboardingV2.addressPendingAutoCancelHours are cancelled by the system with a full refund (online: to the
 * original method; wallet: back to the wallet; COD: nothing was paid) and the shop is told (order.cancelled).
 * Each order is cancelled in its own transaction (cancelOrder); refunds go through the existing refund paths.
 */
export async function cancelStaleAddressPendingOrders(now: Date = new Date()): Promise<{ cancelled: number; failed: number }> {
  const { addressPendingAutoCancelHours } = await getRule("onboardingV2");
  if (!addressPendingAutoCancelHours) return { cancelled: 0, failed: 0 };
  const cutoff = new Date(now.getTime() - addressPendingAutoCancelHours * 3_600_000);
  const stale = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(isNotNull(orders.addressPendingSince), lte(orders.addressPendingSince, cutoff), inArray(orders.status, [...ADDRESS_OPEN_STATUSES])))
    .limit(100);
  const { cancelOrder } = await import("@/server/services/orders");
  let cancelled = 0;
  let failed = 0;
  for (const { id } of stale) {
    try {
      await cancelOrder(id, null, ADDRESS_PENDING_TIMEOUT_REASON);
      cancelled += 1;
    } catch (error) {
      // An online order with a payment attempt still open is retried on the next run.
      failed += 1;
      console.error("[onboarding-v2] auto-cancel of an address-pending order failed", id, error);
    }
  }
  return { cancelled, failed };
}
