/**
 * One-time identity verification of customers and shop owners
 * (docs/identity-verification-2026-11). Everything here is inert while the
 * identity_verification_customers_enabled / _shop_owners_enabled switches are off (each gates only its audience).
 *
 *  - Consent first (lib/kyc/identity.ts): nothing goes to the provider before
 *    the person ticks the box; the version, time, IP and user agent are kept.
 *  - Aadhaar by DigiLocker (default, voluntary) through the licensed KYC
 *    provider — the session handling is the rider flow's, shared in
 *    server/kyc/digilocker-session.ts (same return link, webhook and app
 *    hand-back). PAN is always offered instead (rule
 *    identityVerification.allowedMethods "aadhaar_or_alternative").
 *    Driving licence and voter ID: no adapter checks them, so they are not
 *    offered (docs, "Not available").
 *  - Kept: masked id (last four), verified name, method, provider reference,
 *    name-match result and the consent record. NEVER the Aadhaar number, OTP,
 *    e-KYC XML, photo, date of birth or address; a keyed token of the
 *    DigiLocker account id / PAN finds the same identity on another account.
 *  - Name match against the account name (customers) or the shop owner /
 *    registered shop name (shop owners). Below rule nameMatchThreshold, or the
 *    identity is verified on another account → NAME_MISMATCH_REVIEW, decided
 *    by an admin (Admin → Identity verification), audited.
 *  - Gates (flag on): a customer's first checkout; a shop going live; an
 *    existing shop owner's new orders after rule sellerGraceDays from when they
 *    were first asked. Once VERIFIED, never asked again.
 *  - Provider: off production (test.gokesari.com, local) always the mock; on
 *    gokesari.com the rule's provider, and the mock is refused there.
 *
 * Provider calls happen outside any transaction; a provider outage never
 * marks someone as failed for good — they can simply try again.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { isProductionSite } from "@/lib/env";
import { parseSellerDocNumber } from "@/lib/kyc/doc-formats";
import { IDENTITY_CONSENT_VERSION, identityReason, VERIFY_IDENTITY_PATH } from "@/lib/kyc/identity";
import { maskAadhaarLast4, maskPanLast4, redactIdentityNumbers } from "@/lib/kyc/identity-mask";
import { bestNameMatch } from "@/lib/kyc/name-match";
import { isMobileAppScheme, type MobileAppScheme } from "@/lib/mobile-app";
import { docBlindIndex } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import { systemTicketHook } from "@/server/aftercare/system-ticket-hook";
import {
  featureFlagChanges,
  identityVerificationPrompts,
  identityVerifications,
  shops,
  users,
  type IdentityVerification,
  type IdentityVerificationMethod,
  type IdentityVerificationStatus,
  type UserRole,
} from "@/server/db/schema";
import { KycConfigError, verifyDocument } from "@/server/kyc";
import {
  DIGILOCKER_PENDING_MASK,
  DIGILOCKER_REUSE_MIN_LEFT_MS,
  digilockerErrorCode,
  digilockerReturnApp,
  isDigilockerReturnKey,
  openDigilockerSession,
  resolveDigilockerSession,
  type DigilockerSource,
} from "@/server/kyc/digilocker-session";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { isFeatureEnabled } from "./feature-flags";
import type { FeatureFlagKey } from "@/server/db/schema";
import { notify } from "./notifications";
import { getRule } from "./settings";

/**
 * Owner, 24-Nov-2026: switched separately for each audience, at any time
 * (Admin → Identity verification → Settings). Off lifts that audience's
 * requirement at once; stored verifications are kept.
 */
export const IDENTITY_FLAGS = {
  CUSTOMER: "identity_verification_customers_enabled",
  SHOP_OWNER: "identity_verification_shop_owners_enabled",
} as const satisfies Record<string, FeatureFlagKey>;
/** Opening the page re-asks the provider at most this often (the polling fallback to the webhook). */
const POLL_MIN_MS = 10_000;
const DAY_MS = 86_400_000;
/** Where the reminder / decision notifications point. */
const PAGE = VERIFY_IDENTITY_PATH;

export type IdentitySubject = "CUSTOMER" | "SHOP_OWNER";

interface Actor {
  id: string;
  role: UserRole;
}

