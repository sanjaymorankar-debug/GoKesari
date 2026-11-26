/**
 * Onboarding v2, Flow 2 — shop onboarding (docs/onboarding-v2-2026-11): what the wizard shows of a v2
 * registration draft (flow_version = 'v2'). Read-only helpers, imported by the wizard's view
 * (services/shop-registration-wizard.ts) — no import of the wizard here, so there is no cycle.
 *
 * v2 order: identity (Terms, e-mail, mobile) → referral → GST / PAN → (owner name) → fee (the annual turnover band
 * of the original wizard and its slab fee + GST, owner 27-Nov-2026; paid on the draft) → shop type → licences (enter / upload / scan / later) → address → map pin → seller
 * agreement (the shop row is created here, PENDING) → live. Every time is shown in IST.
 */
import { and, eq, isNull } from "drizzle-orm";

import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { conflict, validationFailed } from "@/lib/errors";
import { registrationFeeBreakdown, turnoverForSlab, turnoverSlabLabel } from "@/lib/registration-fee";
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
/** Drafts that chose a fee kind before the owner's 27-Nov-2026 decision (fee_kind column; new drafts leave it null). */
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

/**
 * What a v2 draft-fee checkout charges (kept in the checkout's metadata and on the draft; the capture applies exactly
 * this). Owner, 27-Nov-2026: the original registration fee — the turnover slab of rule registrationFeeByTurnover
 * (₹999 / ₹4,999 / ₹9,999 by default) or the flat fee when that rule is off — less an optional registration-fee
 * coupon, plus GST, computed by quoteRegistrationFee as the original wizard's fee is.
 */
export interface V2FeeQuote {
  /** The turnover slab chosen (1…); null when rule registrationFeeByTurnover is off (the flat fee). */
  slab: number | null;
  slabLabel: string | null;
  /** The turnover recorded on the shop for that slab (turnoverForSlab), as the original wizard sends it. */
  turnoverRupees: number | null;
  basePaise: number;
  discountPaise: number;
  couponCode: string | null;
  couponId: string | null;
  gstRateBp: number;
  gstPaise: number;
  totalPaise: number;
  /** Only on quotes made before 27-Nov-2026 (fee by kind). */
  kind?: V2FeeKind;
}

/** One turnover band on the fee screen, with its fee before and after GST (no coupon). */
export interface V2FeeSlab {
  slab: number;
  label: string;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
}

export interface V2LicenceView {
  key: string;
  label: string;
  level: "MUST_HAVE" | "PROMISE";
  /** A government / reader check exists for this number (FSSAI, Udyam, Shop Act). */
  checkable: boolean;
  /** Owner, 27-Nov-2026: every licence offers "Upload later" (must-have ones too, within the follow-up's period). */
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
    /** Rule registrationFeeByTurnover on: the owner picks a turnover band (the original wizard's slabs). */
    byTurnover: boolean;
    slabs: V2FeeSlab[];
    /** Rule off: the flat fee (+ GST). */
    flat: { basePaise: number; gstPaise: number; totalPaise: number } | null;
    /** The band (and coupon) of the last quote on this draft. */
    chosenSlab: number | null;
    couponCode: string | null;
    /** A draft that paid the wholesale fee before 27-Nov-2026: its shop type stays Wholesale store. */
    legacyWholesale: boolean;
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

/**
 * The v2 fee (owner, 27-Nov-2026: "keep the original fees as it is"): the turnover band's slab fee (rule
 * registrationFeeByTurnover) or the flat fee when that rule is off, less a registration-fee coupon, plus GST — the
 * same quoteRegistrationFee the original wizard's fee uses. Wholesale shops pay the same slabs.
 */
export async function v2FeeQuote(input: { ownerId: string; slab: number | null; couponCode?: string | null }): Promise<V2FeeQuote> {
  const rule = await getRule("registrationFeeByTurnover");
  let slab: number | null = null;
  if (rule.enabled) {
    if (input.slab == null) {
      throw validationFailed("Please check the highlighted fields.", { fields: { annualTurnover: "Enter your annual turnover — it sets the registration fee." } });
    }
    if (!Number.isInteger(input.slab) || input.slab < 1 || input.slab > rule.slabs.length) {
      throw conflict("The turnover bands have changed. Please choose yours again.", { fields: { annualTurnover: "Choose your annual turnover." } });
    }
    slab = input.slab;
  }
  const turnoverRupees = slab === null ? null : turnoverForSlab(slab, rule);
  const coupons = await import("@/server/services/registration-fee-coupons");
  const q = await coupons.quoteRegistrationFee({ ownerId: input.ownerId, couponCode: input.couponCode ?? null, turnoverRupees });
  const couponId = q.couponCode ? ((await coupons.findRegistrationFeeCouponId(q.couponCode)) ?? null) : null;
  return {
    slab,
    slabLabel: slab === null ? null : turnoverSlabLabel(slab, rule),
    turnoverRupees,
    basePaise: q.basePaise,
    discountPaise: q.discountPaise,
    couponCode: q.couponCode,
    couponId,
    gstRateBp: q.gstRateBp,
    gstPaise: q.gstPaise,
    totalPaise: q.totalPaise,
  };
}

/** The fee screen's bands (or the flat fee), before any coupon. */
async function v2FeeOptions(): Promise<{ byTurnover: boolean; slabs: V2FeeSlab[]; flat: V2View["fee"]["flat"] }> {
  const rule = await getRule("registrationFeeByTurnover");
  const coupons = await import("@/server/services/registration-fee-coupons");
  const gstRateBp = await coupons.registrationFeeGstRateBp();
  if (rule.enabled) {
    return {
      byTurnover: true,
      flat: null,
      slabs: rule.slabs.map((s, i) => {
        const b = registrationFeeBreakdown(s.feePaise, 0, gstRateBp);
        return { slab: i + 1, label: turnoverSlabLabel(i + 1, rule), basePaise: s.feePaise, gstPaise: b.gstPaise, totalPaise: b.totalPaise };
      }),
    };
  }
  const { basePaise } = await coupons.baseRegistrationFee(null);
  const b = registrationFeeBreakdown(basePaise, 0, gstRateBp);
  return { byTurnover: false, slabs: [], flat: { basePaise, gstPaise: b.gstPaise, totalPaise: b.totalPaise } };
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
  const feeOptions = await v2FeeOptions();
  const paidIntent = draft.feePaymentIntentId ? intents.find((r) => r.id === draft.feePaymentIntentId) : undefined;

  const entries = await db.select().from(registrationLicenceEntries).where(eq(registrationLicenceEntries.draftId, draft.id));
  const licences: V2LicenceView[] = input.licences.map((l) => {
    const e = entries.find((x) => x.licenceKey === l.key);
    return {
      key: l.key,
      label: l.label,
      level: l.level,
      checkable: l.checkable,
      laterAllowed: true,
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
      ...feeOptions,
      chosenSlab: extra.v2Fee?.slab ?? null,
      couponCode: extra.v2Fee?.couponCode ?? null,
      legacyWholesale: draft.feeKind === "WHOLESALE" && draft.feePaidAt !== null,
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
