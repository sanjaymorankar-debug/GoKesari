/**
 * Owner brief 08-Nov-2026 (docs/shop-onboarding-identity-first-2026-11/BRIEF.md) — identity first:
 *
 *   IDENTITY  "Verify your business": the referral code and "Do you have a GST number?" on one
 *             screen. Yes → the GSTIN (its PAN is taken from it); No → the PAN. The owner goes
 *             on only once it is VERIFIED.
 *   EMAIL     only for an account with no email (mobile-only)
 *   OWNER     only when the record gave no owner name (a company's GSTIN, a firm's PAN)
 *   ADDRESS   "Confirm your shop address", pre-filled from the GST (or PAN) record
 *   PIN       "Mark your shop location on the map" — before payment now
 *   SHOP      shop name (pre-filled from the GST trade / legal name), type, phone, turnover
 *   FSSAI     a food shop's licence (the law)
 *   REVIEW → PAYMENT → WAITING; then LIVE ("Your onboarding is complete…" and Add Products),
 *   CATEGORY and PRODUCTS, DONE.
 *
 * "Upload later", the separate referral and Udyam screens and the map pin after payment are gone
 * (they reversed FLOW_2026-10-30.md and -b.md). Udyam and the Shop Act are added on Documents
 * after go-live. A registration left for a week starts again at IDENTITY (Flow 2).
 *
 * The history below is the earlier design, kept for the reasoning behind each step.
 *
 * Onboarding wizard, step 2 (docs/shop-onboarding-wizard-2026-10): everything
 * after the GSTIN / PAN step, on the owner's draft, in the brief's order (owner
 * decision 29 Oct 2026, "follow the brief"; BRIEF_REDESIGN.md) — opened, since
 * the owner's brief of 30 Oct 2026 (FLOW_2026-10-30.md, 0120), by
 *
 *   REFERRAL  the referral code (mandatory or optional by the admin's setting)
 *   EMAIL     the shop's email: the account's, or another one confirmed with an
 *             emailed code
 *   DOCS_READY "Do you have your documents handy?" Yes → the checks below
 *             (typed, or read from a photo on the device); No → "upload later":
 *             DETAILS → (FSSAI for a food shop) → REVIEW, and the shop
 *             goes live on payment with its payouts held until the GSTIN or PAN
 *             is verified (finance.ts)
 *
 *   UDYAM     "Do you have Udyam?" → government check (optional)
 *   FSSAI     "Do you have FSSAI?" — asked of every shop, mandatory for a food
 *             shop type → government check (expiry, premises PIN). A food shop
 *             type chosen later sends the owner back here.
 *   DETAILS   shop type, phone, turnover (the fee slab from the admin's rule
 *             table); name and address pre-filled from the GST record
 *   REVIEW    the fee and "Create my shop and pay": allowed once the GSTIN — or
 *             the PAN without one — is verified. The shop is created from the
 *             draft (registerShop, with its duplicate checks and fee snapshot)
 *             and, in the same transaction, every check is copied to
 *             seller_verifications with the vendor's reference
 *   PAYMENT   the existing registration-fee checkout (Cashfree). Not paid, or
 *             the payment failed: the shop is pending admin approval; the owner
 *             can still shop as a customer, and the shop gets no orders
 *   WAITING   paid, but something approval needs is not verified yet (FSSAI of
 *             a food shop, a shop-type licence, a likely duplicate)
 *   LOCATION, CATEGORY, PRODUCTS  after approval (the "ready for product
 *             upload" email has gone): the map pin, the shop's categories and
 *             the product list, saved on the shop through its own routes
 *   DONE
 *
 * The Shop Act is no longer a wizard step: it is uploaded on Documents after
 * go-live, and the 1st / 15th follow-up chases it.
 *
 * Same safeguards as step 1: format check before any paid call, explicit
 * consent, the draft row claimed under a lock, a verified number served from
 * the stored result, an identical check in flight joined, the per-draft hourly
 * limit, vendor calls outside every transaction, and a result written only if
 * no newer check claimed the row. Numbers are kept as ciphertext, masked form
 * and blind index; views carry the masked form only.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";

import { GST_DECLARATION_VERSION, SELLER_VERIFICATION_CONSENT_VERSION } from "@/lib/kyc/consent";
import { parseSellerDocNumber, SELLER_DOC_TYPES, type SellerDocType } from "@/lib/kyc/doc-formats";
import { bestNameMatch } from "@/lib/kyc/name-match";
import { conflict, notFound, validationFailed } from "@/lib/errors";
import { decryptSecret, docBlindIndex, encryptSecret } from "@/lib/pan-crypto";
import { isPlaceholderEmail } from "@/lib/placeholder-email";
import type { TurnoverFeeRule } from "@/lib/registration-fee";
import { isFoodBusinessShopType } from "@/lib/shop-types";
import { db, type DbClient } from "@/server/db";
import {
  shopCategoryMapping,
  shopOnboardingSteps,
  shopProducts,
  shopRegistrationDraftChecks,
  shopRegistrationDrafts,
  shops,
  type DraftCheckDocType,
  type Shop,
  type ShopRegistrationDraft,
  type ShopRegistrationDraftCheck,
  type UserRole,
  users,
} from "@/server/db/schema";
import { recordShopAttributionSafely } from "@/server/dealers/attribution";
import { verifyDocument } from "@/server/kyc";
import { requestShopEmailOtp, verifyShopEmailOtp } from "@/server/otp/service";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { featureNotAvailable, isFeatureEnabled } from "./feature-flags";
import { assertRegistrationReferralCode, attributeRegistrationReferral } from "./referral-requests";
import { isReferralRequired } from "./referral-settings";
import { looksLikeShopCode, shopReferralRule } from "./shop-referrals";
import { registrationFeeDue } from "./registration-fee-payment";
import { applyDocumentChecks, type ShopFacts } from "./seller-verification-checks";
import {
  importRegistrationCheck,
  importRegistrationGstDeclaration,
  stateCodeForPincode,
  type RegistrationCheck,
} from "./seller-verification";
import { syncRegistrationReminder } from "./scheduled-notices";
import { getRule } from "./settings";
import {
  assertOwnerExists,
  CAN_CONTINUE,
  countCheck,
  findOpenDraft,
  IN_FLIGHT_WINDOW_MS,
  lockOpenDraft,
  message,
  str,
  toDraftView,
  type Actor,
  type DraftCheckView,
  type ShopRegistrationDraftView,
} from "./shop-registration-draft";
import { assertShopType, loadShopTypeRegistry } from "./shop-types";

import { autoApproveShopIfReady, registerShop } from "./shops";

/* ---------------------------------------------------------------- types */