export interface IdentityConsent {
  consentGiven: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IdentityVerificationView {
  id: string;
  method: IdentityVerificationMethod;
  status: IdentityVerificationStatus;
  maskedId: string;
  verifiedName: string | null;
  reason: string | null;
  /** DigiLocker: a session is open and its link can still be used. */
  digilockerOpen: boolean;
  verifiedAt: Date | null;
  updatedAt: Date;
}

export function toIdentityView(row: IdentityVerification): IdentityVerificationView {
  return {
    id: row.id,
    method: row.method,
    status: row.status,
    maskedId: row.maskedId,
    verifiedName: row.verifiedName,
    reason: row.status === "VERIFIED" ? null : row.status === "REJECTED" ? (row.reviewNote ?? null) : identityReason(row.errorCode),
    digilockerOpen: digilockerOpen(row),
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  };
}

function digilockerOpen(row: IdentityVerification, now = Date.now()): boolean {
  return (
    row.method === "AADHAAR_DIGILOCKER" &&
    row.status === "PENDING" &&
    row.sessionStatus === "created" &&
    Boolean(row.sessionUrl) &&
    (row.sessionExpiresAt?.getTime() ?? 0) > now
  );
}

/* ------------------------------------------------------------------ config */

/** Is the requirement on for this audience? */
export async function isIdentityVerificationOn(audience: IdentitySubject): Promise<boolean> {
  return isFeatureEnabled(IDENTITY_FLAGS[audience]).catch(() => false);
}

/** The audiences whose requirement is on and applies to this person (everyone can buy; shop owners also sell). */
async function audiencesFor(userId: string): Promise<IdentitySubject[]> {
  const out: IdentitySubject[] = [];
  if (await isIdentityVerificationOn("CUSTOMER")) out.push("CUSTOMER");
  if ((await isIdentityVerificationOn("SHOP_OWNER")) && (await ownsAnyShop(userId))) out.push("SHOP_OWNER");
  return out;
}

/**
 * When the shop owners' flag was last switched from off to on (its change log), or null when the log has
 * none (seeded / set directly). A prompt recorded before it belongs to an earlier period and is ignored, so
 * the grace period starts again from the first prompt after the flag came back on.
 */
async function shopOwnersFlagOnSince(): Promise<Date | null> {
  const [row] = await db
    .select({ changedAt: featureFlagChanges.changedAt })
    .from(featureFlagChanges)
    .where(
      and(
        eq(featureFlagChanges.flagKey, IDENTITY_FLAGS.SHOP_OWNER),
        sql`(${featureFlagChanges.newValue}->>'enabled')::boolean = true`,
        sql`coalesce((${featureFlagChanges.oldValue}->>'enabled')::boolean, false) = false`,
      ),
    )
    .orderBy(desc(featureFlagChanges.changedAt))
    .limit(1);
  return row?.changedAt ?? null;
}

/**
 * The provider this site uses: never a real one off production (staging rule,
 * docs "Staging"), and never the mock on gokesari.com.
 */
export async function identityProviderSource(): Promise<DigilockerSource> {
  if (!isProductionSite()) return "mock";
  const { provider } = await getRule("identityVerification");
  if (provider === "mock") {
    throw new KycConfigError("environment_mismatch", "The identity verification mock is not allowed on the production site.");
  }
  return "kyc_provider";
}

export interface IdentityMethodsOffered {
  aadhaar: boolean;
  pan: boolean;
  /** Listed as not available: no provider adapter checks them (docs/identity-verification-2026-11). */
  drivingLicence: false;
  voterId: false;
}

export async function offeredMethods(): Promise<IdentityMethodsOffered> {
  const { allowedMethods } = await getRule("identityVerification");
  return { aadhaar: true, pan: allowedMethods === "aadhaar_or_alternative", drivingLicence: false, voterId: false };
}

/* ------------------------------------------------------------------- reads */

async function latestRow(userId: string): Promise<IdentityVerification | undefined> {
  return db.query.identityVerifications.findFirst({
    where: eq(identityVerifications.userId, userId),
    orderBy: [desc(identityVerifications.createdAt)],
  });
}

export async function isIdentityVerified(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: identityVerifications.id })
    .from(identityVerifications)
    .where(and(eq(identityVerifications.userId, userId), eq(identityVerifications.status, "VERIFIED")))
    .limit(1);
  return Boolean(row);
}

async function ownsAnyShop(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: shops.id }).from(shops).where(and(eq(shops.ownerId, userId), isNull(shops.deletedAt))).limit(1);
  return Boolean(row);
}

export interface SellerIdentityState {
  /** The flag is on and this person owns a shop and is not verified. */
  required: boolean;
  verified: boolean;
  firstPromptedAt: Date | null;
  graceEndsAt: Date | null;
  /** Past the grace period: the shop takes no new orders. */
  graceOver: boolean;
}

