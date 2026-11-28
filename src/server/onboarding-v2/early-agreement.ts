/**
 * Shop onboarding, v3 order (owner, 28-Nov-2026; 0231; docs/onboarding-v2-2026-11/README.md "v3 order"). A v2 draft
 * started after this change carries flow_order 'v3' and follows:
 *
 *   1  referral code   (a guest gives it on /shop/register before the login sheet; saved once signed in)
 *   2  identity        the customer login sheet (Terms, e-mail code, mobile code) — skipped when both are verified —
 *                      and the seller agreement, accepted EARLY: the published template text (the shop's details do
 *                      not exist yet; the personalised copy with GST, name and address follows go-live), the goods
 *                      undertaking, the Seller Terms / Terms / Privacy tick, the promise to upload (or renew) licences
 *                      after go-live, and the owner's typed name. Stored on the draft (early_agreement_*).
 *   3  GST / PAN       (existing)        4  fee (existing)        5  shop type (existing)
 *   6  address + pin   (existing) — the shop's address becomes the owner's default delivery address (if none yet)
 *   7  live            the shop row is created and the stored acceptance applied automatically (personalised agreement
 *                      accepted at registration, seller undertaking, sla_accepted_at) → the existing go-live; no second
 *                      agreement screen. Signed copies (EN / MR / HI) e-mailed as today.
 *   8  licences        after go-live, every licence (FSSAI too) promised at shop creation — the existing documents
 *                      follow-up (90 days, reminders 1st / 15th, suspension, automatic reactivation on upload) applies.
 *
 * DEFAULT – confirm with Sanjay: the early acceptance is applied to the personalised agreement with the stored name,
 * time and IP when the shop is created; a document the owner did not see at step 2 (a newer version, or the medical
 * agreement of a medical shop) is still shown on the registration's agreement screen before go-live.
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { addresses, registrationLicenceEntries, shopRegistrationDrafts, shops, users, type LegalLanguage, type Shop, type ShopRegistrationDraft } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { auditActorOf, findOpenDraft, type Actor } from "@/server/services/shop-registration-draft";
import { SELLER_TERMS_VERSION, SELLER_UNDERTAKING_VERSION } from "@/lib/legal/seller-undertaking";
import { formatIstStamp } from "./roles";

/** A draft that follows the v3 order (0231). */
export function isV3Draft(draft: Pick<ShopRegistrationDraft, "flowVersion" | "flowOrder"> | null | undefined): boolean {
  return draft?.flowVersion === "v2" && draft.flowOrder === "v3";
}

type SignedDocType = "SELLER_SLA" | "MEDICAL_ONBOARDING";

/** A published agreement text shown at step 2 (the generic version every shop type signs). */
export interface EarlyAgreementDoc {
  docType: SignedDocType;
  version: string;
  title: string;
  legalDocumentId: string;
  languages: LegalLanguage[];
}

/** What the draft keeps of the early acceptance (early_agreement_documents). */
export interface EarlyAgreementRecord {
  documents: { docType: SignedDocType; version: string; legalDocumentId: string; templateSha256: string | null }[];
  /** seller_agreements_enabled was on (the personalised agreements are accepted); off: the Seller Terms tick. */
  agreementsEnabled: boolean;
  sellerTermsVersion: string;
  undertakingVersion: string;
  policiesAccepted: true;
  undertakingAccepted: true;
  /** "I will upload — or renew — every licence my shop needs within <days> days of going live." */
  licencePromiseAccepted: true;
  promiseDays: number;
}

export interface EarlyAgreementView {
  accepted: boolean;
  acceptedAtIst: string | null;
  name: string | null;
  applied: boolean;
  agreementsEnabled: boolean;
  documents: EarlyAgreementDoc[];
  /** Days a licence may follow go-live (rule shopDocumentFollowUp.promiseDays). */
  promiseDays: number;
}

/** The published texts step 2 shows: those that apply to every shop type (the shop type is chosen later). */
export async function earlyAgreementDocuments(): Promise<{ agreementsEnabled: boolean; documents: EarlyAgreementDoc[] }> {
  const { SELLER_AGREEMENTS_FLAG } = await import("@/server/legal-agreements/requirements");
  // The shop's PIN code is not known yet: the flag's all-districts setting decides.
  const enabled = await isFeatureEnabledForShop(SELLER_AGREEMENTS_FLAG, { pincode: null });
  if (!enabled) return { agreementsEnabled: false, documents: [] };
  const { currentDocumentsFor } = await import("@/server/legal-agreements/registry");
  const current = (await currentDocumentsFor("")).filter((d) => d.english.appliesToShopTypes.length === 0);
  if (!current.some((d) => d.docType === "SELLER_SLA")) return { agreementsEnabled: false, documents: [] };
  return {
    agreementsEnabled: true,
    documents: current.map((d) => ({
      docType: d.docType,
      version: d.version,
      title: d.english.title,
      legalDocumentId: d.english.id,
      languages: (["en", "mr", "hi"] as const).filter((l) => d.languages[l]),
    })),
  };
}