/** The shop details step. Name and address arrive pre-filled from the GST record; the owner may edit them. */

/* ================================================================ who may use it */

/**
 * The wizard is open to everyone only while shop_onboarding_wizard_enabled is
 * on. While it is off only an admin may use it (testing on staging): a link such
 * as /shop/register?wizard=1 must not open a registration route the owner has
 * not switched on.
 */
export async function wizardAvailableFor(user: { role: UserRole }): Promise<boolean> {
  return user.role === "ADMIN" || (await isFeatureEnabled("shop_onboarding_wizard_enabled"));
}

/** Throws "not available" (404) unless the wizard is open to this user — for the wizard's routes. */
export async function requireWizardAvailable(user: { role: UserRole }): Promise<void> {
  if (!(await wizardAvailableFor(user))) throw featureNotAvailable("shop_onboarding_wizard_enabled");
}

/**
 * Add my shop: the wizard or the long form. ?form=1 always shows the long form;
 * with the flag on everyone gets the wizard; with it off an admin gets it with ?wizard=1.
 */
export async function showsWizard(user: { role: UserRole }, params: { wizard?: string | string[]; form?: string | string[] }): Promise<boolean> {
  if (params.form === "1") return false;
  if (await isFeatureEnabled("shop_onboarding_wizard_enabled")) return true;
  return params.wizard === "1" && user.role === "ADMIN";
}

export interface DraftShopDetails {
  name: string;
  ownerName: string;
  phone: string;
  email: string | null;
  shopType: string;
  categoryIds: string[];
  annualTurnoverRupees: number | null;
  couponCode: string | null;
  referralCode: string | null;
  /** docs/dealer-programme: the dealer's employee who helped, if any. */
  employeeId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string;
  landmark: string | null;
}

/** The ADDRESS step's fields, kept in the draft's details until the SHOP step completes them. */
export interface DraftAddress {
  addressLine1: string;
  addressLine2: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string;
  landmark: string | null;
}

/** What the draft holds before the SHOP step: the owner name and address, saved on their own steps. */
type PartialDetails = Partial<DraftShopDetails> & { addressConfirmed?: boolean };

function partialOf(draft: ShopRegistrationDraft): PartialDetails {
  return (draft.details as PartialDetails | null) ?? {};
}

function addressOf(p: PartialDetails): DraftAddress | null {
  if (!p.addressLine1 || !p.city || !p.pincode) return null;
  return {
    addressLine1: p.addressLine1,
    addressLine2: p.addressLine2 ?? null,
    area: p.area ?? null,
    city: p.city,
    state: p.state ?? null,
    pincode: p.pincode,
    landmark: p.landmark ?? null,
  };
}