/** The grace period of an existing shop owner (rule sellerGraceDays from when they were first asked). */
export async function sellerIdentityState(userId: string, now = new Date()): Promise<SellerIdentityState> {
  const none = { required: false, verified: false, firstPromptedAt: null, graceEndsAt: null, graceOver: false };
  if (!(await isIdentityVerificationOn("SHOP_OWNER"))) return none;
  if (await isIdentityVerified(userId)) return { ...none, verified: true };
  if (!(await ownsAnyShop(userId))) return none;
  const prompt = await db.query.identityVerificationPrompts.findFirst({ where: eq(identityVerificationPrompts.userId, userId) });
  const onSince = prompt ? await shopOwnersFlagOnSince() : null;
  // A prompt from before the flag was last switched on does not count (see shopOwnersFlagOnSince).
  if (!prompt || (onSince && prompt.firstPromptedAt < onSince)) return { ...none, required: true };
  const { sellerGraceDays } = await getRule("identityVerification");
  const graceEndsAt = new Date(prompt.firstPromptedAt.getTime() + sellerGraceDays * DAY_MS);
  return { required: true, verified: false, firstPromptedAt: prompt.firstPromptedAt, graceEndsAt, graceOver: now >= graceEndsAt };
}

/**
 * A shop owner is asked (seller shell, at sign-in, or the first order they
 * try to accept): the grace period starts now, once. No-op when the flag is
 * off, they are verified or they own no shop.
 */
export async function noteSellerIdentityPrompt(userId: string): Promise<SellerIdentityState> {
  const state = await sellerIdentityState(userId);
  if (!state.required || state.firstPromptedAt) return state;
  const now = new Date();
  await db
    .insert(identityVerificationPrompts)
    .values({ userId, firstPromptedAt: now })
    .onConflictDoUpdate({ target: identityVerificationPrompts.userId, set: { firstPromptedAt: now } });
  return sellerIdentityState(userId);
}

export interface MyIdentityStatus {
  enabled: boolean;
  verified: boolean;
  current: IdentityVerificationView | null;
  methods: IdentityMethodsOffered;
  seller: SellerIdentityState;
  subject: IdentitySubject;
}

export async function getMyIdentityStatus(userId: string): Promise<MyIdentityStatus> {
  const enabled = (await audiencesFor(userId)).length > 0;
  const found = await latestRow(userId);
  const current =
    found && found.method === "AADHAAR_DIGILOCKER" && found.status === "PENDING" && found.sessionId && Date.now() - found.updatedAt.getTime() >= POLL_MIN_MS
      ? await syncIdentityDigilocker(found, "poll")
      : found;
  const verified = await isIdentityVerified(userId);
  const verifiedRow = verified && current?.status !== "VERIFIED" ? await verifiedRowOf(userId) : null;
  return {
    enabled,
    verified,
    current: verifiedRow ? toIdentityView(verifiedRow) : current ? toIdentityView(current) : null,
    methods: await offeredMethods(),
    seller: await sellerIdentityState(userId),
    subject: (await ownsAnyShop(userId)) ? "SHOP_OWNER" : "CUSTOMER",
  };
}

async function verifiedRowOf(userId: string): Promise<IdentityVerification | null> {
  return (
    (await db.query.identityVerifications.findFirst({
      where: and(eq(identityVerifications.userId, userId), eq(identityVerifications.status, "VERIFIED")),
    })) ?? null
  );
}

/* ------------------------------------------------------------------- gates */

/** Checkout: a customer's first order needs a verified identity (flag on). Never asked again once verified. */
export async function assertIdentityVerifiedForCheckout(userId: string): Promise<void> {
  if (!(await isIdentityVerificationOn("CUSTOMER"))) return;
  if (await isIdentityVerified(userId)) return;
  throw conflict("Verify your identity once before your first order — it takes a minute.", {
    needsIdentityVerification: true,
    verifyUrl: `${PAGE}?next=/cart`,
  });
}

/** A shop goes live only once its owner's identity is verified (flag on). Pass the approval's transaction. */
export async function assertOwnerIdentityAllowsGoLive(ownerId: string): Promise<void> {
  if (!(await isIdentityVerificationOn("SHOP_OWNER"))) return;
  if (await isIdentityVerified(ownerId)) return;
  throw conflict("The shop owner must verify their identity (Aadhaar through DigiLocker, or PAN) before the shop can go live.", {
    needsOwnerIdentityVerification: true,
  });
}

/**
 * New orders for a shop (checkout and the shop accepting one): refused once the
 * owner's grace period is over and they are still not verified. Orders the
 * shop already accepted are never affected. The first time this runs for an
 * unprompted owner, their grace period starts.
 */
