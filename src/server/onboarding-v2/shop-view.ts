/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11): what the wizard shows of a v2
 * registration draft (flow_version = 'v2'). Read-only helpers, imported by the wizard's view
 * (services/shop-registration-wizard.ts) — no import of the wizard here, so there is no cycle.
 *
 * v2 order: identity (Terms, e-mail, mobile) → referral → GST / PAN → (owner name) → fee (Shop or Wholesale,
 * paid on the draft) → shop type → licences (enter / upload / scan / later) → address → map pin → seller
 * agreement (the shop row is created here, PENDING) → live. Every time is shown in IST.
 */
import { and, eq, isNull } from "drizzle-orm";

import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { registrationFeeBreakdown } from "@/lib/registration-fee";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import { safeReturnPath } from "@/lib/onboarding-v2/return-to";
import { db, type DbClient } from "@/server/db";
import {
  accounts,
  registrationLicenceEntries,
  shopRegistrationDrafts,
  users,
  type LicenceEntryStatus,
  type LicenceOption,
  type ShopRegistrationDraft,
} from "@/server/db/schema";
import { isLive, listIntentsFor } from "@/server/payments/intents";
import { getRule } from "@/server/services/settings";
import { formatIstStamp } from "./roles";

/**
 * The Terms the owner ticks on the v2 identity screen (recorded with the time, as consent TERMS_AND_PRIVACY).
 * QA D-168: one source of truth — the version every other Terms & Privacy consent records (/signin, the checkout
 * login sheet, consents.ts recordConsent default and hasCurrentConsent): CURRENT_POLICY_VERSION.
 */
export const ONBOARDING_V2_TERMS_VERSION = CURRENT_POLICY_VERSION;
export const DRAFT_FEE_PURPOSE = "SHOP_REGISTRATION_DRAFT_FEE" as const;
export const WHOLESALE_SHOP_TYPE = "WHOLESALE_STORE";
export type V2FeeKind = "SHOP" | "WHOLESALE";

/** What the v2 steps keep in the draft's `details` (besides the wizard's own keys). */
export interface V2DraftDetails {
  v2TermsAcceptedAt?: string;
  v2TermsVersion?: string;
  /** No SMS could be sent and rule onboardingV2.mobileOtpFallbackWhenNoSms let the mobile be saved unverified. */
  v2MobileUnverified?: boolean;
  /** The shop name confirmed on the fee screen (pre-filled from the GST / PAN record). */
  v2ShopName?: string;
  v2Fee?: V2FeeQuote;
  /** /shop/register?return=… — where the owner goes after go-live (same-site path only). */
  v2ReturnTo?: string;
}

export interface V2FeeQuote {
  kind: V2FeeKind;
  basePaise: number;
  gstRateBp: number;
  gstPaise: number;
  totalPaise: number;
}

export interface V2LicenceView {
  key: string;
  label: string;
  level: "MUST_HAVE" | "PROMISE";
  /** A government / reader check exists for this number (FSSAI, Udyam, Shop Act). */
  checkable: boolean;
  /** DEFAULT #12: a must-have licence never offers "Upload later". */
  laterAllowed: boolean;
  entry: {
    option: LicenceOption;
    status: LicenceEntryStatus;
    statusReason: string | null;
    numberMasked: string | null;
    holderName: string | null;
    validUntil: string | null;
    issuingAuthority: string | null;
    hasFile: boolean;
    promisedAt: string | null;
  } | null;
  /** Answered: an entry that is not REJECTED. */
  done: boolean;
}