export const WIZARD_STEPS = [
  "IDENTITY",
  "EMAIL",
  "OWNER",
  "ADDRESS",
  "PIN",
  "SHOP",
  "FSSAI",
  "REVIEW",
  "PAYMENT",
  "WAITING",
  "LIVE",
  // A shop registered before 08-Nov-2026 without a pin is still asked for it after go-live.
  "LOCATION",
  "CATEGORY",
  "PRODUCTS",
  "DONE",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardDocView {
  /** UDYAM / FSSAI: the owner's answer to "Do you have …?"; SHOP_ACT: always true. */
  has: boolean | null;
  check: (DraftCheckView & { validUntil: string | null }) | null;
  /** The step is settled: answered "no", or checked with a status that lets the owner go on. */
  done: boolean;
}

export interface WizardView extends ShopRegistrationDraftView {
  status: ShopRegistrationDraft["status"];
  details: DraftShopDetails | null;
  /** A food shop type: FSSAI is mandatory (approval waits for it to be verified). */
  foodShop: boolean;
  udyam: WizardDocView;
  fssai: WizardDocView & { required: boolean };
  shopAct: WizardDocView;
  location: { latitude: string; longitude: string; address: string | null } | null;
  /** 0120: the referral step — the code given (null: none) and whether the admin makes it mandatory. */
  referral: { answered: boolean; code: string | null; required: boolean };
  /** 0120: the shop's email — the account's (the default) and the one confirmed for the shop. */
  email: { account: string | null; shop: string | null; confirmed: boolean };
  /** Always false since 08-Nov-2026 ("upload later" is gone); kept for the screen's shape. */
  documentsLater: boolean | null;
  /** The owner's name: typed on OWNER, else from the record (a proprietor's PAN). Null: OWNER asks for it. */
  ownerName: string | null;
  /** The shop's address as confirmed on ADDRESS (pre-filled from the record before that). */
  address: DraftAddress | null;
  /** Owner decision 29 Oct 2026 ("follow the brief"): the fee is paid once the GSTIN or PAN is verified. */
  documents: WizardDocuments;
  /** Once the shop exists (SUBMITTED / COMPLETED). */
  shop: {
    id: string;
    name: string;
    registrationNumber: string | null;
    status: Shop["status"];
    feeDuePaise: number;
    feePaymentStatus: Shop["feePaymentStatus"];
  } | null;
  /** The admin's fee-by-turnover slab table (Admin → Registration fees): the details step offers its slabs. */
  feeRule: TurnoverFeeRule;
  /** The fee covers this many months, then renews (rule shopMembership; owner 05-Nov-2026: yearly). */
  membershipMonths: number;
  /** After approval: what the owner has set up on the shop (map pin, categories, products). */
  setup: { location: boolean; categories: boolean; products: boolean } | null;
  /** Where the wizard resumes. */
  nextStep: WizardStep;
}

export interface WizardDocuments {
  verified: SellerDocType[];
  /** Needed for approval and not verified yet: the GSTIN (or PAN), FSSAI for a food shop. */
  missing: SellerDocType[];
  /** Kept for the screen's shape; nothing waits for the team before payment any more. */
  inReview: SellerDocType[];
  /** The 30-day promise is not used in the wizard (owner decision 29 Oct 2026, "follow the brief"). */
  promised: boolean;
  promiseDays: number;
  /** "Create my shop and pay" may go ahead: the GSTIN — or the PAN without one — was checked and not refused. */
  canSubmit: boolean;
  /** Something approval needs is not verified yet, so the shop will wait for an admin after payment. */
  needsTeamApproval: boolean;
}

/* ---------------------------------------------------------------- views */

const DOC_MESSAGES: Partial<Record<DraftCheckDocType, Record<string, string>>> = {
  UDYAM: { name_mismatch: "The name on the Udyam record doesn't match your shop or owner name. You can carry on — our team will check it." },
  FSSAI: { name_mismatch: "The name on the FSSAI record doesn't match your shop or owner name. You can carry on — our team will check it." },
  SHOP_ACT: {
    vendor_unsupported:
      "Shop Act numbers can't be checked online. You can carry on — after registration, upload your Shop Act certificate on Documents and our team will review it.",
    name_mismatch: "The name on the Shop Act record doesn't match your shop or owner name. You can carry on — our team will check it.",
  },
};

function checkView(docType: DraftCheckDocType, row: ShopRegistrationDraftCheck | undefined) {
  if (!row || !row.numberMasked) return null;
  const special = row.errorCode ? DOC_MESSAGES[docType]?.[row.errorCode] : undefined;
  return {
    numberMasked: row.numberMasked,
    status: row.status,
    errorCode: row.errorCode,
    message: row.status === "VERIFIED" || row.status === "PENDING" ? message(row.status, row.errorCode) : (special ?? message(row.status, row.errorCode)),
    validUntil: row.validUntil,
  };
}

const settled = (row: ShopRegistrationDraftCheck | undefined) => Boolean(row?.numberMasked && CAN_CONTINUE.includes(row.status));

function detailsOf(draft: ShopRegistrationDraft): DraftShopDetails | null {
  const d = draft.details as Partial<DraftShopDetails> | null;
  return d && typeof d.shopType === "string" ? (d as DraftShopDetails) : null;
}

async function isFoodShopType(shopType: string | undefined): Promise<boolean> {
  if (!shopType) return false;
  await loadShopTypeRegistry();
  return isFoodBusinessShopType(shopType);
}

async function loadChecks(draftId: string, client: DbClient = db): Promise<ShopRegistrationDraftCheck[]> {
  return client.select().from(shopRegistrationDraftChecks).where(eq(shopRegistrationDraftChecks.draftId, draftId));
}

/** The address the GST (or PAN) record gave, as the ADDRESS step's starting point. */
function prefillAddress(base: ShopRegistrationDraftView): DraftAddress | null {
  const p = base.prefill;
  if (!p.address) return null;
  return { addressLine1: p.address, addressLine2: null, area: null, city: p.city ?? "", state: p.state, pincode: p.pincode ?? "", landmark: null };
}

export async function toWizardView(draft: ShopRegistrationDraft): Promise<WizardView> {
  const base = toDraftView(draft);
  const checks = await loadChecks(draft.id);
  const row = (t: DraftCheckDocType) => checks.find((c) => c.docType === t);
  const details = detailsOf(draft);
  const foodShop = await isFoodShopType(details?.shopType);

  // Not a wizard step since 08-Nov-2026: Udyam is added on Documents after go-live.
  const udyam: WizardDocView = { has: draft.hasUdyam, check: checkView("UDYAM", row("UDYAM")), done: true };
  // A food shop must give its FSSAI number (the brief: legal documents by shop type are enforced in the flow).
  // Since 08-Nov-2026 only a food shop is asked (after the shop step); any other shop never waits on it.
  const fssaiDone = !foodShop || settled(row("FSSAI"));
  const fssai = { has: draft.hasFssai, check: checkView("FSSAI", row("FSSAI")), done: fssaiDone, required: foodShop };
  const shopAct: WizardDocView = {
    has: draft.hasShopAct ?? null,
    check: checkView("SHOP_ACT", row("SHOP_ACT")),
    done: draft.hasShopAct === false || settled(row("SHOP_ACT")),
  };
  const location = draft.latitude && draft.longitude && draft.locationConfirmedAt ? { latitude: draft.latitude, longitude: draft.longitude, address: draft.locationAddress } : null;

  let shop: WizardView["shop"] = null;
  let setup: WizardView["setup"] = null;
  if (draft.shopId) {
    const [s] = await db.select().from(shops).where(eq(shops.id, draft.shopId));
    if (s) {
      shop = {
        id: s.id,
        name: s.name,
        registrationNumber: s.registrationNumber,
        status: s.status,
        feeDuePaise: registrationFeeDue(s),
        feePaymentStatus: s.feePaymentStatus,
      };
      if (s.status === "APPROVED") setup = await shopSetup(s);
    }
  }

  // The code is asked on the identity screen, sent before the number; a draft with a GSTIN / PAN or
  // details is past it (a required code is checked again when the shop is created).
  const started = draft.route !== null || detailsOf(draft) !== null;
  // Owner brief 08-Nov-2026: no "upload later" — every registration verifies its GSTIN or PAN first.
  const documentsLater = false;
  const referral = { answered: draft.referralAnsweredAt !== null || started, code: draft.referralCode, required: await isReferralRequired("shop") };
  // Owner, 05-Nov-2026 (D3): the shop email stays required but is one pre-filled line — the
  // account's email (already proven by the sign-in) unless the owner changes it. Only a
  // mobile-only account, with no email, gets the email screen.
  const account = await accountEmail(draft.ownerId);
  const email = {
    account,
    shop: draft.shopEmail ?? account,
    confirmed: draft.shopEmailConfirmedAt !== null || started || account !== null,
  };

  const partial = partialOf(draft);
  const ownerName = str(partial.ownerName) ?? base.prefill.ownerName;
  const savedAddress = addressOf(partial);
  const address = savedAddress ?? prefillAddress(base);
  const addressConfirmed = savedAddress !== null && (partial.addressConfirmed === true || details !== null);

  // Owner brief 08-Nov-2026: verify (GSTIN or PAN, with the referral code) → owner name if the record
  // gave none → address → map pin → shop name → FSSAI for a food shop → pay → live → products.
  let nextStep: WizardStep;
  if (shop?.status === "APPROVED" && setup) {
    nextStep = !setup.location ? "LOCATION" : !setup.products ? "LIVE" : "DONE";
  } else if (draft.status === "COMPLETED") nextStep = "DONE";
  else if (draft.status === "SUBMITTED") nextStep = shop && shop.feeDuePaise > 0 ? "PAYMENT" : "WAITING";
  else if (!referral.answered || !base.canContinue) nextStep = "IDENTITY";
  else if (!email.confirmed) nextStep = "EMAIL";
  else if (!ownerName) nextStep = "OWNER";
  else if (!addressConfirmed) nextStep = "ADDRESS";
  else if (!location) nextStep = "PIN";
  else if (!details) nextStep = "SHOP";
  // A food shop type chosen on the shop step: FSSAI is mandatory for it.
  else if (!fssai.done) nextStep = "FSSAI";
  else nextStep = "REVIEW";

  // The onboarding funnel (Phase B, B3): when this registration first reached its current step.
  await recordStepReached(draft.id, nextStep);
  // Phase 2 (WP4): a registration before go-live is reminded 24 h after its last step; else cancelled.
  await syncRegistrationReminder(draft, nextStep);
  const documents = await draftDocuments(draft, checks, details, foodShop);
  const feeRule = await getRule("registrationFeeByTurnover");
  const membershipMonths = (await getRule("shopMembership")).periodMonths;
  return {
    ...base,
    status: draft.status,
    details,
    foodShop,
    udyam,
    fssai,
    shopAct,
    location,
    referral,
    email,
    documentsLater,
    ownerName,
    address,
    documents,
    shop,
    feeRule,
    membershipMonths,
    setup,
    nextStep,
  };
}

/** Best-effort: the funnel never stops a registration. One row per (registration, step). */
async function recordStepReached(draftId: string, step: WizardStep): Promise<void> {
  try {
    await db.insert(shopOnboardingSteps).values({ draftId, step }).onConflictDoNothing();
  } catch (error) {
    console.error("[onboarding-funnel] could not record a step", draftId, step, error instanceof Error ? error.message : error);
  }
}

/** The account's own email (core database), unless it is a placeholder for a mobile-only account. */
async function accountEmail(ownerId: string): Promise<string | null> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, ownerId), columns: { email: true } });
  return owner?.email && !isPlaceholderEmail(owner.email) ? owner.email : null;
}