export async function assertShopIdentityAllowsOrders(shopId: string, options: { startGrace?: boolean } = {}): Promise<void> {
  if (!(await isIdentityVerificationOn("SHOP_OWNER"))) return;
  const [shop] = await db.select({ ownerId: shops.ownerId, name: shops.name }).from(shops).where(eq(shops.id, shopId));
  if (!shop) return;
  const state = options.startGrace ? await noteSellerIdentityPrompt(shop.ownerId) : await sellerIdentityState(shop.ownerId);
  if (!state.required || !state.graceOver) return;
  throw conflict(`${shop.name} can't take new orders until the shop owner verifies their identity.`, {
    needsOwnerIdentityVerification: true,
  });
}

/* ------------------------------------------------------------------ writes */

function requireConsent(consent: IdentityConsent): void {
  if (!consent.consentGiven) {
    throw validationFailed("Tick the consent box to continue. Using Aadhaar is voluntary — you can choose PAN instead.", {
      fields: { consent: "Consent is required." },
    });
  }
}

/** Writes are open while a requirement that applies to this person is on. */
async function requireOn(userId: string): Promise<void> {
  if ((await audiencesFor(userId)).length === 0) throw notFound("Identity verification");
}

type RowWrite = Partial<Omit<typeof identityVerifications.$inferInsert, "id" | "userId">>;