export async function earlyAgreementView(draft: ShopRegistrationDraft): Promise<EarlyAgreementView> {
  const { promiseDays } = await getRule("shopDocumentFollowUp");
  const record = draft.earlyAgreementDocuments as EarlyAgreementRecord | null;
  if (draft.earlyAgreementAcceptedAt && record) {
    return {
      accepted: true,
      acceptedAtIst: formatIstStamp(draft.earlyAgreementAcceptedAt),
      name: draft.earlyAgreementName,
      applied: draft.earlyAgreementAppliedAt !== null,
      agreementsEnabled: record.agreementsEnabled,
      documents: [],
      promiseDays,
    };
  }
  const { agreementsEnabled, documents } = draft.status === "OPEN" ? await earlyAgreementDocuments() : { agreementsEnabled: false, documents: [] };
  return { accepted: false, acceptedAtIst: null, name: null, applied: false, agreementsEnabled, documents, promiseDays };
}

/**
 * The template text of one early document for the viewer: the published version filled with the platform's real
 * figures (fees, commission, charges) and bracketed placeholders where the shop's own details go.
 */
export async function earlyAgreementHtml(docType: SignedDocType, lang: LegalLanguage): Promise<{ html: string; version: string; title: string }> {
  const { documents } = await earlyAgreementDocuments();
  if (!documents.some((d) => d.docType === docType)) throw notFound("Agreement");
  const { currentDocumentsFor } = await import("@/server/legal-agreements/registry");
  const doc = (await currentDocumentsFor("")).find((d) => d.docType === docType);
  const row = doc?.languages[lang] ?? doc?.languages.en;
  if (!doc || !row) throw notFound("Agreement in this language");
  const snapshot = await templateSnapshot();
  const { renderAgreementHtml } = await import("@/server/legal-agreements/render");
  const rendered = renderAgreementHtml(row, snapshot, { effectiveAt: new Date(), signature: { signed: false }, preview: true });
  return { html: rendered.html, version: row.version, title: row.title };
}

/** The agreement data before the shop exists: the real platform terms, placeholders for the shop. */
async function templateSnapshot() {
  const [{ sampleSnapshot }, { baseRegistrationFee }, { resolveCommissionRate }] = await Promise.all([
    import("@/server/legal-agreements/sample"),
    import("@/server/services/registration-fee-coupons"),
    import("@/server/services/finance"),
  ]);
  const [rule, fee, commission, settlement, acceptance, wallet] = await Promise.all([
    getRule("sellerAgreements"),
    baseRegistrationFee(null),
    resolveCommissionRate({ id: "00000000-0000-0000-0000-000000000000", shopType: "" }),
    getRule("settlement"),
    getRule("shopAcceptance"),
    getRule("shopWallet"),
  ]);
  const shopText = "[your shop — filled in from your GST / PAN record]";
  return sampleSnapshot({
    seller: {
      legalName: "[your business's legal name]",
      tradeName: shopText,
      constitution: null,
      addressLine: "[your shop's address]",
      pincode: "[PIN]",
      googleLocationUrl: null,
      sellerId: "[given at registration]",
      shopTypeKeys: [],
      shopTypeLabels: ["[your shop type]"],
      isMedical: false,
    },
    owner: { name: "[your name]", designation: null, mobileMasked: "[your mobile]", email: "[your e-mail]" },
    complaintContact: "[your name, mobile and e-mail]",
    ids: { pan: "[PAN]", gstin: "[GSTIN]", shopAct: null, udyam: null, fssai: null },
    pharmacist: null,
    bankLast4: null,
    licences: [],
    fees: {
      registrationFeePaise: fee.basePaise,
      wholesaleRegistrationFeePaise: rule.wholesaleRegistrationFeePaise,
      commissionBp: commission.rateBp,
      settlementDays: settlement.holdDays,
      acceptMinutes: acceptance.acceptMinutes,
      walletMinimumPaise: wallet.minBalancePaise,
      medicineShelfLifeMonths: rule.medicineShelfLifeMonths,
      perOrderCommissionPaise: rule.perOrderCommissionPaise,
      billingManagementFeePaise: rule.billingManagementFeePaise,
    },
    slaChargesPaise: rule.slaChargesPaise,
    platform: { signatoryName: rule.platformSignatoryName, signatoryDesignation: rule.platformSignatoryDesignation, boardResolutionDate: rule.boardResolutionDate || null, eSealAssetId: null },
  });
}

