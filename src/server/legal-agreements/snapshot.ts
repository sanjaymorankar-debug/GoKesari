/**
 * Reads everything an agreement is filled with from the shop's own registration data
 * (docs/seller-agreements-2026-11, brief §2): names, address, owner, identity numbers, every licence on file,
 * the verified bank account (last 4 only), and the fee / penalty figures from the admin configuration.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { maskPhone } from "@/lib/phone";
import { decryptSecret } from "@/lib/pan-crypto";
import { shopTypeLabel } from "@/lib/shop-types";
import { db, type DbClient } from "@/server/db";
import { healthPharmacyProfiles } from "@/server/db/health-schema";
import { bankAccounts, registrationLicenceEntries, sellerVerifications, shopLegalDocuments, shops, users, type Shop } from "@/server/db/schema";
import { resolveCommissionRate } from "@/server/services/finance";
import { resolveFeeForNewRegistration } from "@/server/services/registration-fees";
import { getRule } from "@/server/services/settings";

import { DECLARED_AT_SIGNING, type AgreementSnapshot, type LicenceRow, type LicenceStatus } from "./data";
import type { Constitution, Designation } from "./i18n";

/** Shop types the medical agreement applies to by default (admin can change it per version). */
export const DEFAULT_MEDICAL_SHOP_TYPES = ["PHARMACY"];

function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

/** The PAN's fourth letter says who holds it: P person, F firm / LLP, C company. The signer confirms it. */
export function constitutionFromPan(pan: string | null): Constitution | null {
  const letter = pan?.trim().toUpperCase()[3];
  if (letter === "P") return "PROPRIETORSHIP";
  if (letter === "F") return "PARTNERSHIP";
  if (letter === "C") return "COMPANY";
  return null;
}

