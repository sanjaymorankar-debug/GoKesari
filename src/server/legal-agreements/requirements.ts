/**
 * What a shop must sign now, and what that blocks (docs/seller-agreements-2026-11, brief §3 and §5):
 * - the current published version of each document that applies to the shop's type;
 * - again when a new version requiring re-acceptance has taken effect;
 * - again (re-confirmation) when Annexure A changed — a licence added, renewed or changed, or the shop's
 *   name, address or owner changed since the last signature.
 * Existing shops get a grace period (rule sellerAgreements.graceDays) from the first time they are asked,
 * then take no new orders until they sign. New registrations sign before paying, so no grace applies.
 * Signing is refused while a licence the shop type requires is missing or expired — except at an onboarding v2 / v3
 * registration that is not live yet: a missing licence may be uploaded after go-live (owner, 27-Nov-2026: every
 * licence incl. FSSAI) and an expired one renewed after go-live on the owner's promise (owner, 28-Nov-2026).
 * A live shop keeps the current policy (missing / expired block re-signing), and so does an original-wizard (v1)
 * registration (FSSAI first).
 */
import { and, desc, eq, isNull, lte } from "drizzle-orm";

import { conflict } from "@/lib/errors";
import { db } from "@/server/db";
import {
  legalAcceptances,
  legalDocumentSnapshots,
  legalShopAgreementStates,
  shopLegalDocuments,
  shopRegistrationDrafts,
  shops,
  type LegalLanguage,
  type Shop,
  type SigningReason,
} from "@/server/db/schema";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { legalDocLabel, requiredLegalDocTypes } from "@/server/services/legal-documents";
import { getRule } from "@/server/services/settings";
import { missingMustHaveDocuments } from "@/server/services/shop-document-rules";

import { materialFingerprint } from "./data";
import { calendarDate } from "./i18n";
import { currentDocumentsFor, type CurrentDocument, type SignedDocType } from "./registry";
import { buildShopSnapshot } from "./snapshot";

export const SELLER_AGREEMENTS_FLAG = "seller_agreements_enabled" as const;
export const MY_AGREEMENTS_URL = "/shop/agreements";

export type DocumentStatus = {
  docType: SignedDocType;
  version: string;
  title: string;
  legalDocumentId: string;
  languages: LegalLanguage[];
  /** The owner has signed this exact version (and Annexure A has not changed since). */
  signed: boolean;
  lastSignedVersion: string | null;
  lastSignedAt: string | null;
};

export type AgreementStatus = {
  enabled: boolean;
  shopId: string;
  shopName: string;
  required: boolean;
  reason: SigningReason | null;
  documents: DocumentStatus[];
  /** Licences that must be uploaded / renewed before the owner can sign. */
  blockers: string[];
  /**
   * Owner, 28-Nov-2026 (~11.50 IST): an onboarding v2 / v3 registration not live yet signs with an EXPIRED licence on
   * a renewal promise instead of being blocked — these are the expired ones (the signer ticks the promise).
   */
  renewals: LicenceRenewal[];
  graceUntil: string | null;
  /** Past the grace period: the shop takes no new orders until it signs. */
  overdue: boolean;
  /** No published Seller SLA yet: nothing to sign (and nothing blocks). */
  noPublishedDocuments: boolean;
};

async function loadShop(shopId: string): Promise<Shop> {
  const [shop] = await db.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt))).limit(1);
  if (!shop) throw new Error("Shop not found");
  return shop;
}

/** An expired licence a v2 / v3 registration may sign with on a renewal promise (owner, 28-Nov-2026). */
export type LicenceRenewal = {
  /** The licence's document type (shop_legal_documents.doc_type) — the key its renewal promise is recorded under. */
  key: string;
  label: string;
  /** The latest expiry date on file (YYYY-MM-DD). */
  expiredOn: string;
  /** Days the owner has to renew and upload it (rule shopDocumentFollowUp.promiseDays). */
  days: number;
  /** "<Licence> expired on <date> — renew and upload the new one within <N> days or the shop will be paused." */
  message: string;
};

