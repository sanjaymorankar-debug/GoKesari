/**
 * Onboarding Phase 2, WP7 "One assisted mode" (docs/onboarding-waves-2-3-2026-11;
 * docs/onboarding-benchmark/phase-2/screens-flow-and-implementation-plan.md).
 *
 * A dealer, a dealer's employee or an operator fills in the ordinary registration wizard FOR the
 * owner — the same screens, checks, duplicate rules and fee as the owner alone — when, and only
 * when, the helper holds a valid owner-consent session. The consent sessions already exist and are
 * reused, not copied:
 *
 *   dealer_assisted_sessions   (src/server/dealers/assisted.ts — the owner's one-time code, dealer side)
 *   shop_onboarding_sessions   (services/operator-limited.ts — the same, operator side)
 *
 * A session counts while it is OWNER_VERIFIED, belongs to this helper and this owner, and its
 * consent_expires_at is still ahead.
 *
 *   startAssistedDraft  opens (or claims) the owner's OPEN draft: assisted_by_user_id, assisted_role,
 *                       assisted_session_id are written, and the helper's referral code is put on
 *                       the draft and locked (answerDraftReferral refuses another one).
 *   actingOwnerFor      the `(actor, ownerId)` path of the wizard routes (api/wizard-actor.ts): returns
 *                       the owner as the wizard's actor while the helper's consent holds and the draft
 *                       is the helper's. Every assisted change is in the audit log.
 *   assistedFeeLink     the owner pays on their own phone: a payment link (and its QR) for what is due,
 *                       sent to the owner too. The helper never pays and never sees card details.
 *
 * Flag onboarding_assisted_mode_enabled OFF: every function here refuses (404) and no draft gets the
 * columns, so the wizard and the dealer / operator flat forms behave exactly as before.
 */
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import QRCode from "qrcode";