/**
 * Step 2 (v3): the owner accepts the seller agreement before the shop exists — every published text ticked (with the
 * version shown), the Seller Terms / Terms / Privacy, the goods undertaking, the promise to upload or renew licences
 * after go-live, and the typed name. Stored on the draft; applied when the shop is created (applyEarlyAgreement).
 * Only the owner (the route refuses staff). Accepting again before the shop exists replaces the earlier acceptance.
 */
export async function acceptV3EarlyAgreement(
  actor: Actor,
  input: {
    signerName: string;
    accepted: { docType: SignedDocType; version: string }[];
    acceptPolicies: boolean;
    acceptUndertaking: boolean;
    acceptLicencePromise: boolean;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  const draft = await findOpenDraft(actor.id);
  if (!draft) throw notFound("Registration in progress");
  if (!isV3Draft(draft)) throw conflict("This registration follows the earlier steps.", { reason: "NOT_V3" });
  const signerName = input.signerName.trim().replace(/\s+/g, " ");
  if (signerName.length < 3 || signerName.length > 120 || !/\p{L}/u.test(signerName)) {
    throw validationFailed("Type your full name as it should appear on the agreement.", { fields: { signerName: "Type your full name." } });
  }
  const fields: Record<string, string> = {};
  if (input.acceptPolicies !== true) fields.acceptPolicies = "Required.";
  if (input.acceptUndertaking !== true) fields.acceptUndertaking = "Required.";
  if (input.acceptLicencePromise !== true) fields.acceptLicencePromise = "Required.";
  const { agreementsEnabled, documents } = await earlyAgreementDocuments();
  for (const d of documents) {
    const ticked = input.accepted.find((a) => a.docType === d.docType);
    if (!ticked) fields[`accept_${d.docType}`] = `Tick "${d.title}" to accept it.`;
    else if (ticked.version !== d.version) throw conflict(`A newer version (${d.version}) of the ${d.title} has been published. Please read it again.`, { reload: true });
  }
  if (Object.keys(fields).length > 0) throw validationFailed("Tick each box to accept the seller agreement.", { reason: "SELLER_ACCEPTANCE_REQUIRED", fields });
  const { promiseDays } = await getRule("shopDocumentFollowUp");
  const { currentDocumentsFor } = await import("@/server/legal-agreements/registry");
  const current = agreementsEnabled ? await currentDocumentsFor("") : [];
  const record: EarlyAgreementRecord = {
    documents: documents.map((d) => ({ docType: d.docType, version: d.version, legalDocumentId: d.legalDocumentId, templateSha256: current.find((c) => c.docType === d.docType)?.english.templateSha256 ?? null })),
    agreementsEnabled,
    sellerTermsVersion: SELLER_TERMS_VERSION,
    undertakingVersion: SELLER_UNDERTAKING_VERSION,
    policiesAccepted: true,
    undertakingAccepted: true,
    licencePromiseAccepted: true,
    promiseDays,
  };
  const now = new Date();
  const [updated] = await db
    .update(shopRegistrationDrafts)
    .set({
      earlyAgreementAcceptedAt: now,
      earlyAgreementName: signerName,
      earlyAgreementIp: input.ip ?? null,
      earlyAgreementUserAgent: input.userAgent?.slice(0, 500) ?? null,
      earlyAgreementDocuments: record as unknown as Record<string, unknown>,
      updatedAt: now,
    })
    .where(and(eq(shopRegistrationDrafts.id, draft.id), eq(shopRegistrationDrafts.status, "OPEN"), isNull(shopRegistrationDrafts.earlyAgreementAppliedAt)))
    .returning();
  if (!updated) throw conflict("Your registration changed. Please reload the page.", { reason: "DRAFT_CHANGED" });
  await recordAudit({
    ...auditActorOf(actor),
    action: AUDIT_ACTIONS.SHOP_REGISTRATION_EARLY_AGREEMENT_ACCEPTED,
    entityType: "shop_registration_draft",
    entityId: draft.id,
    ipAddress: input.ip ?? null,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
    newValue: { signerName, documents: record.documents, agreementsEnabled, sellerTermsVersion: SELLER_TERMS_VERSION, undertakingVersion: SELLER_UNDERTAKING_VERSION, licencePromise: true, promiseDays },
  });
  const { toWizardView } = await import("@/server/services/shop-registration-wizard");
  return toWizardView(updated);
}

/**
 * v3, just before the shop row is created: every licence the shop type needs that was not given (none is asked
 * before go-live in v3) is promised — the same state "Upload later" produces (registration_licence_entries LATER /
 * PROMISED, documents_promised_at), on the promise ticked at step 2 — so the existing documents follow-up applies.
 */
export async function promiseV3Licences(draft: ShopRegistrationDraft, licences: { key: string; done: boolean }[]): Promise<number> {
  const open = licences.filter((l) => !l.done);
  if (open.length === 0) return 0;
  const at = draft.earlyAgreementAcceptedAt ?? new Date();
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const l of open) {
      await tx
        .insert(registrationLicenceEntries)
        .values({
          draftId: draft.id,
          ownerUserId: draft.ownerId,
          licenceKey: l.key,
          option: "LATER",
          status: "PROMISED",
          statusReason: "To upload after go-live (promised at registration).",
          promiseAcceptedAt: at,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }
    await tx
      .update(shopRegistrationDrafts)
      .set({ documentsPromisedAt: draft.documentsPromisedAt ?? at, updatedAt: now })
      .where(eq(shopRegistrationDrafts.id, draft.id));
  });
  return open.length;
}