/** The owner's line for an expired licence promised for renewal (also used by the registration licences screen). */
export function renewalLine(label: string, expiredOn: string, days: number): string {
  return `${label} expired on ${calendarDate(expiredOn)} — renew and upload the new one within ${days} days or the shop will be paused.`;
}

/** A licence the shop type requires that is missing, rejected or expired — signing waits for it. */
export async function licenceBlockers(shop: Pick<Shop, "id" | "shopType">, now: Date = new Date()): Promise<string[]> {
  return (await licenceSigningCheck(shop, now)).blockers;
}

/**
 * What licences mean for signing now: the blockers, and — for an onboarding v2 / v3 registration that is not live yet
 * — the expired licences that may be renewed after go-live on a promise (owner, 28-Nov-2026 ~11.50 IST). A live shop,
 * and a registration of the original wizard (v1, FSSAI first), keep the rule as it was: missing and expired block.
 */
export async function licenceSigningCheck(shop: Pick<Shop, "id" | "shopType">, now: Date = new Date()): Promise<{ blockers: string[]; renewals: LicenceRenewal[] }> {
  const today = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const [required, mustHave, rows, uploadLater, followUp] = await Promise.all([
    requiredLegalDocTypes(shop),
    missingMustHaveDocuments(shop),
    db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shop.id)),
    isV2RegistrationNotLive(shop.id),
    getRule("shopDocumentFollowUp"),
  ]);
  // Onboarding v2 (owner, 27-Nov-2026): a missing licence, FSSAI included, is uploaded after go-live on the
  // document follow-up grace period, so it does not hold up the agreement of a registration (owner, 28-Nov-2026: a
  // shop that is already live keeps the current policy — the missing licence blocks its re-signing as before).
  const blockers = uploadLater ? [] : mustHave.map((label) => `${label}: upload it first.`);
  const renewals: LicenceRenewal[] = [];
  for (const type of required) {
    const docs = rows.filter((r) => r.docType === type && (r.status === "SUBMITTED" || r.status === "APPROVED"));
    const label = legalDocLabel({ docType: type, licenceName: null });
    if (docs.length === 0) {
      if (!uploadLater && !blockers.some((b) => b.startsWith(label))) blockers.push(`${label}: upload it first.`);
      continue;
    }
    const valid = docs.some((d) => !d.expiryDate || d.expiryDate >= today);
    if (!valid) {
      const latest = docs.map((d) => d.expiryDate!).sort().at(-1)!;
      // Owner, 28-Nov-2026: an expired licence at a v2 / v3 registration is renewed after go-live on a promise.
      // DEFAULT – confirm with Sanjay: the same period as a missing promised licence (shopDocumentFollowUp.promiseDays).
      if (uploadLater) renewals.push({ key: type, label, expiredOn: latest, days: followUp.promiseDays, message: renewalLine(label, latest, followUp.promiseDays) });
      else blockers.push(`${label}: expired on ${calendarDate(latest)} — upload the renewed licence first.`);
    }
  }
  return { blockers, renewals };
}

/**
 * The shop was registered through onboarding v2 (any order, v3 included) and is not live yet: its licences may follow
 * after go-live. Owner, 28-Nov-2026: only registrations — a shop that went live keeps the seller-agreement policy.
 */
async function isV2RegistrationNotLive(shopId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: shopRegistrationDrafts.id })
    .from(shopRegistrationDrafts)
    .innerJoin(shops, eq(shops.id, shopRegistrationDrafts.shopId))
    .where(and(eq(shopRegistrationDrafts.shopId, shopId), eq(shopRegistrationDrafts.flowVersion, "v2"), eq(shops.status, "PENDING_APPROVAL")))
    .limit(1);
  return Boolean(row);
}