function mapsUrl(lat: string | null, lng: string | null): string | null {
  const a = Number(lat);
  const b = Number(lng);
  if (!lat || !lng || !Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
  return `https://maps.google.com/?q=${a.toFixed(6)},${b.toFixed(6)}`;
}

function drugKind(number: string): string {
  return /\b2[01]\s*-?\s*B\b|20B|21B/i.test(number) ? "DRUG_LICENCE_WHOLESALE" : "DRUG_LICENCE_RETAIL";
}

const docRef = (id: string) => `GK-DOC-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;

export type SnapshotExtras = {
  /** Chosen by the signer on the Agreements screen. */
  constitution?: Constitution | null;
  designation?: Designation | null;
  signerName?: string | null;
  /** Medical shops without a pharmacy profile: the pharmacist the owner names at signing. */
  pharmacist?: { name: string; registrationNumber: string } | null;
};

export async function buildShopSnapshot(shopId: string, extras: SnapshotExtras = {}, client: DbClient = db, now: Date = new Date()): Promise<AgreementSnapshot> {
  const [shop] = await client.select().from(shops).where(and(eq(shops.id, shopId), isNull(shops.deletedAt))).limit(1);
  if (!shop) throw new Error(`Shop ${shopId} not found`);
  const [owner] = await client.select({ name: users.name, email: users.email, phoneE164: users.phoneE164 }).from(users).where(eq(users.id, shop.ownerId)).limit(1);

  const [legalDocs, verifications, pharmacy, bank, fee, commission, settlement, acceptance, wallet, rule] = await Promise.all([
    client
      .select()
      .from(shopLegalDocuments)
      .where(and(eq(shopLegalDocuments.shopId, shopId), inArray(shopLegalDocuments.status, ["SUBMITTED", "APPROVED"])))
      .orderBy(shopLegalDocuments.docType, shopLegalDocuments.createdAt),
    client.select().from(sellerVerifications).where(eq(sellerVerifications.shopId, shopId)),
    client
      .select()
      .from(healthPharmacyProfiles)
      .where(eq(healthPharmacyProfiles.shopId, shopId))
      .limit(1)
      .catch(() => []),
    client
      .select({ last4: bankAccounts.accountNumberLast4, status: bankAccounts.status })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.shopId, shopId), eq(bankAccounts.isCurrent, true), eq(bankAccounts.method, "BANK_ACCOUNT")))
      .orderBy(desc(bankAccounts.createdAt)),
    resolveFeeForNewRegistration(client),
    resolveCommissionRate(shop, client),
    getRule("settlement"),
    getRule("shopAcceptance"),
    getRule("shopWallet"),
    getRule("sellerAgreements"),
  ]);

  const pan = safeDecrypt(shop.panNumberEncrypted);
  const verification = (type: string) => verifications.find((v) => v.docType === type);
  const vStatus = (type: string): LicenceStatus => {
    const v = verification(type);
    return v?.status === "VERIFIED" ? "VERIFIED" : v && v.status !== "NOT_SUBMITTED" && v.status !== "FAILED" ? "SUBMITTED" : "PENDING";
  };

  const licences: LicenceRow[] = [];
  for (const d of legalDocs) {
    const number = safeDecrypt(d.numberEncrypted) ?? (d.numberLast4 ? `…${d.numberLast4}` : null);
    if (!number) continue;
    licences.push({
      kind: d.docType === "DRUG_LICENCE" ? drugKind(number) : d.docType,
      customName: d.docType === "OTHER_LICENCE" ? d.licenceName : null,
      number,
      authority: d.issuingCouncil?.trim() || null,
      validFrom: null,
      validUntil: d.expiryDate ?? null,
      status: d.status === "APPROVED" ? "VERIFIED" : "SUBMITTED",
      reference: docRef(d.id),
      sourceId: d.id,
    });
  }
  const fssaiOnFile = licences.some((l) => l.kind === "FSSAI");
  if (shop.fssaiLicenseNumber && !fssaiOnFile) {
    const v = verification("FSSAI");
    licences.push({ kind: "FSSAI", customName: null, number: shop.fssaiLicenseNumber, authority: "FSSAI", validFrom: null, validUntil: v?.validUntil ?? null, status: vStatus("FSSAI"), reference: "FSSAI check", sourceId: v?.id ?? null });
  }
  if (shop.gstin) {
    licences.push({ kind: "GSTIN", customName: null, number: shop.gstin, authority: "GST Network", validFrom: null, validUntil: null, status: shop.gstVerifiedAt ? "VERIFIED" : vStatus("GSTIN"), reference: "GST portal", sourceId: verification("GSTIN")?.id ?? null });
  }
  if (pan) {
    licences.push({ kind: "PAN", customName: null, number: pan, authority: "Income Tax Department", validFrom: null, validUntil: null, status: shop.panVerifiedAt ? "VERIFIED" : vStatus("PAN"), reference: "PAN check", sourceId: verification("PAN")?.id ?? null });
  }
  if (shop.shopActNumber) {
    const v = verification("SHOP_ACT");
    licences.push({ kind: "SHOP_ACT", customName: null, number: shop.shopActNumber, authority: null, validFrom: null, validUntil: v?.validUntil ?? null, status: vStatus("SHOP_ACT"), reference: v ? docRef(v.id) : "Registration form", sourceId: v?.id ?? null });
  }
  if (shop.udyamNumber) {
    licences.push({ kind: "UDYAM", customName: null, number: shop.udyamNumber, authority: "Ministry of MSME", validFrom: null, validUntil: null, status: vStatus("UDYAM"), reference: "Udyam check", sourceId: verification("UDYAM")?.id ?? null });
  }
  // docs/onboarding-v2-2026-11 (Flow 2): licences given at registration (entered / uploaded / scanned) that are not on
  // file yet any other way — the agreement lists what the owner entered. "Upload later" ones have no number.
  const registrationLicences = await client
    .select()
    .from(registrationLicenceEntries)
    .where(and(eq(registrationLicenceEntries.shopId, shopId), isNotNull(registrationLicenceEntries.licenceNumber)))
    .catch(() => []);
  for (const e of registrationLicences) {
    if (!e.licenceNumber || e.status === "REJECTED" || licences.some((l) => l.kind === e.licenceKey)) continue;
    const custom = e.licenceKey.startsWith("DOC:");
    licences.push({
      kind: custom ? "OTHER_LICENCE" : e.licenceKey,
      customName: custom ? e.licenceKey.slice(4) : null,
      number: e.licenceNumber,
      authority: e.issuingAuthority,
      validFrom: null,
      validUntil: e.validUntil,
      status: e.status === "VERIFIED" ? "VERIFIED" : "SUBMITTED",
      reference: "Shop registration",
      sourceId: e.id,
    });
  }
  const profile = pharmacy[0];
  const pharmacist = profile
    ? { name: profile.pharmacistName, registrationNumber: profile.pharmacistRegistrationNumber, council: profile.pharmacyCouncil ?? null }
    : extras.pharmacist
      ? { ...extras.pharmacist, council: null }
      : null;
  if (pharmacist) {
    licences.push({
      kind: "PHARMACIST",
      customName: null,
      number: `${pharmacist.name} – ${pharmacist.registrationNumber}`,
      authority: pharmacist.council,
      validFrom: null,
      validUntil: null,
      status: profile?.verification === "VERIFIED" ? "VERIFIED" : profile ? "SUBMITTED" : "PENDING",
      reference: profile ? "Pharmacy profile" : DECLARED_AT_SIGNING,
      sourceId: null,
    });
    if (profile && !licences.some((l) => l.kind.startsWith("DRUG_LICENCE"))) {
      licences.push({ kind: drugKind(profile.drugLicenceNumber), customName: null, number: profile.drugLicenceNumber, authority: null, validFrom: null, validUntil: null, status: profile.verification === "VERIFIED" ? "VERIFIED" : "SUBMITTED", reference: "Pharmacy profile", sourceId: null });
    }
  }

  const ownerName = (extras.signerName ?? owner?.name ?? shop.ownerName ?? "").trim() || shop.ownerName;
  const mobile = owner?.phoneE164 ?? (shop.phone ? `+91${shop.phone.replace(/\D/g, "").slice(-10)}` : null);
  const email = owner?.email && !/@(placeholder|users\.gokesari)/i.test(owner.email) ? owner.email : shop.email;
  const verifiedBank = bank.find((b) => b.status === "VERIFIED") ?? null;
  const addressLine = [shop.addressLine1, shop.addressLine2, shop.landmark, shop.area, shop.city, shop.state].filter((p) => p && p.trim()).join(", ");

  return {
    schema: 1,
    shopId: shop.id,
    ownerUserId: shop.ownerId,
    seller: {
      legalName: (shop.legalBusinessName ?? shop.gstTradeName ?? shop.name).trim(),
      tradeName: shop.name.trim(),
      constitution: extras.constitution ?? constitutionFromPan(pan),
      addressLine,
      pincode: shop.pincode,
      googleLocationUrl: mapsUrl(shop.latitude, shop.longitude),
      sellerId: shop.registrationNumber ?? shop.id.slice(0, 8).toUpperCase(),
      shopTypeKeys: [shop.shopType],
      shopTypeLabels: [shopTypeLabel(shop.shopType)],
      isMedical: DEFAULT_MEDICAL_SHOP_TYPES.includes(shop.shopType),
    },
    owner: { name: ownerName, designation: extras.designation ?? null, mobileMasked: mobile ? maskPhone(mobile) : null, email: email ?? null },
    complaintContact: [ownerName, mobile ? maskPhone(mobile) : null, shop.email ?? email].filter(Boolean).join(", "),
    ids: { pan, gstin: shop.gstin ?? null, shopAct: shop.shopActNumber ?? null, udyam: shop.udyamNumber ?? null, fssai: shop.fssaiLicenseNumber ?? null },
    pharmacist,
    bankLast4: verifiedBank?.last4 ?? null,
    licences,
    licencesAsOf: now.toISOString(),
    fees: {
      registrationFeePaise: fee.amountPaise,
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
    platform: {
      signatoryName: rule.platformSignatoryName,
      signatoryDesignation: rule.platformSignatoryDesignation,
      boardResolutionDate: rule.boardResolutionDate || null,
      eSealAssetId: rule.eSealAssetId || null,
    },
    place: "Pune",
  };
}

export type { Shop };