export interface V2View {
  identity: {
    termsAccepted: boolean;
    termsVersion: string;
    email: string | null;
    emailVerified: boolean;
    /** The account has only a mobile placeholder e-mail: a real one must be added and confirmed. */
    emailMissing: boolean;
    mobile: string | null;
    mobileVerified: boolean;
    /** No SMS and the fallback rule on: the mobile is saved unverified (DEFAULT #8). */
    mobileSavedUnverified: boolean;
    smsAvailable: boolean;
    fallbackWhenNoSms: boolean;
    /** Already a signed-in customer with a verified e-mail and mobile: the screen is skipped. */
    skipped: boolean;
    done: boolean;
  };
  names: { shopName: string | null; ownerName: string | null };
  fee: {
    shop: V2FeeQuote;
    wholesale: V2FeeQuote;
    gstExtra: boolean;
    chosen: V2FeeKind | null;
    paid: boolean;
    paidAt: string | null;
    paidAtIst: string | null;
    paidPaise: number | null;
    /** A checkout is open at the gateway (pending payment). */
    pending: boolean;
    lastFailed: boolean;
  };
  licences: V2LicenceView[];
  promiseDays: number;
  promiseDueLabel: string;
  sla: { accepted: boolean; acceptedAtIst: string | null; agreementsEnabled: boolean; agreementsRequired: boolean };
  returnTo: string | null;
}

export function v2Details(draft: Pick<ShopRegistrationDraft, "details">): V2DraftDetails {
  return ((draft.details as Record<string, unknown> | null) ?? {}) as V2DraftDetails;
}

/** The fee for a kind from rule onboardingV2 (stored before GST; GST on top when feeGstExtra — DEFAULT #9). */
export async function v2FeeQuote(kind: V2FeeKind): Promise<V2FeeQuote> {
  const rule = await getRule("onboardingV2");
  const basePaise = kind === "WHOLESALE" ? rule.wholesaleFeePaise : rule.shopFeePaise;
  const gstRateBp = rule.feeGstExtra ? await (await import("@/server/services/registration-fee-coupons")).registrationFeeGstRateBp() : 0;
  const b = registrationFeeBreakdown(basePaise, 0, gstRateBp);
  return { kind, basePaise, gstRateBp, gstPaise: b.gstPaise, totalPaise: b.totalPaise };
}

/** True while a shop created from a v2 draft waits for its seller agreement (it must not go live before). */
export async function v2SlaPendingForShop(shopId: string, client: DbClient = db): Promise<boolean> {
  const [row] = await client
    .select({ id: shopRegistrationDrafts.id })
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.shopId, shopId), eq(shopRegistrationDrafts.flowVersion, "v2"), isNull(shopRegistrationDrafts.slaAcceptedAt)))
    .limit(1);
  return Boolean(row);
}

const mask = (n: string | null) => (n ? (n.length <= 4 ? n : `${"•".repeat(Math.min(6, n.length - 4))}${n.slice(-4)}`) : null);

export interface V2ViewInput {
  licences: { key: string; label: string; level: "MUST_HAVE" | "PROMISE"; checkable: boolean }[];
  prefillShopName: string | null;
  ownerName: string | null;
  agreementsEnabled: boolean;
  /** Set once the shop row exists: the agreements still to sign (getAgreementStatus().required). */
  agreementsRequired: boolean;
}