/** What an approved shop has set up after registration: the map pin, categories and products. */
async function shopSetup(shop: Shop): Promise<NonNullable<WizardView["setup"]>> {
  const [categories] = await db
    .select({ n: count() })
    .from(shopCategoryMapping)
    .where(eq(shopCategoryMapping.shopId, shop.id));
  const [products] = await db
    .select({ n: count() })
    .from(shopProducts)
    .where(eq(shopProducts.shopId, shop.id));
  return {
    location: shop.latitude != null && shop.longitude != null,
    categories: Number(categories?.n ?? 0) > 0,
    products: Number(products?.n ?? 0) > 0,
  };
}

/** Statuses of a GSTIN / PAN check that let the owner pay (the identity step's own "may continue"). */
const CHECKED = new Set(["VERIFIED", "PENDING", "MANUAL_REVIEW"]);

/** The documents rule on a draft: the same mandatory list as the shop will have (shop-document-gate.ts). */
async function draftDocuments(
  draft: ShopRegistrationDraft,
  checks: ShopRegistrationDraftCheck[],
  details: DraftShopDetails | null,
  foodShop: boolean,
): Promise<WizardDocuments> {
  // Exactly what the shop will receive (registrationChecks): a PAN whose name does not match on
  // the no-GSTIN route goes to review, and a number answered "I don't have it now" is dropped.
  const { nameMatchAutoApprove } = await getRule("sellerVerification");
  const imported = details ? registrationChecks(draft, checks, details, nameMatchAutoApprove) : [];
  const verified = SELLER_DOC_TYPES.filter((d) => imported.some((c) => c.docType === d && c.status === "VERIFIED"));
  // Owner decision 29 Oct 2026 ("follow the brief"; 0118): the GSTIN — or the PAN on the no-GSTIN
  // route — opens the payment; approval needs FSSAI too for a food shop. Same list as the shop's.
  const identity: SellerDocType = draft.route === "PAN_ONLY" ? "PAN" : "GSTIN";
  // 0120: "upload later" — only FSSAI for a food shop before go-live; the GSTIN / PAN after it.
  // "Upload later" is gone (owner brief 08-Nov-2026): a draft that chose it verifies its GSTIN / PAN like any other.
  const later = false;
  const required: SellerDocType[] = [...(later ? [] : [identity]), ...(foodShop ? (["FSSAI"] as const) : [])];
  const missing = required.filter((d) => !verified.includes(d));
  const { promiseDays } = await getRule("shopDocumentFollowUp");
  return {
    verified,
    missing,
    inReview: [],
    promised: false,
    promiseDays,
    // Checked and not refused (verified, still being checked, or with the team): the owner may pay; only a
    // verified one is approved automatically — anything else waits for an admin after payment.
    canSubmit: later || imported.some((c) => c.docType === identity && CHECKED.has(c.status)),
    needsTeamApproval: missing.length > 0,
  };
}

/**
 * The owner's registration in the wizard: the OPEN draft, else the latest one
 * already turned into a shop (to show payment, waiting or done), else null.
 */
export async function getWizardDraft(actor: Pick<Actor, "id">): Promise<WizardView | null> {
  const open = await findOpenDraft(actor.id);
  if (open) return toWizardView(open);
  const [latest] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, actor.id), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt))
    .limit(1);
  return latest ? toWizardView(latest) : null;
}

/**
 * Back from the gateway (onboarding Phase B, G13): a shop registered through the wizard
 * continues in the wizard — waiting for approval, or the pin, categories and products —
 * instead of stopping on the fee page. Null when the shop has no wizard draft or its
 * set-up is complete.
 */
export async function wizardContinuePath(ownerId: string, shopId: string): Promise<string | null> {
  const [draft] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.shopId, shopId)))
    .limit(1);
  if (!draft) return null;
  const view = await toWizardView(draft);
  return view.nextStep === "DONE" || view.nextStep === "PAYMENT" ? null : "/shop/register";
}

/* --------------------------------------------------------------- guards */

/** The owner's OPEN draft past the GSTIN / PAN step (or on "upload later", 0120), locked for this transaction. */
async function lockReadyDraft(tx: DbClient, ownerId: string): Promise<ShopRegistrationDraft> {
  const [draft] = await tx
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, ownerId), eq(shopRegistrationDrafts.status, "OPEN")))
    .for("update");
  if (!draft) throw notFound("Registration in progress");
  if (!toDraftView(draft).canContinue) {
    throw conflict("Please finish the GSTIN or PAN step first.", { reason: "IDENTITY_STEP_OPEN" });
  }
  return draft;
}

/* ------------------------------------------- 0120: referral, email, documents */