/**
 * v3, right after the shop row is created: the stored early acceptance is applied — the personalised agreement
 * accepted at registration (signing.ts applyEarlyRegistrationAcceptance), the seller undertaking (and the Seller Terms
 * when the agreements are off), sla_accepted_at — then the existing go-live and the signed-copy e-mail. Also saves the
 * shop's address as the owner's delivery address. Idempotent; never throws for the owner (a failure leaves the
 * registration on its agreement screen, where the owner can accept by hand).
 */
export async function finishV3Registration(draftId: string, actor: Actor): Promise<void> {
  const [draft] = await db.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, draftId));
  if (!draft?.shopId || !isV3Draft(draft)) return;
  const [shop] = await db.select().from(shops).where(eq(shops.id, draft.shopId));
  if (!shop) return;
  await saveShopAddressForOwner(shop);
  if (draft.slaAcceptedAt || !draft.earlyAgreementAcceptedAt || !draft.earlyAgreementName) return;
  const record = draft.earlyAgreementDocuments as EarlyAgreementRecord | null;
  if (!record) return;
  const shopId = draft.shopId;
  try {
    const { ensureV2FeeOnLedger, goLiveV2 } = await import("./shop-flow");
    await ensureV2FeeOnLedger(shopId).catch((error: unknown) => console.error("[onboarding-v3] fee ledger retry failed", shopId, error));
    const { getAgreementStatus } = await import("@/server/legal-agreements/requirements");
    const status = await getAgreementStatus(shopId);
    const signedInAgreements = status.enabled && !status.noPublishedDocuments;
    let signed: { signingRequestId: string } | null = null;
    if (signedInAgreements && status.required) {
      const { applyEarlyRegistrationAcceptance, loadOwner } = await import("@/server/legal-agreements/signing");
      const { owner } = await loadOwner(shopId);
      signed = await applyEarlyRegistrationAcceptance(
        { shopId, owner },
        {
          signerName: draft.earlyAgreementName,
          accepted: record.documents.map((d) => ({ docType: d.docType, version: d.version })),
          acceptedAt: draft.earlyAgreementAcceptedAt,
          ip: draft.earlyAgreementIp,
          userAgent: draft.earlyAgreementUserAgent,
          // The step-2 promise covers renewing an expired licence too (owner, 28-Nov-2026).
          renewalPromise: record.licencePromiseAccepted === true,
          draftId: draft.id,
        },
      );
      // Something the owner did not see at step 2 is still to sign: the agreement screen shows it.
      if ((await getAgreementStatus(shopId, { track: false })).required) return;
    }
    const { acceptSellerUndertaking } = await import("@/server/services/seller-undertaking");
    const acceptedAt = draft.earlyAgreementAcceptedAt;
    const now = new Date();
    const applied = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(shopRegistrationDrafts).where(eq(shopRegistrationDrafts.id, draft.id)).for("update");
      if (!locked || locked.slaAcceptedAt) return false;
      await acceptSellerUndertaking({
        userId: shop.ownerId,
        shopIds: [shopId],
        ip: draft.earlyAgreementIp,
        userAgent: draft.earlyAgreementUserAgent,
        actorRole: null,
        client: tx,
        includeTerms: !signedInAgreements,
      });
      await tx.update(shopRegistrationDrafts).set({ slaAcceptedAt: acceptedAt, earlyAgreementAppliedAt: now, updatedAt: now }).where(eq(shopRegistrationDrafts.id, draft.id));
      return true;
    });
    if (!applied) return;
    await recordAudit({
      ...auditActorOf(actor),
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_SLA_ACCEPTED,
      entityType: "shop",
      entityId: shopId,
      ipAddress: draft.earlyAgreementIp,
      newValue: { draftId: draft.id, signedAgreements: signedInAgreements, earlyAcceptance: true, acceptedAt: acceptedAt.toISOString() },
    });
    await recordAudit({
      ...auditActorOf(actor),
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_EARLY_AGREEMENT_APPLIED,
      entityType: "shop_registration_draft",
      entityId: draft.id,
      ipAddress: draft.earlyAgreementIp,
      newValue: {
        shopId,
        acceptedAt: acceptedAt.toISOString(),
        signerName: draft.earlyAgreementName,
        signingRequestId: signed?.signingRequestId ?? null,
        documents: record.documents,
        sellerTermsTicked: !signedInAgreements,
      },
    });
    await goLiveV2(shopId);
    // docs/flows-v3/wave3.md (flag flow_f4): the accepted agreement is e-mailed now, in English, Marathi and Hindi.
    await (await import("@/server/flows/f4-onboarding")).emailAgreementOnAcceptance(shopId, now);
  } catch (error) {
    console.error("[onboarding-v3] early agreement not applied — the agreement screen asks for it", shopId, error);
  }
}