import { conflict, forbidden, notFound } from "@/lib/errors";
import type { AuthenticatedUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import {
  dealerAssistedSessions,
  dealerSalespeople,
  dealers,
  shopOnboardingSessions,
  shopRegistrationDrafts,
  shops,
  users,
  type ShopRegistrationDraft,
  type UserRole,
} from "@/server/db/schema";
import { activeCodeFor } from "@/server/dealers/codes";
import { emitEvent } from "@/server/events/emit";
import { createPaymentIntent, isLive, listIntentsFor } from "@/server/payments/intents";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { featureNotAvailable, isFeatureEnabled } from "./feature-flags";
import { registrationFeeDue } from "./registration-fee-payment";
import { assertDocumentsAllowPayment } from "./shop-document-gate";
import { assertNoWaitingRegistration, lockOpenDraft } from "./shop-registration-draft";

export const ASSIST_FLAG = "onboarding_assisted_mode_enabled" as const;
export const ASSISTED_ROLES = ["DEALER", "DEALER_EMPLOYEE", "OPERATOR"] as const;
export type AssistedRole = (typeof ASSISTED_ROLES)[number];

/** The roles that may run operator consent sessions (as in operator-limited.ts). */
const OPERATOR_ROLES: readonly UserRole[] = ["OPERATOR_LIMITED", "OPERATIONS_USER", "ADMIN"];

export interface Helper {
  id: string;
  role: UserRole;
}

/** A consent session the helper holds for this owner. */
export interface HelperConsent {
  role: AssistedRole;
  sessionId: string;
  ownerUserId: string;
  consentExpiresAt: Date;
  /** The helper's referral code, locked onto the draft; null when the helper has none (an operator). */
  code: string | null;
}

/** A session row in the shape both consent tables share. */
export interface ConsentRow {
  id: string;
  status: string;
  ownerUserId: string | null;
  consentExpiresAt: Date | null;
}

/** Is this consent row good for this owner now? (OWNER_VERIFIED, this owner, not expired.) */
export function consentIsValid(row: ConsentRow, ownerId: string, now: Date = new Date()): boolean {
  return row.status === "OWNER_VERIFIED" && row.ownerUserId === ownerId && row.consentExpiresAt !== null && row.consentExpiresAt.getTime() > now.getTime();
}

/** The columns an assisted draft gets: who helped, how, under which consent, and the helper's code. */
export function assistedDraftPatch(helper: Helper, consent: HelperConsent, now: Date = new Date()) {
  return {
    assistedByUserId: helper.id,
    assistedRole: consent.role,
    assistedSessionId: consent.sessionId,
    ...(consent.code ? { referralCode: consent.code, referralAnsweredAt: now } : {}),
    updatedAt: now,
  } satisfies Partial<ShopRegistrationDraft>;
}

/**
 * Refuses to claim a draft another helper is filling in, or whose owner already used another code
 * (one code per registration). Null: the draft can be claimed.
 */
export function claimProblem(draft: Pick<ShopRegistrationDraft, "assistedByUserId" | "referralCode" | "referralAnsweredAt">, helper: Helper, consent: HelperConsent): string | null {
  if (draft.assistedByUserId && draft.assistedByUserId !== helper.id) return "Someone else is already helping this owner with the registration.";
  if (consent.code && draft.referralAnsweredAt && draft.referralCode && draft.referralCode !== consent.code) {
    return `The owner already entered referral code ${draft.referralCode}; only one code can be used.`;
  }
  return null;
}

async function requireAssistedMode(): Promise<void> {
  if (!(await isFeatureEnabled(ASSIST_FLAG))) throw featureNotAvailable(ASSIST_FLAG);
}

/** The newest valid consent session this helper holds for this owner, dealer side first; null when none. */
export async function findHelperConsent(helper: Helper, ownerId: string, now: Date = new Date()): Promise<HelperConsent | null> {
  // Dealer side: the dealer's own account, or an active employee's account on a session made for that employee.
  const dealerRows = await db
    .select({
      id: dealerAssistedSessions.id,
      status: dealerAssistedSessions.status,
      ownerUserId: dealerAssistedSessions.ownerUserId,
      consentExpiresAt: dealerAssistedSessions.consentExpiresAt,
      dealerId: dealerAssistedSessions.dealerId,
      salespersonId: dealerAssistedSessions.salespersonId,
      dealerUserId: dealers.userId,
      dealerStatus: dealers.status,
    })
    .from(dealerAssistedSessions)
    .innerJoin(dealers, eq(dealers.id, dealerAssistedSessions.dealerId))
    .where(and(eq(dealerAssistedSessions.ownerUserId, ownerId), eq(dealerAssistedSessions.status, "OWNER_VERIFIED"), gt(dealerAssistedSessions.consentExpiresAt, now)))
    .orderBy(desc(dealerAssistedSessions.verifiedAt));
  for (const row of dealerRows) {
    if (row.dealerStatus !== "APPROVED" || !consentIsValid(row, ownerId, now)) continue;
    let role: AssistedRole | null = row.dealerUserId === helper.id ? "DEALER" : null;
    if (!role && row.salespersonId) {
      const [person] = await db
        .select({ userId: dealerSalespeople.userId, status: dealerSalespeople.status })
        .from(dealerSalespeople)
        .where(and(eq(dealerSalespeople.id, row.salespersonId), eq(dealerSalespeople.dealerId, row.dealerId)));
      if (person?.userId === helper.id && person.status === "ACTIVE") role = "DEALER_EMPLOYEE";
    }
    if (!role) continue;
    const code = (await activeCodeFor(row.dealerId, row.salespersonId)) ?? (await activeCodeFor(row.dealerId, null));
    return { role, sessionId: row.id, ownerUserId: ownerId, consentExpiresAt: row.consentExpiresAt!, code };
  }
  // Operator side.
  if (OPERATOR_ROLES.includes(helper.role)) {
    const [row] = await db
      .select()
      .from(shopOnboardingSessions)
      .where(
        and(
          eq(shopOnboardingSessions.operatorId, helper.id),
          eq(shopOnboardingSessions.ownerUserId, ownerId),
          eq(shopOnboardingSessions.status, "OWNER_VERIFIED"),
          gt(shopOnboardingSessions.consentExpiresAt, now),
        ),
      )
      .orderBy(desc(shopOnboardingSessions.otpVerifiedAt))
      .limit(1);
    if (row && consentIsValid(row, ownerId, now)) {
      return { role: "OPERATOR", sessionId: row.id, ownerUserId: ownerId, consentExpiresAt: row.consentExpiresAt!, code: row.referralCode?.trim().toUpperCase() || null };
    }
  }
  return null;
}

async function requireConsent(helper: Helper, ownerId: string): Promise<HelperConsent> {
  const consent = await findHelperConsent(helper, ownerId);
  if (!consent) {
    await recordAudit({ actorId: helper.id, actorRole: helper.role, action: AUDIT_ACTIONS.ONBOARDING_ASSISTED_STEP, entityType: "user", entityId: ownerId, newValue: { step: "REFUSED", reason: "no_valid_consent" } });
    throw forbidden("The owner has not given consent, or it has expired. Send the code to the owner and enter it first.");
  }
  return consent;
}

/** The owner's latest registration draft (OPEN first); null when none. */
async function latestDraft(ownerId: string): Promise<ShopRegistrationDraft | null> {
  const rows = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), inArray(shopRegistrationDrafts.status, ["OPEN", "SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt));
  return rows.find((d) => d.status === "OPEN") ?? rows[0] ?? null;
}

/** Opens (or claims) the owner's OPEN draft for the helper, with the helper's code locked on it. */
export async function startAssistedDraft(helper: Helper, ownerId: string): Promise<{ draftId: string; role: AssistedRole; code: string | null }> {
  await requireAssistedMode();
  const consent = await requireConsent(helper, ownerId);
  await assertNoWaitingRegistration(ownerId);
  const draft = await db.transaction(async (tx) => {
    const locked = await lockOpenDraft(tx, ownerId);
    const problem = claimProblem(locked, helper, consent);
    if (problem) throw conflict(problem, { reason: "ASSISTED_DRAFT_TAKEN" });
    const [updated] = await tx.update(shopRegistrationDrafts).set(assistedDraftPatch(helper, consent)).where(eq(shopRegistrationDrafts.id, locked.id)).returning();
    await recordAudit(
      {
        actorId: helper.id,
        actorRole: helper.role,
        action: AUDIT_ACTIONS.ONBOARDING_ASSISTED_STEP,
        entityType: "shop_registration_draft",
        entityId: locked.id,
        newValue: { step: "STARTED", ownerId, assistedRole: consent.role, sessionId: consent.sessionId, code: consent.code },
      },
      tx,
    );
    return updated;
  });
  return { draftId: draft.id, role: consent.role, code: consent.code };
}

/**
 * The wizard's `(actor, ownerId)` path: the owner, as the wizard's actor, for a helper who holds a
 * valid consent and is the one helping on the owner's draft. A change (anything but a read) is
 * written to the audit log with the route it went through.
 */
export async function actingOwnerFor(helper: Helper, ownerId: string, context: { path: string; method: string }): Promise<AuthenticatedUser> {
  await requireAssistedMode();
  const consent = await requireConsent(helper, ownerId);
  const draft = await latestDraft(ownerId);
  if (!draft || draft.assistedByUserId !== helper.id) throw forbidden("Start the assisted registration for this owner first.");
  const [owner] = await db.select({ id: users.id, email: users.email, name: users.name, image: users.image, role: users.role }).from(users).where(eq(users.id, ownerId));
  if (!owner) throw notFound("Owner");
  if (!can(owner.role, PERMISSIONS.SHOP_CREATE)) throw forbidden("This account cannot register a shop.");
  if (context.method !== "GET") {
    await recordAudit({
      actorId: helper.id,
      actorRole: helper.role,
      action: AUDIT_ACTIONS.ONBOARDING_ASSISTED_STEP,
      entityType: "shop_registration_draft",
      entityId: draft.id,
      newValue: { step: "WIZARD", path: context.path.slice(0, 200), method: context.method, ownerId, assistedRole: consent.role, sessionId: consent.sessionId },
    });
  }
  return { id: owner.id, email: owner.email, name: owner.name, image: owner.image ?? null, role: owner.role };
}

export interface AssistedFeeLink {
  shopId: string;
  amountPaise: number;
  linkUrl: string;
  /** The same link as a QR code (SVG) for the owner to scan with their own phone. */
  qrSvg: string;
  expiresAt: Date | null;
  /** False when an open link for the same amount was handed out again (pressing twice never makes two). */
  created: boolean;
}

/**
 * The owner pays the registration fee on their own phone: a payment link for what is due on the
 * shop the helper's assisted draft created, also sent to the owner (in-app + e-mail). The capture
 * is the ordinary SHOP_REGISTRATION_FEE handler, so approval and ledger are unchanged.
 */
export async function assistedFeeLink(helper: Helper, ownerId: string): Promise<AssistedFeeLink> {
  await requireAssistedMode();
  const [draft] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.assistedByUserId, helper.id), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt))
    .limit(1);
  if (!draft?.shopId) throw conflict("Create the shop in the wizard first; the fee link is for a shop that exists.");
  const [shop] = await db.select().from(shops).where(eq(shops.id, draft.shopId));
  if (!shop || shop.ownerId !== ownerId) throw notFound("Shop");
  const due = registrationFeeDue(shop);
  if (due === 0) throw conflict("Nothing is due: the registration fee is already settled.");
  await assertDocumentsAllowPayment(shop);

  const previous = await listIntentsFor("SHOP_REGISTRATION_FEE", shop.id);
  const open = previous.find((row) => isLive(row) && row.mode === "LINK" && row.userId === ownerId && row.amountPaise === due && row.linkUrl);
  let linkUrl = open?.linkUrl ?? null;
  let expiresAt = open?.expiresAt ?? null;
  let intentId = open?.id ?? null;
  if (!linkUrl) {
    const [owner] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, ownerId));
    const made = await createPaymentIntent({
      purpose: "SHOP_REGISTRATION_FEE",
      referenceId: shop.id,
      userId: ownerId,
      amountPaise: due,
      customer: { id: ownerId, name: owner?.name ?? shop.ownerName, email: owner?.email || shop.email, phone: shop.phone },
      description: `GoKesari registration fee — ${shop.name}`,
      // Same attempt → same intent; after a failed or expired one the count has moved on.
      idempotencyKey: `shop-registration-fee:assisted:${shop.id}:${previous.length}`,
      mode: "LINK",
      returnPath: `/shop/registration-fee?shop=${shop.id}`,
    });
    if (!made.linkUrl) throw conflict("A payment link cannot be made right now. The owner can pay from My shop → Registration fee.");
    linkUrl = made.linkUrl;
    intentId = made.intent.id;
    const [row] = (await listIntentsFor("SHOP_REGISTRATION_FEE", shop.id)).filter((r) => r.id === made.intent.id);
    expiresAt = row?.expiresAt ?? null;
    // After the intent is stored, outside any transaction: the owner gets the link in-app and by e-mail.
    await emitEvent({
      type: "shop.registration_fee_link_sent",
      subjectId: shop.id,
      actor: { id: helper.id, role: helper.role },
      payload: {
        shopName: shop.name,
        ownerId,
        amountPaise: due,
        link: linkUrl,
        expiresAt: expiresAt ? expiresAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "",
      },
      idempotencyKey: `shop-fee-link:${made.intent.id}`,
    });
  }
  const qrSvg = await QRCode.toString(linkUrl, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 240 });
  await recordAudit({
    actorId: helper.id,
    actorRole: helper.role,
    action: AUDIT_ACTIONS.ONBOARDING_ASSISTED_STEP,
    entityType: "shop",
    entityId: shop.id,
    newValue: { step: "FEE_LINK", ownerId, draftId: draft.id, amountPaise: due, intentId, reused: Boolean(open) },
  });
  return { shopId: shop.id, amountPaise: due, linkUrl, qrSvg, expiresAt, created: !open };
}