/** The latest acceptance of each document type for the shop, and the snapshot it was signed with. */
async function lastSigned(shopId: string) {
  const rows = await db
    .select({
      docType: legalAcceptances.docType,
      version: legalAcceptances.version,
      acceptedAt: legalAcceptances.acceptedAt,
      snapshotId: legalAcceptances.dataSnapshotId,
    })
    .from(legalAcceptances)
    .where(eq(legalAcceptances.shopId, shopId))
    .orderBy(desc(legalAcceptances.acceptedAt));
  const byType = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!byType.has(r.docType)) byType.set(r.docType, r);
  return { byType, latest: rows[0] ?? null };
}

function needsSignature(doc: CurrentDocument, signed: { version: string } | undefined): boolean {
  if (!signed) return true;
  if (signed.version === doc.version) return false;
  // A minor edit published without "requires re-acceptance" keeps an earlier signature valid.
  return doc.english.requiresResign;
}

/**
 * The shop's agreement status. `track` (default true) also records when a signature was first required
 * (starting the grace period) and when it was satisfied, for the order gate and the admin pending count.
 */
export async function getAgreementStatus(shopId: string, options: { track?: boolean; now?: Date } = {}): Promise<AgreementStatus> {
  const now = options.now ?? new Date();
  const shop = await loadShop(shopId);
  const enabled = await isFeatureEnabledForShop(SELLER_AGREEMENTS_FLAG, { pincode: shop.pincode });
  const base: AgreementStatus = {
    enabled,
    shopId,
    shopName: shop.name,
    required: false,
    reason: null,
    documents: [],
    blockers: [],
    renewals: [],
    graceUntil: null,
    overdue: false,
    noPublishedDocuments: false,
  };
  if (!enabled) return base;
  const current = await currentDocumentsFor(shop.shopType, now);
  if (!current.some((d) => d.docType === "SELLER_SLA")) return { ...base, noPublishedDocuments: true };

  const { byType, latest } = await lastSigned(shopId);
  let annexureChanged = false;
  if (latest?.snapshotId) {
    const [snap] = await db
      .select({ fingerprint: legalDocumentSnapshots.materialFingerprint })
      .from(legalDocumentSnapshots)
      .where(eq(legalDocumentSnapshots.id, latest.snapshotId))
      .limit(1);
    if (snap) {
      const fresh = await buildShopSnapshot(shopId, {}, db, now);
      annexureChanged = materialFingerprint(fresh) !== snap.fingerprint;
    }
  }

  const documents: DocumentStatus[] = current.map((doc) => {
    const signed = byType.get(doc.docType);
    return {
      docType: doc.docType,
      version: doc.version,
      title: doc.english.title,
      legalDocumentId: doc.english.id,
      languages: (["en", "mr", "hi"] as const).filter((l) => doc.languages[l]),
      signed: !needsSignature(doc, signed) && !annexureChanged,
      lastSignedVersion: signed?.version ?? null,
      lastSignedAt: signed?.acceptedAt.toISOString() ?? null,
    };
  });
  const required = documents.some((d) => !d.signed);
  const reason: SigningReason | null = !required
    ? null
    : !latest
      ? shop.status === "PENDING_APPROVAL"
        ? "REGISTRATION"
        : "EXISTING_SHOP"
      : documents.some((d) => d.lastSignedVersion && d.lastSignedVersion !== d.version)
        ? "NEW_VERSION"
        : annexureChanged
          ? "ANNEXURE_UPDATE"
          : "EXISTING_SHOP";

  let graceUntil: Date | null = null;
  if (options.track !== false) graceUntil = await trackState(shop, required, reason, now);
  else {
    const [state] = await db.select().from(legalShopAgreementStates).where(eq(legalShopAgreementStates.shopId, shopId)).limit(1);
    graceUntil = state && !state.satisfiedAt ? state.graceUntil : null;
  }
  const licenceCheck = required ? await licenceSigningCheck(shop, now) : { blockers: [], renewals: [] };
  return {
    ...base,
    required,
    reason,
    documents,
    blockers: licenceCheck.blockers,
    renewals: licenceCheck.renewals,
    graceUntil: graceUntil?.toISOString() ?? null,
    overdue: Boolean(required && reason !== "REGISTRATION" && graceUntil && graceUntil.getTime() <= now.getTime()),
  };
}