/** A new attempt: any open one is closed first (one PENDING row per user). */
async function newAttempt(
  userId: string,
  values: RowWrite & Pick<typeof identityVerifications.$inferInsert, "method" | "maskedId" | "provider">,
  consent: IdentityConsent,
): Promise<IdentityVerification> {
  const now = new Date();
  const subject: IdentitySubject = (await ownsAnyShop(userId)) ? "SHOP_OWNER" : "CUSTOMER";
  return db.transaction(async (tx) => {
    await tx
      .update(identityVerifications)
      .set({ status: "FAILED", errorCode: "superseded", sessionUrl: null, updatedAt: now })
      .where(and(eq(identityVerifications.userId, userId), eq(identityVerifications.status, "PENDING")));
    const [row] = await tx
      .insert(identityVerifications)
      .values({
        userId,
        subject,
        status: "PENDING",
        consentAt: now,
        consentVersion: IDENTITY_CONSENT_VERSION,
        consentIp: consent.ipAddress?.slice(0, 100) ?? null,
        consentUserAgent: consent.userAgent?.slice(0, 400) ?? null,
        ...values,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row;
  });
}

async function audit(row: IdentityVerification, actorId: string | null, step: string): Promise<void> {
  await recordAudit({
    actorId,
    action: AUDIT_ACTIONS.IDENTITY_VERIFICATION_CHECKED,
    entityType: "user",
    entityId: row.userId,
    newValue: {
      verificationId: row.id,
      step,
      method: row.method,
      status: row.status,
      maskedId: row.maskedId,
      errorCode: row.errorCode,
      provider: row.provider,
      nameMatchResult: row.nameMatchResult,
      consentVersion: row.consentVersion,
    },
  });
}

/** The names a verified name is compared with: the account name; for a shop owner also each shop's owner and registered name. */
async function namesToCompare(userId: string): Promise<string[]> {
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const owned = await db
    .select({ ownerName: shops.ownerName, name: shops.name })
    .from(shops)
    .where(and(eq(shops.ownerId, userId), isNull(shops.deletedAt)));
  return [user?.name, ...owned.flatMap((s) => [s.ownerName, s.name])].filter((n): n is string => Boolean(n && n.trim()));
}

/** Another account already holds a VERIFIED identity with this token. */
async function verifiedElsewhere(userId: string, method: IdentityVerificationMethod, token: string): Promise<boolean> {
  const [row] = await db
    .select({ id: identityVerifications.id })
    .from(identityVerifications)
    .where(
      and(
        eq(identityVerifications.method, method),
        eq(identityVerifications.idToken, token),
        eq(identityVerifications.status, "VERIFIED"),
        ne(identityVerifications.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Verified, or waiting for an admin: name match and duplicate check on a name the provider confirmed. */
async function decide(
  userId: string,
  method: IdentityVerificationMethod,
  verifiedName: string | null,
  token: string | null,
  now: Date,
): Promise<RowWrite> {
  const { nameMatchThreshold } = await getRule("identityVerification");
  if (token && (await verifiedElsewhere(userId, method, token))) {
    return { status: "NAME_MISMATCH_REVIEW", errorCode: "duplicate_identity", verifiedName };
  }
  // The provider gave no name (the mock's plain "approve"): nothing to compare, as for riders.
  if (!verifiedName) return { status: "VERIFIED", nameMatchResult: "NO_NAME", nameMatchScore: null, errorCode: null, verifiedAt: now };
  const names = await namesToCompare(userId);
  if (names.length === 0) {
    return { status: "NAME_MISMATCH_REVIEW", verifiedName, nameMatchResult: "MISMATCH", nameMatchScore: 0, errorCode: "no_account_name" };
  }
  const best = bestNameMatch([verifiedName], names);
  const matched = best.score >= nameMatchThreshold;
  return {
    status: matched ? "VERIFIED" : "NAME_MISMATCH_REVIEW",
    verifiedName,
    comparedName: best.shopName ?? names[0],
    nameMatchScore: best.score,
    nameMatchResult: matched ? "MATCH" : "MISMATCH",
    errorCode: matched ? null : "name_mismatch",
    verifiedAt: matched ? now : null,
  };
}

async function afterSettled(before: IdentityVerification, row: IdentityVerification, actorId: string | null, step: string, tell: boolean): Promise<void> {
  if (row.status === before.status && row.errorCode === before.errorCode) return;
  await audit(row, actorId, step);
  const final = row.status !== "PENDING";
  if (final && tell) {
    await notify({
      userId: row.userId,
      type: NOTIFICATION_TYPES.IDENTITY_VERIFICATION_DECIDED,
      title:
        row.status === "VERIFIED"
          ? "Your identity is verified"
          : row.status === "NAME_MISMATCH_REVIEW"
            ? "Your identity check is being reviewed"
            : "Your identity could not be verified",
      body: row.status === "VERIFIED" ? `Verified (${row.maskedId}). You won't be asked again.` : (identityReason(row.errorCode) ?? "Open the page to try again."),
      actionUrl: PAGE,
    });
  }
  if (row.status === "VERIFIED") await releasePendingShops(row.userId);
  // docs/flows-v3 (flag flow_f17): a check sent to a person's review opens a support ticket (once per attempt).
  if (row.status === "NAME_MISMATCH_REVIEW") {
    await systemTicketHook("IDENTITY_REVIEW", row.id, {
      subject: "Identity check needs review",
      description: `An identity check (${row.method}) needs a person's review${row.errorCode ? ` (${row.errorCode})` : ""}. Decide it in Admin → Identity verification.`,
    });
  }
}

/** A newly verified shop owner: their shops waiting only for this may now go live (best-effort). */
async function releasePendingShops(userId: string): Promise<void> {
  try {
    const pending = await db
      .select({ id: shops.id })
      .from(shops)
      .where(and(eq(shops.ownerId, userId), eq(shops.status, "PENDING_APPROVAL"), isNull(shops.deletedAt)));
    if (pending.length === 0) return;
    const { autoApproveShopIfReady } = await import("./shops");
    for (const shop of pending) await autoApproveShopIfReady(shop.id);
  } catch (error) {
    console.error("[identity] releasing pending shops failed:", redactIdentityNumbers(String(error)));
  }
}

/* --------------------------------------------------------- Aadhaar by DigiLocker */

export interface IdentityDigilockerStart {
  verification: IdentityVerificationView;
  /** The DigiLocker page to open; null when there is nothing to open (already verified, or the provider can't). */
  url: string | null;
}

/** "Verify with Aadhaar (DigiLocker)": after consent, a DigiLocker link. `app`: the app build's URL scheme, in the app. */
export async function startIdentityDigilocker(userId: string, input: IdentityConsent & { app?: string | null }): Promise<IdentityDigilockerStart> {
  await requireOn(userId);
  requireConsent(input);
  const verified = await verifiedRowOf(userId);
  if (verified) return { verification: toIdentityView(verified), url: null };
  const app: MobileAppScheme | null = isMobileAppScheme(input.app) ? input.app : null;
  const existing = await latestRow(userId);
  if (
    existing &&
    digilockerOpen(existing) &&
    (existing.sessionExpiresAt?.getTime() ?? 0) - Date.now() > DIGILOCKER_REUSE_MIN_LEFT_MS &&
    digilockerReturnApp(existing.sessionReturnKey) === app
  ) {
    return { verification: toIdentityView(existing), url: existing.sessionUrl };
  }

  const source = await identityProviderSource();
  const opened = await openDigilockerSession(source, `identity-digilocker:${userId}:${randomUUID()}`, app, "identity");
  const session: RowWrite =
    opened.kind === "open"
      ? {
          errorCode: "digilocker_started",
          providerRef: opened.session.providerRef,
          sessionId: opened.session.sessionId,
          sessionStatus: "created",
          sessionUrl: opened.session.authorizationUrl,
          sessionExpiresAt: opened.expiresAt,
          sessionReturnKey: opened.returnKey,
        }
      : // Nothing was opened: the attempt ends here (try again, or use PAN).
        { status: "FAILED", errorCode: opened.kind === "unsupported" ? "vendor_unsupported" : opened.errorCode };
  const row = await newAttempt(
    userId,
    { method: "AADHAAR_DIGILOCKER", maskedId: DIGILOCKER_PENDING_MASK, provider: opened.providerId, ...session },
    input,
  );
  await audit(row, userId, "aadhaar_digilocker_start");
  return { verification: toIdentityView(row), url: row.sessionUrl };
}

export type IdentitySyncTrigger = "poll" | "webhook" | "return";

/**
 * Settles a DigiLocker attempt from the provider's answer. Idempotent: the
 * update applies only while the row is still PENDING on the same session, so
 * the webhook, the return link and polling can all arrive.
 */
export async function syncIdentityDigilocker(row: IdentityVerification, trigger: IdentitySyncTrigger): Promise<IdentityVerification> {
  if (row.method !== "AADHAAR_DIGILOCKER" || row.status !== "PENDING" || !row.sessionId) return row;
  const sessionId = row.sessionId;
  const now = new Date();
  const source: DigilockerSource = row.provider === "mock" ? "mock" : "kyc_provider";

  let set: RowWrite;
  try {
    const resolved = await resolveDigilockerSession(source, sessionId, row.sessionExpiresAt, now);
    if (resolved.kind === "unsupported") set = { status: "FAILED", errorCode: "vendor_unsupported" };
    else if (resolved.kind === "waiting") set = { errorCode: "digilocker_started", sessionStatus: "created" };
    else if (resolved.kind === "failed") {
      set = {
        status: "FAILED",
        errorCode: resolved.errorCode,
        sessionStatus: resolved.sessionStatus,
        ...(resolved.providerRef !== undefined ? { providerRef: resolved.providerRef } : {}),
      };
    } else {
      const base: RowWrite = { sessionStatus: "succeeded", providerRef: resolved.providerRef, verifiedName: resolved.name };
      if (!resolved.holderId || !resolved.last4) {
        set = {
          ...base,
          maskedId: resolved.last4 ? maskAadhaarLast4(resolved.last4) : DIGILOCKER_PENDING_MASK,
          ...(resolved.holderId ? { idToken: docBlindIndex("IDENTITY_AADHAAR_DIGILOCKER", resolved.holderId) } : {}),
          status: "NAME_MISMATCH_REVIEW",
          errorCode: "digilocker_unreadable",
        };
      } else {
        // DigiLocker's account id, keyed — the Aadhaar number itself never reaches us.
        const token = docBlindIndex("IDENTITY_AADHAAR_DIGILOCKER", resolved.holderId);
        set = { ...base, maskedId: maskAadhaarLast4(resolved.last4), idToken: token, ...(await decide(row.userId, row.method, resolved.name, token, now)) };
      }
    }
  } catch (error) {
    // A provider outage leaves the attempt open; it is asked again later.
    set = { errorCode: digilockerErrorCode(error, row.provider, "sync", "identity") };
  }

  const final = set.status !== undefined && set.status !== "PENDING";
  const [updated] = await db
    .update(identityVerifications)
    .set({ ...set, ...(final ? { sessionUrl: null } : {}), updatedAt: now })
    .where(and(eq(identityVerifications.id, row.id), eq(identityVerifications.sessionId, sessionId), eq(identityVerifications.status, "PENDING")))
    .returning();
  if (!updated) return (await db.query.identityVerifications.findFirst({ where: eq(identityVerifications.id, row.id) })) ?? row;
  await afterSettled(row, updated, updated.userId, `aadhaar_digilocker_${trigger}`, trigger !== "return");
  return updated;
}

/** The person's own polling (the page after coming back from DigiLocker). */
export async function syncMyIdentityDigilocker(userId: string): Promise<IdentityVerificationView | null> {
  await requireOn(userId);
  const row = await latestRow(userId);
  if (!row) return null;
  return toIdentityView(await syncIdentityDigilocker(row, "poll"));
}

/** The provider's session webhook (shared with riders: the route tries the rider check first). */
export async function handleIdentityDigilockerWebhook(sessionId: string): Promise<"settled" | "pending" | "unknown_session"> {
  const row = await db.query.identityVerifications.findFirst({ where: eq(identityVerifications.sessionId, sessionId) });
  if (!row) return "unknown_session";
  const settled = await syncIdentityDigilocker(row, "webhook");
  return settled.status === "PENDING" ? "pending" : "settled";
}

/** DigiLocker sent the person back to the shared return link with a key of this flow. */
export async function handleIdentityDigilockerReturn(returnKey: string): Promise<{ status: IdentityVerificationStatus | null; app: MobileAppScheme | null }> {
  if (!isDigilockerReturnKey(returnKey)) return { status: null, app: null };
  const row = await db.query.identityVerifications.findFirst({ where: eq(identityVerifications.sessionReturnKey, returnKey) });
  if (!row) return { status: null, app: null };
  const settled = await syncIdentityDigilocker(row, "return");
  return { status: settled.status, app: digilockerReturnApp(returnKey) };
}

/** The three results the app and the page understand (mobile/src/digilocker.ts digilockerResult). */
export function identityReturnResult(status: IdentityVerificationStatus | null): "verified" | "pending" | "failed" | "unknown" {
  if (status === "VERIFIED") return "verified";
  if (status === "PENDING" || status === "NAME_MISMATCH_REVIEW") return "pending";
  if (status === "FAILED" || status === "REJECTED") return "failed";
  return "unknown";
}

/* ----------------------------------------------------------------------- PAN */

/** The alternative to Aadhaar: the person's own PAN, checked by the provider. Only the last four are kept. */
export async function verifyIdentityWithPan(userId: string, input: IdentityConsent & { pan: string }): Promise<IdentityVerificationView> {
  await requireOn(userId);
  requireConsent(input);
  if (!(await offeredMethods()).pan) throw conflict("Only Aadhaar through DigiLocker is accepted on this site right now.");
  const verified = await verifiedRowOf(userId);
  if (verified) return toIdentityView(verified);

  const parsed = parseSellerDocNumber("PAN", input.pan ?? "");
  if (!parsed.ok) throw validationFailed(redactIdentityNumbers(parsed.error), { fields: { pan: redactIdentityNumbers(parsed.error) } });
  const pan = parsed.value.normalized;
  if (parsed.value.panHolderType !== "P") {
    const message = "Use your own (personal) PAN — the 4th letter of a personal PAN is P.";
    throw validationFailed(message, { fields: { pan: message } });
  }
  const token = docBlindIndex("IDENTITY_PAN", pan);
  const maskedId = maskPanLast4(pan);
  const source = await identityProviderSource();
  const names = await namesToCompare(userId);
  const result = await verifyDocument("PAN", pan, { nameToMatch: names[0] }, `identity-pan:${userId}:${randomUUID()}`, { source });

  const now = new Date();
  let set: RowWrite;
  if (result.status === "VERIFIED") set = await decide(userId, "PAN", result.matchedName, token, now);
  else if (result.status === "MANUAL_REVIEW") set = { status: "NAME_MISMATCH_REVIEW", verifiedName: result.matchedName, errorCode: result.errorCode ?? "manual_review" };
  else set = { status: "FAILED", errorCode: result.errorCode ?? "not_found_at_source" };

  const row = await newAttempt(userId, { method: "PAN", maskedId, idToken: token, provider: result.providerId, providerRef: result.rawRef, ...set }, input);
  const pendingBefore = { ...row, status: "PENDING" as const, errorCode: null };
  await afterSettled(pendingBefore, row, userId, "pan", false);
  return toIdentityView(row);
}

/* --------------------------------------------------------------------- admin */

export interface IdentityReviewItem extends IdentityVerificationView {
  userId: string;
  userName: string | null;
  userEmail: string;
  subject: IdentitySubject;
  provider: string;
  comparedName: string | null;
  nameMatchScore: number | null;
  errorCode: string | null;
  consentVersion: string;
  consentAt: Date;
  reviewNote: string | null;
  reviewedAt: Date | null;
}

function requireAdmin(actor: Actor): void {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can review identity checks.");
}

export async function listIdentityReviews(actor: Actor, status: IdentityVerificationStatus = "NAME_MISMATCH_REVIEW"): Promise<IdentityReviewItem[]> {
  requireAdmin(actor);
  const rows = await db
    .select({ row: identityVerifications, name: users.name, email: users.email })
    .from(identityVerifications)
    .innerJoin(users, eq(users.id, identityVerifications.userId))
    .where(eq(identityVerifications.status, status))
    .orderBy(desc(identityVerifications.updatedAt))
    .limit(300);
  return rows.map(({ row, name, email }) => ({
    ...toIdentityView(row),
    userId: row.userId,
    userName: name,
    userEmail: email,
    subject: row.subject,
    provider: row.provider,
    comparedName: row.comparedName,
    nameMatchScore: row.nameMatchScore,
    errorCode: row.errorCode,
    consentVersion: row.consentVersion,
    consentAt: row.consentAt,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt,
  }));
}

/** An admin approves (VERIFIED) or rejects (REJECTED) a check waiting for review. Audited; the person is told. */
export async function decideIdentityReview(id: string, decision: "APPROVE" | "REJECT", note: string, actor: Actor): Promise<IdentityVerificationView> {
  requireAdmin(actor);
  const why = note?.trim() ?? "";
  if (why.length < 3) throw validationFailed("Say why, for the record.", { fields: { note: "Say why, for the record." } });
  const current = await db.query.identityVerifications.findFirst({ where: eq(identityVerifications.id, id) });
  if (!current) throw notFound("Identity check");
  if (current.status !== "NAME_MISMATCH_REVIEW") throw conflict("Only a check waiting for review can be decided.");
  if (decision === "APPROVE" && (await isIdentityVerified(current.userId))) throw conflict("This person is already verified.");
  if (decision === "APPROVE" && current.idToken && (await verifiedElsewhere(current.userId, current.method, current.idToken))) {
    throw conflict("This identity is already verified on another account. Reject this check, or reject the other one first.");
  }
  const now = new Date();
  const status = decision === "APPROVE" ? "VERIFIED" : "REJECTED";
  const [row] = await db
    .update(identityVerifications)
    .set({ status, verifiedAt: status === "VERIFIED" ? now : null, reviewedBy: actor.id, reviewedAt: now, reviewNote: redactIdentityNumbers(why), updatedAt: now })
    .where(and(eq(identityVerifications.id, id), eq(identityVerifications.status, "NAME_MISMATCH_REVIEW")))
    .returning();
  if (!row) throw conflict("This check was decided meanwhile.");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.IDENTITY_VERIFICATION_DECIDED,
    entityType: "user",
    entityId: row.userId,
    previousValue: { verificationId: row.id, status: current.status, errorCode: current.errorCode },
    newValue: { verificationId: row.id, status, method: row.method, maskedId: row.maskedId, note: row.reviewNote },
  });
  await notify({
    userId: row.userId,
    type: NOTIFICATION_TYPES.IDENTITY_VERIFICATION_DECIDED,
    title: status === "VERIFIED" ? "Your identity is verified" : "Your identity could not be verified",
    body: status === "VERIFIED" ? `Our team verified your identity (${row.maskedId}). You won't be asked again.` : `${row.reviewNote} You can try again with the other method.`,
    actionUrl: PAGE,
  });
  if (status === "VERIFIED") await releasePendingShops(row.userId);
  return toIdentityView(row);
}

/* ---------------------------------------------------- admin users list column */

export type UserIdentityStatus = IdentityVerificationStatus | "NONE";

/** The current identity status of each user (VERIFIED wins; else the latest attempt; NONE without any). */
export async function identityStatusForUsers(userIds: string[]): Promise<Map<string, UserIdentityStatus>> {
  const out = new Map<string, UserIdentityStatus>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: identityVerifications.userId, status: identityVerifications.status, createdAt: identityVerifications.createdAt })
    .from(identityVerifications)
    .where(inArray(identityVerifications.userId, userIds))
    .orderBy(desc(identityVerifications.createdAt));
  for (const r of rows) {
    const had = out.get(r.userId);
    if (r.status === "VERIFIED" || !had) out.set(r.userId, r.status);
  }
  for (const id of userIds) if (!out.has(id)) out.set(id, "NONE");
  return out;
}

/** SQL for the admin users filter: users whose identity status is `status`. */
export function identityStatusFilter(status: UserIdentityStatus) {
  if (status === "VERIFIED") {
    return sql`exists (select 1 from identity_verifications iv where iv.user_id = ${users.id} and iv.status = 'VERIFIED')`;
  }
  if (status === "NONE") return sql`not exists (select 1 from identity_verifications iv where iv.user_id = ${users.id})`;
  return sql`not exists (select 1 from identity_verifications iv where iv.user_id = ${users.id} and iv.status = 'VERIFIED')
    and (select iv.status from identity_verifications iv where iv.user_id = ${users.id} order by iv.created_at desc limit 1) = ${status}`;
}

/* ------------------------------------------------------------- admin status */

export interface IdentityStatusCount {
  subject: IdentitySubject;
  method: IdentityVerificationMethod;
  status: IdentityVerificationStatus;
  count: number;
}

/** Admin → Identity verification → Status: attempts by audience, method and status. */
export async function identityStatusCounts(actor: Actor): Promise<IdentityStatusCount[]> {
  requireAdmin(actor);
  const rows = await db
    .select({
      subject: identityVerifications.subject,
      method: identityVerifications.method,
      status: identityVerifications.status,
      count: sql<number>`count(*)::int`,
    })
    .from(identityVerifications)
    .groupBy(identityVerifications.subject, identityVerifications.method, identityVerifications.status);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}