/** The v2 part of the wizard's view. Marks the identity step done (identity_verified_at) the first time it is. */
export async function v2ViewOf(draft: ShopRegistrationDraft, input: V2ViewInput): Promise<V2View> {
  const extra = v2Details(draft);
  const rule = await getRule("onboardingV2");
  const [owner] = await db
    .select({ email: users.email, emailVerified: users.emailVerified, emailPlaceholder: users.emailPlaceholder, phoneE164: users.phoneE164, phoneVerifiedAt: users.phoneVerifiedAt })
    .from(users)
    .where(eq(users.id, draft.ownerId));
  const [google] = await db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(and(eq(accounts.userId, draft.ownerId), eq(accounts.provider, "google")))
    .limit(1);
  const emailMissing = !owner?.email || owner.emailPlaceholder || isPlaceholderEmail(owner.email);
  // DEFAULT – confirm with Sanjay: an account signed in with Google counts as a verified e-mail (Google proved it).
  const emailVerified = !emailMissing && (owner?.emailVerified != null || Boolean(google));
  const mobileVerified = owner?.phoneVerifiedAt != null && owner.phoneE164 != null;
  const { guestMobileCodesAvailable } = await import("@/server/otp/service");
  const smsAvailable = await guestMobileCodesAvailable();
  const mobileSavedUnverified = extra.v2MobileUnverified === true && owner?.phoneE164 != null;
  const mobileOk = mobileVerified || (mobileSavedUnverified && !smsAvailable && rule.mobileOtpFallbackWhenNoSms);
  const termsAccepted = typeof extra.v2TermsAcceptedAt === "string";
  const skipped = emailVerified && mobileVerified;
  const identityDone = draft.identityVerifiedAt !== null || skipped || (termsAccepted && emailVerified && mobileOk);
  if (identityDone && draft.identityVerifiedAt === null && draft.status === "OPEN") {
    await db
      .update(shopRegistrationDrafts)
      .set({ identityVerifiedAt: new Date() })
      .where(and(eq(shopRegistrationDrafts.id, draft.id), isNull(shopRegistrationDrafts.identityVerifiedAt)));
  }

  const intents = (await listIntentsFor(DRAFT_FEE_PURPOSE, draft.id)).filter((r) => r.userId === draft.ownerId);
  const latest = intents[0];
  const paid = draft.feePaidAt !== null;
  const [shopQuote, wholesaleQuote] = await Promise.all([v2FeeQuote("SHOP"), v2FeeQuote("WHOLESALE")]);
  const paidIntent = draft.feePaymentIntentId ? intents.find((r) => r.id === draft.feePaymentIntentId) : undefined;

  const entries = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.draftId, draft.id));
  const licences: V2LicenceView[] = input.licences.map((l) => {
    const e = entries.find((x) => x.licenceKey === l.key);
    return {
      key: l.key,
      label: l.label,
      level: l.level,
      checkable: l.checkable,
      laterAllowed: l.level !== "MUST_HAVE",
      entry: e
        ? {
            option: e.option,
            status: e.status,
            statusReason: e.statusReason,
            numberMasked: mask(e.licenceNumber),
            holderName: e.holderName,
            validUntil: e.validUntil,
            issuingAuthority: e.issuingAuthority,
            hasFile: e.fileRef !== null,
            promisedAt: e.promiseAcceptedAt ? formatIstStamp(e.promiseAcceptedAt) : null,
          }
        : null,
      done: Boolean(e && e.status !== "REJECTED"),
    };
  });
  const { promiseDays } = await getRule("shopDocumentFollowUp");
  const { documentsDueLabel } = await import("@/server/services/shop-document-gate");

  return {
    identity: {
      termsAccepted,
      termsVersion: ONBOARDING_V2_TERMS_VERSION,
      email: emailMissing ? null : (owner?.email ?? null),
      emailVerified,
      emailMissing,
      mobile: owner?.phoneE164?.startsWith("+91") ? owner.phoneE164.slice(3) : null,
      mobileVerified,
      mobileSavedUnverified,
      smsAvailable,
      fallbackWhenNoSms: rule.mobileOtpFallbackWhenNoSms,
      skipped,
      done: identityDone,
    },
    names: { shopName: extra.v2ShopName ?? input.prefillShopName, ownerName: input.ownerName },
    fee: {
      shop: shopQuote,
      wholesale: wholesaleQuote,
      gstExtra: rule.feeGstExtra,
      chosen: draft.feeKind,
      paid,
      paidAt: draft.feePaidAt?.toISOString() ?? null,
      paidAtIst: draft.feePaidAt ? formatIstStamp(draft.feePaidAt) : null,
      paidPaise: paid ? (paidIntent?.amountPaise ?? extra.v2Fee?.totalPaise ?? null) : null,
      pending: !paid && Boolean(latest && isLive(latest)),
      lastFailed: !paid && (latest?.status === "FAILED" || latest?.status === "EXPIRED"),
    },
    licences,
    promiseDays,
    promiseDueLabel: documentsDueLabel(new Date(Date.now() + promiseDays * 86_400_000)),
    sla: {
      accepted: draft.slaAcceptedAt !== null,
      acceptedAtIst: draft.slaAcceptedAt ? formatIstStamp(draft.slaAcceptedAt) : null,
      agreementsEnabled: input.agreementsEnabled,
      agreementsRequired: input.agreementsRequired,
    },
    returnTo: safeReturnPath(extra.v2ReturnTo),
  };
}