async function trackState(shop: Shop, required: boolean, reason: SigningReason | null, now: Date): Promise<Date | null> {
  const [state] = await db.select().from(legalShopAgreementStates).where(eq(legalShopAgreementStates.shopId, shop.id)).limit(1);
  if (!required) {
    if (state) {
      // Satisfied now (or still): the timestamp also rotates the daily sweep through every shop.
      await db
        .update(legalShopAgreementStates)
        .set({ satisfiedAt: state.satisfiedAt ?? now, updatedAt: now })
        .where(eq(legalShopAgreementStates.shopId, shop.id));
    } else {
      await db
        .insert(legalShopAgreementStates)
        .values({ shopId: shop.id, ownerUserId: shop.ownerId, reason: "EXISTING_SHOP", requiredSince: now, graceUntil: now, satisfiedAt: now, updatedAt: now })
        .onConflictDoNothing();
    }
    return null;
  }
  if (state && !state.satisfiedAt) return state.graceUntil;
  const { graceDays } = await getRule("sellerAgreements");
  const graceUntil = new Date(now.getTime() + graceDays * 86_400_000);
  await db
    .insert(legalShopAgreementStates)
    .values({ shopId: shop.id, ownerUserId: shop.ownerId, reason: reason ?? "EXISTING_SHOP", requiredSince: now, graceUntil, updatedAt: now })
    .onConflictDoUpdate({
      target: legalShopAgreementStates.shopId,
      set: { ownerUserId: shop.ownerId, reason: reason ?? "EXISTING_SHOP", requiredSince: now, graceUntil, satisfiedAt: null, reminderSentAt: null, updatedAt: now },
    });
  return graceUntil;
}

/** Marks the shop's open requirement satisfied (right after signing). */
export async function markSatisfied(shopId: string, requestId: string, now: Date = new Date()): Promise<void> {
  await db
    .update(legalShopAgreementStates)
    .set({ satisfiedAt: now, lastSigningRequestId: requestId, updatedAt: now })
    .where(and(eq(legalShopAgreementStates.shopId, shopId), isNull(legalShopAgreementStates.satisfiedAt)));
}

/**
 * Order acceptance (CONFIRMED → ACCEPTED / PREPARING): refused once an existing shop's grace period has
 * passed without a signature. Cheap: reads the tracked state only (kept by the Seller Central gate and the
 * daily sweep). Does nothing with the flag off.
 */
export async function assertAgreementsAllowOrders(shopId: string, now: Date = new Date()): Promise<void> {
  const [row] = await db
    .select({ name: shops.name, pincode: shops.pincode, graceUntil: legalShopAgreementStates.graceUntil, reason: legalShopAgreementStates.reason })
    .from(legalShopAgreementStates)
    .innerJoin(shops, eq(shops.id, legalShopAgreementStates.shopId))
    .where(and(eq(legalShopAgreementStates.shopId, shopId), isNull(legalShopAgreementStates.satisfiedAt), lte(legalShopAgreementStates.graceUntil, now)))
    .limit(1);
  if (!row) return;
  if (!(await isFeatureEnabledForShop(SELLER_AGREEMENTS_FLAG, { pincode: row.pincode }))) return;
  throw conflict(
    `${row.name} can't accept new orders until the owner signs the shop's agreements. Open Seller Central → My Agreements (${MY_AGREEMENTS_URL}) to review and sign.`,
    { sellerAgreements: { required: true, url: MY_AGREEMENTS_URL } },
  );
}

/** Registration: the fee may be paid only once the agreements are signed (flag on). */
export async function assertAgreementsSignedForPayment(shopId: string): Promise<void> {
  const status = await getAgreementStatus(shopId);
  if (!status.enabled || status.noPublishedDocuments || !status.required) return;
  throw conflict("Sign your shop's agreements before paying the registration fee.", { sellerAgreements: { required: true, url: `${MY_AGREEMENTS_URL}?shop=${shopId}` } });
}