/**
 * E (owner, 28-Nov-2026): the shop's address and map pin become a saved delivery address of the owner ("Shop"),
 * the default only when the owner has no default address yet. Later the owner adds home / office addresses and picks
 * one at checkout (the saved-addresses feature). Idempotent: an address with the same label, first line and PIN is not
 * added twice. Never fails the registration.
 * DEFAULT – confirm with Sanjay: saved as type "Work", labelled "Shop", recipient = the shop's owner name and mobile.
 */
export async function saveShopAddressForOwner(shop: Shop): Promise<string | null> {
  try {
    const existing = await db
      .select({ id: addresses.id, label: addresses.label, line1: addresses.line1, pincode: addresses.pincode, isDefault: addresses.isDefault })
      .from(addresses)
      .where(and(eq(addresses.userId, shop.ownerId), isNull(addresses.deletedAt)));
    const same = existing.find((a) => a.label === "Shop" && a.line1.trim() === shop.addressLine1.trim() && a.pincode === shop.pincode);
    if (same) return same.id;
    const [owner] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, shop.ownerId));
    const phone = (shop.phone ?? owner?.phone ?? "").replace(/\D/g, "").slice(-10);
    const { createAddress } = await import("@/server/services/addresses");
    const lat = shop.latitude != null ? Number(shop.latitude) : null;
    const lng = shop.longitude != null ? Number(shop.longitude) : null;
    const created = await createAddress(shop.ownerId, {
      label: "Shop",
      addressType: "WORK",
      recipientName: shop.ownerName ?? null,
      recipientPhone: /^[6-9]\d{9}$/.test(phone) ? phone : null,
      line1: shop.addressLine1,
      line2: shop.addressLine2 ?? null,
      area: shop.area ?? null,
      city: shop.city,
      state: shop.state ?? null,
      pincode: shop.pincode,
      landmark: shop.landmark ?? null,
      latitude: lat !== null && Number.isFinite(lat) ? lat : null,
      longitude: lng !== null && Number.isFinite(lng) ? lng : null,
      isDefault: !existing.some((a) => a.isDefault),
    });
    return created.id;
  } catch (error) {
    console.error("[onboarding-v3] shop address not saved as a delivery address", shop.id, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * After go-live (v3): the licences screen was answered — "Upload now" (the owner goes to My shop → Documents) or
 * "Later" (the follow-up reminds them). Either way the wizard moves on to products.
 */
export async function answerV3PostLiveLicences(actor: Actor) {
  const [draft] = await db
    .select()
    .from(shopRegistrationDrafts)
    .where(and(eq(shopRegistrationDrafts.ownerId, actor.id), eq(shopRegistrationDrafts.flowVersion, "v2"), inArray(shopRegistrationDrafts.status, ["SUBMITTED", "COMPLETED"])))
    .orderBy(desc(shopRegistrationDrafts.updatedAt))
    .limit(1);
  if (!draft?.shopId || !isV3Draft(draft)) throw notFound("Registration");
  const [updated] = await db
    .update(shopRegistrationDrafts)
    .set({ details: { ...((draft.details as Record<string, unknown> | null) ?? {}), v3LicencesAnswered: true }, updatedAt: new Date() })
    .where(eq(shopRegistrationDrafts.id, draft.id))
    .returning();
  const { toWizardView } = await import("@/server/services/shop-registration-wizard");
  return toWizardView(updated);
}

/**
 * A: a guest's referral code on /shop/register, checked with the same rule as the REFERRAL step
 * (assertRegistrationReferralCode: a required code, an unknown or closed one refused). Returns the code as it will be
 * saved, or null for "I don't have one" (only when the admin setting does not require a code).
 */
export async function checkGuestShopReferral(raw: string | null): Promise<{ code: string | null }> {
  const { assertRegistrationReferralCode } = await import("@/server/services/referral-requests");
  return { code: await assertRegistrationReferralCode(raw) };
}

/** Where a referral saved without the REFERRAL screen came from. */
export type AutoReferralSource = "GUEST_CONFIRMED" | "SHARED_LINK";

/**
 * Owner, 28-Nov-2026 (~11.45 IST): a shared link's code (/r/<code> → the gk_ref_link cookie, or /shop/register?ref=)
 * is checked silently. Valid: the referral step is never shown. Missing / invalid / expired: the step shows, with a
 * plain message for an invalid code.
 */
export async function checkLinkReferral(raw: string | null): Promise<{ ok: true; code: string } | { ok: false; message: string | null }> {
  if (!raw?.trim()) return { ok: false, message: null };
  try {
    const { code } = await checkGuestShopReferral(raw);
    return code ? { ok: true, code } : { ok: false, message: null };
  } catch (error) {
    const details = (error as { details?: { fields?: { referralCode?: string } } }).details;
    const reason = details?.fields?.referralCode ?? (error instanceof Error ? error.message : null);
    return { ok: false, message: `The referral code in your link (${raw.trim().toUpperCase()}) can't be used${reason ? `: ${reason.replace(/\.$/, "")}` : ""}. Enter another code${(await (await import("@/server/services/referral-settings")).isReferralRequired("shop")) ? "" : ", or continue without one"}.` };
  }
}

/**
 * A: the referral saved without the REFERRAL screen, with the REFERRAL step's own function — the code the guest
 * confirmed on /shop/register before the login sheet (?confirmed=1), or (owner, 28-Nov-2026 ~11.45 IST) a shared
 * link's code, checked silently (v3 drafts only; a v2 draft keeps its referral screen). Only while the draft's
 * referral is unanswered. Recorded on the draft (details.referralSource) and in the audit log. A refused code leaves
 * the REFERRAL step to ask.
 */
export async function applyGuestReferral(actor: Actor, code: string | null, source: AutoReferralSource = "GUEST_CONFIRMED"): Promise<boolean> {
  const draft = await findOpenDraft(actor.id);
  if (!draft || draft.flowVersion !== "v2" || draft.referralAnsweredAt !== null || draft.route !== null) return false;
  if (source === "SHARED_LINK" && (!isV3Draft(draft) || !code)) return false;
  try {
    const { answerDraftReferral } = await import("@/server/services/shop-registration-wizard");
    const saved = await answerDraftReferral({ actor, referralCode: code });
    const fresh = await findOpenDraft(actor.id);
    await db
      .update(shopRegistrationDrafts)
      .set({ details: { ...((fresh?.details as Record<string, unknown> | null) ?? {}), referralSource: source } })
      .where(eq(shopRegistrationDrafts.id, draft.id));
    await recordAudit({
      ...auditActorOf(actor),
      action: AUDIT_ACTIONS.SHOP_REGISTRATION_REFERRAL_AUTO_APPLIED,
      entityType: "shop_registration_draft",
      entityId: draft.id,
      newValue: { referralCode: saved.referral.code, source },
    });
    return true;
  } catch (error) {
    console.warn("[onboarding-v3] referral not saved automatically — the referral step asks", error instanceof Error ? error.message : error);
    return false;
  }
}