/** Step "Referral code": checked now (a code the platform requires, or one that is not valid, is refused here). */
export async function answerDraftReferral(input: { actor: Actor; referralCode: string | null }): Promise<WizardView> {
  const code = await assertRegistrationReferralCode(input.referralCode);
  await assertOwnerExists(input.actor.id);
  // Shop-refers-shop (rule shopReferrals on): one code — the first one entered is kept.
  const oneCode = (await shopReferralRule()).enabled;
  const draft = await db.transaction(async (tx) => {
    const locked = await lockOpenDraft(tx, input.actor.id);
    if (oneCode && locked.referralCode && locked.referralCode !== code) {
      throw conflict(`You already entered referral code ${locked.referralCode}. Only one code can be used — a dealer's or a shop's — and the first one is kept.`, {
        reason: "REFERRAL_CODE_LOCKED",
        fields: { referralCode: "The first code entered is kept." },
      });
    }
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ referralCode: code, referralAnsweredAt: new Date(), updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

async function setDraftEmail(ownerId: string, email: string): Promise<WizardView> {
  const draft = await db.transaction(async (tx) => {
    const locked = await lockOpenDraft(tx, ownerId);
    if (locked.referralAnsweredAt === null && locked.route === null) {
      throw conflict("Please answer the referral code step first.", { reason: "REFERRAL_STEP_OPEN" });
    }
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ shopEmail: email, shopEmailConfirmedAt: new Date(), updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/** Step "Shop email": "Continue with my account's email" — already proven by the sign-in. */
export async function chooseAccountEmailForShop(input: { actor: Actor }): Promise<WizardView> {
  const email = await accountEmail(input.actor.id);
  if (!email) throw validationFailed("Your account has no email yet. Enter the email for your shop.", { fields: { email: "Enter an email." } });
  return setDraftEmail(input.actor.id, email);
}

function shopEmailMessage(code: string, expiryMinutes: number) {
  return {
    subject: `${code} — confirm this email for your shop on GoKesari`,
    text:
      `You asked to use this email for your shop on GoKesari.\n\n` +
      `Your code: ${code}\n\nIt works once and expires in ${expiryMinutes} minutes. If you did not ask for this, ignore this email.\n`,
    html:
      `<p>You asked to use this email for your shop on GoKesari.</p><p>Your code:</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${code}</p>` +
      `<p style="color:#666;font-size:12px">It works once and expires in ${expiryMinutes} minutes. If you did not ask for this, ignore this email.</p>`,
  };
}

/** Step "Shop email", another address: a code is emailed to it (outside every transaction). */
export async function requestDraftEmailCode(input: { actor: Actor; email: string; ip?: string | null }) {
  return requestShopEmailOtp({ email: input.email, userId: input.actor.id, ip: input.ip ?? null, render: shopEmailMessage });
}

/** Step "Shop email", another address: the emailed code confirms it. */
export async function confirmDraftEmailCode(input: { actor: Actor; email: string; code: string; ip?: string | null }): Promise<WizardView> {
  const email = await verifyShopEmailOtp({ email: input.email, code: input.code, userId: input.actor.id, ip: input.ip ?? null });
  return setDraftEmail(input.actor.id, email);
}

/** Step "Do you have your documents handy?" — false: check them now; true: upload them after go-live. */
export async function answerDocumentsReady(input: { actor: Actor; later: boolean }): Promise<WizardView> {
  if (input.later) {
    throw conflict("Please verify your GSTIN or PAN to register — it fills in your shop's details.", { reason: "IDENTITY_STEP_OPEN" });
  }
  const draft = await db.transaction(async (tx) => {
    const locked = await lockOpenDraft(tx, input.actor.id);
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ documentsLater: input.later, updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/* ----------------------------------------------------------- shop details */

/** The SHOP step's input: the owner name and address come from their own steps unless given here. */
export type DraftShopInput = Omit<DraftShopDetails, "ownerName" | keyof DraftAddress> & { ownerName?: string | null } & { [K in keyof DraftAddress]?: DraftAddress[K] | null };

/** Saves part of the details on the owner's draft past the identity step, merged with what is there. */
async function mergeDraftDetails(ownerId: string, patch: PartialDetails, extra: Partial<ShopRegistrationDraft> = {}): Promise<WizardView> {
  const draft = await db.transaction(async (tx) => {
    const locked = await lockReadyDraft(tx, ownerId);
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ details: { ...partialOf(locked), ...patch }, ...extra, updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/** Step OWNER: the record named no owner (a company's GSTIN, a firm's PAN) — the owner types it. */
export async function saveDraftOwner(input: { actor: Actor; ownerName: string }): Promise<WizardView> {
  const ownerName = input.ownerName.trim();
  if (ownerName.length < 2) throw validationFailed("Please check the highlighted fields.", { fields: { ownerName: "Enter the owner's name." } });
  return mergeDraftDetails(input.actor.id, { ownerName });
}

/** Step ADDRESS: the shop's address, pre-filled from the record — confirmed or corrected. */
export async function saveDraftAddress(input: { actor: Actor; address: DraftAddress }): Promise<WizardView> {
  return mergeDraftDetails(input.actor.id, { ...input.address, addressConfirmed: true });
}

/** Step SHOP: shop name, type, phone and turnover — completing the details the shop is created from. */
export async function saveDraftDetails(input: { actor: Actor; details: DraftShopInput }): Promise<WizardView> {
  const { actor } = input;
  const given = input.details;
  await assertShopType(given.shopType);
  if (given.annualTurnoverRupees == null && (await getRule("registrationFeeByTurnover")).enabled) {
    throw validationFailed("Please check the highlighted fields.", {
      fields: { annualTurnover: "Enter your annual turnover — it sets the registration fee." },
    });
  }
  const open = await findOpenDraft(actor.id);
  const saved = open ? partialOf(open) : {};
  const view = open ? toDraftView(open) : null;
  const address = addressOf({ ...saved, ...(stripNulls(pickAddress(given)) as Partial<DraftAddress>) });
  const ownerName = str(given.ownerName) ?? str(saved.ownerName) ?? view?.prefill.ownerName ?? null;
  if (!address) throw conflict("Please confirm your shop address first.", { reason: "STEP_OPEN", nextStep: "ADDRESS" });
  if (!ownerName) throw conflict("Please enter the owner's name first.", { reason: "STEP_OPEN", nextStep: "OWNER" });
  // 0120: the referral code and email come from their own steps when the form leaves them out.
  const details: DraftShopDetails = {
    ...given,
    ...address,
    ownerName,
    referralCode: given.referralCode ?? open?.referralCode ?? null,
    email: given.email ?? open?.shopEmail ?? (await accountEmail(actor.id)),
  };
  // A referral code the platform requires (or one that is not valid) is caught here, not at payment.
  await assertRegistrationReferralCode(details.referralCode);
  const foodShop = await isFoodShopType(details.shopType);
  // A food shop type answers the FSSAI question by itself.
  return mergeDraftDetails(actor.id, { ...details, addressConfirmed: true }, foodShop ? { hasFssai: true } : {});
}

function pickAddress(d: DraftShopInput): Record<string, string | null | undefined> {
  const { addressLine1, addressLine2, area, city, state, pincode, landmark } = d;
  return { addressLine1, addressLine2, area, city, state, pincode, landmark };
}

function stripNulls<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;
}

/* ----------------------------------------------- Udyam, FSSAI, Shop Act */

/**
 * "I don't have Udyam / FSSAI / the Shop Act now." Owner decision 29 Oct 2026: a mandatory
 * document (Shop Act, FSSAI for a food shop) may be left for later; it is then promised at
 * "Create my shop and pay", and the shop waits for GoKesari's team (a food shop is approved
 * only once its FSSAI is on file).
 */
export async function answerDraftDocument(input: { actor: Actor; docType: "UDYAM" | "FSSAI" | "SHOP_ACT"; has: boolean }): Promise<WizardView> {
  const draft = await db.transaction(async (tx) => {
    const locked = await lockReadyDraft(tx, input.actor.id);
    const answer =
      input.docType === "UDYAM" ? { hasUdyam: input.has } : input.docType === "FSSAI" ? { hasFssai: input.has } : { hasShopAct: input.has };
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({ ...answer, updatedAt: new Date() })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/** The draft as the document rules see a shop: names from the GST / PAN records and the details step. */
function draftFacts(draft: ShopRegistrationDraft, foodShop: boolean): ShopFacts {
  const details = detailsOf(draft);
  const pincode = details?.pincode ?? str(draft.gstRecord?.pincode);
  return {
    ownerName: details?.ownerName ?? str(draft.panRecord?.name),
    legalBusinessName: str(draft.gstRecord?.legalName),
    shopName: details?.name ?? str(draft.gstRecord?.tradeName) ?? "",
    pincode,
    stateCode: stateCodeForPincode(pincode),
    isFoodBusiness: foodShop,
  };
}

export interface SubmitDraftDocumentInput {
  actor: Actor;
  docType: DraftCheckDocType;
  number: string;
  /** Must be true: the owner agreed to the government check. */
  consentGiven: boolean;
  ipAddress?: string | null;
}

/** Checks a Udyam, FSSAI or Shop Act number with the government source and keeps the result on the draft. */
export async function submitDraftDocument(input: SubmitDraftDocumentInput): Promise<WizardView> {
  const { actor, docType } = input;
  const parsed = parseSellerDocNumber(docType, input.number);
  if (!parsed.ok) throw validationFailed("Please check the highlighted fields.", { fields: { number: parsed.error } });
  if (!input.consentGiven) throw validationFailed("Please agree to the verification consent before we check this number.");
  const doc = parsed.value;
  await assertOwnerExists(actor.id);
  const numberHash = docBlindIndex(docType, doc.normalized);
  const now = new Date();

  type Claim = { kind: "done"; draftId: string } | { kind: "call"; draftId: string; key: string };
  const claim = await db.transaction(async (tx): Promise<Claim> => {
    const draft = await lockReadyDraft(tx, actor.id);
    // Locked through the draft: the check row's only unique key is its primary key.
    await tx.insert(shopRegistrationDraftChecks).values({ draftId: draft.id, docType }).onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(shopRegistrationDraftChecks)
      .where(and(eq(shopRegistrationDraftChecks.draftId, draft.id), eq(shopRegistrationDraftChecks.docType, docType)));
    const answered = docType === "UDYAM" ? { hasUdyam: true } : docType === "FSSAI" ? { hasFssai: true } : { hasShopAct: true };
    const sameNumber = row.numberHash === numberHash;
    const stillValid = !row.validUntil || row.validUntil >= now.toISOString().slice(0, 10);
    if (sameNumber && row.status === "VERIFIED" && stillValid) {
      await tx.update(shopRegistrationDrafts).set({ ...answered, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
      return { kind: "done", draftId: draft.id };
    }
    if (sameNumber && row.status === "PENDING" && row.checkedAt && now.getTime() - row.checkedAt.getTime() < IN_FLIGHT_WINDOW_MS) {
      return { kind: "done", draftId: draft.id };
    }
    const counted = await countCheck(tx, draft, now);
    await tx.update(shopRegistrationDrafts).set({ ...counted, ...answered, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
    const key = `${draft.id}:${docType.toLowerCase()}:${now.getTime()}`;
    await tx
      .update(shopRegistrationDraftChecks)
      .set({
        numberEncrypted: encryptSecret(doc.normalized),
        numberMasked: doc.masked,
        numberHash,
        status: "PENDING",
        errorCode: null,
        idempotencyKey: key,
        checkedAt: now,
        consentGivenAt: now,
        consentVersion: SELLER_VERIFICATION_CONSENT_VERSION,
        // A new number invalidates everything learned about the old one. The form as typed (a Shop Act
        // number's slashes) is kept for the shop's record — as ciphertext, like the number.
        ...(sameNumber
          ? {}
          : {
              record: { displayEncrypted: encryptSecret(input.number.trim().toUpperCase().replace(/\s+/g, " ")) },
              validUntil: null,
              verifiedAt: null,
              providerId: null,
              providerRef: null,
            }),
        updatedAt: now,
      })
      .where(and(eq(shopRegistrationDraftChecks.draftId, draft.id), eq(shopRegistrationDraftChecks.docType, docType)));
    return { kind: "call", draftId: draft.id, key };
  });

  if (claim.kind === "call") {
    const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, claim.draftId));
    const facts = draftFacts(draft, await isFoodShopType(detailsOf(draft)?.shopType));
    const rule = await getRule("sellerVerification");
    const result = await verifyDocument(
      docType,
      doc.normalized,
      {
        nameToMatch: facts.legalBusinessName ?? facts.ownerName ?? facts.shopName,
        stateCode: facts.stateCode,
        city: detailsOf(draft)?.city ?? undefined,
      },
      claim.key,
    );
    const judged = applyDocumentChecks({ docType, vendorStatus: result.status, record: result.record, shop: facts, nameMatchAutoApprove: rule.nameMatchAutoApprove });
    const checkedAt = new Date();
    const [current] = await db
      .select({ record: shopRegistrationDraftChecks.record })
      .from(shopRegistrationDraftChecks)
      .where(and(eq(shopRegistrationDraftChecks.draftId, claim.draftId), eq(shopRegistrationDraftChecks.docType, docType)));
    await db
      .update(shopRegistrationDraftChecks)
      .set({
        status: judged.status,
        errorCode: judged.errorCode ?? result.errorCode,
        record: {
          displayEncrypted: current?.record?.displayEncrypted ?? null,
          ...(result.record
            ? {
                docStatus: result.record.docStatus,
                name: result.record.name ?? null,
                tradeName: result.record.tradeName ?? null,
                ownerName: result.record.ownerName ?? null,
                category: result.record.category ?? null,
                stateCode: result.record.stateCode ?? null,
                pincode: result.record.pincode ?? null,
              }
            : {}),
          nameScore: judged.checks.nameScore,
          pincodeMatch: judged.checks.pincodeMatch,
          matchedShopName: judged.checks.matchedShopName,
        },
        validUntil: result.validUntil,
        providerId: result.providerId,
        providerRef: result.rawRef,
        verifiedAt: judged.status === "VERIFIED" ? checkedAt : null,
        updatedAt: checkedAt,
      })
      // Only if no newer check claimed the row while the vendor was answering.
      .where(and(eq(shopRegistrationDraftChecks.draftId, claim.draftId), eq(shopRegistrationDraftChecks.docType, docType), eq(shopRegistrationDraftChecks.idempotencyKey, claim.key)));
  }

  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, claim.draftId));
  if (claim.kind === "call") {
    const [row] = await loadChecks(final.id).then((rows) => rows.filter((r) => r.docType === docType));
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_CHECKED,
      entityType: "shop_registration_draft",
      entityId: final.id,
      ipAddress: input.ipAddress ?? null,
      newValue: { docType, number: row?.numberMasked ?? doc.masked, status: row?.status ?? "PENDING" },
    });
  }
  return toWizardView(final);
}

/* ---------------------------------------------------------------- the map */

export async function saveDraftLocation(input: { actor: Actor; latitude: number; longitude: number; address?: string | null }): Promise<WizardView> {
  const { latitude, longitude } = input;
  // India's bounding box: a pin anywhere else is a slip of the finger.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < 6 || latitude > 37.5 || longitude < 68 || longitude > 97.5) {
    throw validationFailed("Please place the pin on your shop in India.", { fields: { location: "Place the pin on your shop." } });
  }
  const draft = await db.transaction(async (tx) => {
    const locked = await lockReadyDraft(tx, input.actor.id);
    const [updated] = await tx
      .update(shopRegistrationDrafts)
      .set({
        latitude: latitude.toFixed(7),
        longitude: longitude.toFixed(7),
        locationAddress: input.address?.trim().slice(0, 300) || null,
        locationConfirmedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopRegistrationDrafts.id, locked.id))
      .returning();
    return updated;
  });
  return toWizardView(draft);
}

/* -------------------------------------------------------- draft → shop */

/** Every check on the draft as the shop's seller verification. */
function registrationChecks(draft: ShopRegistrationDraft, checks: ShopRegistrationDraftCheck[], details: DraftShopDetails, threshold: number): RegistrationCheck[] {
  const out: RegistrationCheck[] = [];
  const gst = draft.gstRecord ?? {};
  if (draft.route === "GSTIN" && draft.gstinEncrypted && draft.gstinMasked && draft.gstinHash) {
    out.push({
      docType: "GSTIN",
      status: draft.gstStatus,
      numberEncrypted: draft.gstinEncrypted,
      numberMasked: draft.gstinMasked,
      numberHash: draft.gstinHash,
      normalized: decryptSecret(draft.gstinEncrypted),
      verifiedName: str(gst.legalName),
      nameMatchScore: null,
      validUntil: null,
      details: {
        docStatus: gst.docStatus ?? null,
        recordName: gst.legalName ?? null,
        tradeName: gst.tradeName ?? null,
        entityType: gst.constitution ?? null,
        stateCode: gst.stateCode ?? null,
        pincode: gst.pincode ?? null,
        address: gst.address ?? null,
        panLinked: gst.panLinked ?? null,
        ...(draft.panHash ? { embeddedPanHash: draft.panHash } : {}),
      },
      providerId: draft.gstProviderId,
      providerRef: draft.gstProviderRef,
      errorCode: draft.gstErrorCode,
      idempotencyKey: draft.gstIdempotencyKey,
      consentGivenAt: draft.consentGivenAt,
      consentVersion: draft.consentVersion,
      checkedAt: draft.gstCheckedAt,
      verifiedAt: draft.gstVerifiedAt,
    });
  }
  if (draft.panEncrypted && draft.panMasked && draft.panHash) {
    const pan = draft.panRecord ?? {};
    let status = draft.panStatus;
    let errorCode = draft.panErrorCode;
    let score = draft.panNameMatchScore;
    // No GST record to compare with: the PAN holder must be the owner (or the business) named on the shop.
    if (draft.route === "PAN_ONLY" && status === "VERIFIED" && str(pan.name)) {
      score = bestNameMatch([str(pan.name)], [details.ownerName, details.name]).score;
      if (score < threshold) {
        status = "MANUAL_REVIEW";
        errorCode = "name_mismatch";
      }
    }
    out.push({
      docType: "PAN",
      status,
      numberEncrypted: draft.panEncrypted,
      numberMasked: draft.panMasked,
      numberHash: draft.panHash,
      normalized: decryptSecret(draft.panEncrypted),
      verifiedName: str(pan.name),
      nameMatchScore: score,
      validUntil: null,
      details: { docStatus: pan.docStatus ?? null, recordName: pan.name ?? null, holderType: pan.holderType ?? null },
      providerId: draft.panProviderId,
      providerRef: draft.panProviderRef,
      errorCode,
      idempotencyKey: draft.panIdempotencyKey,
      consentGivenAt: draft.consentGivenAt,
      consentVersion: draft.consentVersion,
      checkedAt: draft.panCheckedAt,
      verifiedAt: status === "VERIFIED" ? draft.panVerifiedAt : null,
    });
  }
  for (const row of checks) {
    if (!row.numberEncrypted || !row.numberMasked || !row.numberHash || row.status === "NOT_SUBMITTED") continue;
    if (row.docType === "UDYAM" && draft.hasUdyam !== true) continue;
    if (row.docType === "FSSAI" && draft.hasFssai !== true) continue;
    if (row.docType === "SHOP_ACT" && draft.hasShopAct === false) continue;
    const record = row.record ?? {};
    out.push({
      docType: row.docType,
      status: row.status,
      numberEncrypted: row.numberEncrypted,
      numberMasked: row.numberMasked,
      numberHash: row.numberHash,
      normalized: decryptSecret(row.numberEncrypted),
      verifiedName: str(record.name) ?? str(record.tradeName) ?? str(record.ownerName),
      nameMatchScore: typeof record.nameScore === "number" ? record.nameScore : null,
      validUntil: row.validUntil,
      details: {
        docStatus: record.docStatus ?? null,
        recordName: record.name ?? null,
        tradeName: record.tradeName ?? null,
        ownerName: record.ownerName ?? null,
        category: record.category ?? null,
        stateCode: record.stateCode ?? null,
        pincode: record.pincode ?? null,
        pincodeMatch: record.pincodeMatch ?? null,
        matchedShopName: record.matchedShopName ?? null,
      },
      providerId: row.providerId,
      providerRef: row.providerRef,
      errorCode: row.errorCode,
      idempotencyKey: row.idempotencyKey,
      consentGivenAt: row.consentGivenAt,
      consentVersion: row.consentVersion,
      checkedAt: row.checkedAt,
      verifiedAt: row.verifiedAt,
    });
  }
  return out;
}

const plain = (row: ShopRegistrationDraftCheck | undefined, include = true): string | null => {
  if (!include || !row?.numberEncrypted) return null;
  const typed = str(row.record?.displayEncrypted);
  return typed ? decryptSecret(typed) : decryptSecret(row.numberEncrypted);
};

/**
 * "Create my shop and pay": the shop is created from the draft — the same
 * registration as Add my shop (duplicate checks, fee snapshot, referral code,
 * role) — and every government check is copied to seller_verifications in the
 * same transaction. Returns the wizard at its payment step. Idempotent: a
 * draft already turned into a shop is returned as it is.
 */
export async function submitDraftForPayment(input: { actor: Actor; ipAddress?: string | null; /** Ignored: no promise in the wizard any more. */ promiseDocuments?: boolean }): Promise<WizardView> {
  const { actor } = input;
  const open = await findOpenDraft(actor.id);
  if (!open) {
    const current = await getWizardDraft(actor);
    if (current?.shop) return current;
    throw notFound("Registration in progress");
  }
  const view = await toWizardView(open);
  if (view.nextStep !== "REVIEW") {
    throw conflict("Please finish every step before payment.", { reason: "STEP_OPEN", nextStep: view.nextStep });
  }
  // Owner decision 29 Oct 2026 ("follow the brief"): a checked GSTIN, or PAN without one, before payment.
  if (!view.documents.canSubmit) {
    throw conflict("A valid PAN or GST is required to register. Please get your GSTIN or PAN verified before paying the registration fee.", {
      reason: "IDENTITY_NOT_VERIFIED",
    });
  }
  const details = view.details!;
  const checks = await loadChecks(open.id);
  const row = (t: DraftCheckDocType) => checks.find((c) => c.docType === t);
  const referralCode = await assertRegistrationReferralCode(details.referralCode);
  const rule = await getRule("sellerVerification");
  // 0120: on "upload later" a number tried and refused before the owner switched is not carried over.
  const later = false;
  const imports = registrationChecks(open, checks, details, rule.nameMatchAutoApprove).filter((c) => !later || CHECKED.has(c.status));
  const panRecordName = str(open.panRecord?.name);
  const stamp = open.updatedAt.getTime();

  const onSaved = async (tx: DbClient, shop: Shop) => {
    const [draft] = await tx.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, open.id)).for("update");
    // Changed in another tab after this submission read it: nothing is created.
    if (!draft || draft.status !== "OPEN" || draft.updatedAt.getTime() !== stamp) {
      throw conflict("Your registration changed while it was being submitted. Please check it and try again.", { reason: "DRAFT_CHANGED" });
    }
    // No promise and no deferral: approval reads the wizard rule (0118) — GSTIN or PAN, FSSAI for food.
    for (const check of imports) await importRegistrationCheck(tx, shop.id, check, actor, draft.id);
    if (draft.route === "PAN_ONLY" && pan) {
      await importRegistrationGstDeclaration(
        tx,
        shop.id,
        { declaredAt: draft.noGstDeclaredAt ?? new Date(), version: draft.noGstDeclarationVersion ?? GST_DECLARATION_VERSION },
        actor,
        draft.id,
      );
    }
    await tx
      .update(shopRegistrationDrafts)
      .set({
        status: "SUBMITTED",
        shopId: shop.id,
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shopRegistrationDrafts.id, draft.id));
  };

  const gstin = open.route === "GSTIN" && open.gstinEncrypted && (!later || CHECKED.has(open.gstStatus)) ? decryptSecret(open.gstinEncrypted) : null;
  const pan = open.panEncrypted && (!later || CHECKED.has(open.panStatus)) ? decryptSecret(open.panEncrypted) : null;
  let shop: Awaited<ReturnType<typeof registerShop>>;
  try {
    shop = await registerShop(
      {
        name: details.name,
        ownerName: details.ownerName,
        phone: details.phone,
        email: details.email,
        addressLine1: details.addressLine1,
        addressLine2: details.addressLine2,
        area: details.area,
        city: details.city,
        state: details.state,
        pincode: details.pincode,
        landmark: details.landmark,
        latitude: open.latitude,
        longitude: open.longitude,
        shopType: details.shopType,
        // Chosen after approval (CATEGORY step) when not given here.
        categoryIds: details.categoryIds?.length ? details.categoryIds : undefined,
        annualTurnoverRupees: details.annualTurnoverRupees,
        couponCode: details.couponCode,
        // A shop's referral code (0137) gives its discount and is recorded with the shop; a dealer code is attributed after.
        referralCode: looksLikeShopCode(referralCode) ? referralCode : undefined,
        gstin,
        panNumber: pan,
        panHolderName: panRecordName ?? details.ownerName,
        udyamNumber: plain(row("UDYAM"), open.hasUdyam === true),
        shopActNumber: plain(row("SHOP_ACT"), open.hasShopAct !== false),
      },
      actor,
      { onSaved },
    );
  } catch (error) {
    // A second tap (another tab) while the first created the shop: the owner lock made it wait, and
    // registerShop then refuses it as "already waiting". The first one's result is the answer.
    const current = await getWizardDraft(actor);
    if (current?.shop && current.status !== "OPEN") return current;
    throw error;
  }

  // After the commit, as POST /api/shops does: referral code and dealer attribution never block the registration.
  if (referralCode) await attributeRegistrationReferral(shop, referralCode, actor);
  await recordShopAttributionSafely(shop.id, actor, { employeeText: details.employeeId ?? null });
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_DRAFT_SUBMITTED,
    entityType: "shop_registration_draft",
    entityId: open.id,
    ipAddress: input.ipAddress ?? null,
    newValue: {
      shopId: shop.id,
      route: open.route,
      documentsLater: later,
      documents: imports.map((c) => ({ docType: c.docType, number: c.numberMasked, status: c.status })),
    },
  });
  // Nothing to pay (a full coupon): the approval runs now instead of on the payment webhook.
  if (registrationFeeDue(shop) === 0) {
    await autoApproveShopIfReady(shop.id).catch((error) => console.error("[registration-wizard] auto-approval check failed", shop.id, error));
  }
  const [final] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, open.id));
  return toWizardView(final);
}
