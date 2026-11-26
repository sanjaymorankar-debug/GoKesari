/**
 * The shop data an agreement is filled with (docs/seller-agreements-2026-11) — language-neutral, so one
 * snapshot fills the English, Marathi and Hindi copies alike ("the SAME data snapshot"). Pure: built by
 * snapshot.ts from the database, localised here per language for the template engine.
 */
import { createHash } from "node:crypto";

import type { LegalLanguage } from "@/server/db/legal-agreements-schema";

import { CONSTITUTION_LABELS, DESIGNATION_LABELS, longDate, type Constitution, type Designation } from "./i18n";
import type { TemplateData } from "./template-engine";

export type LicenceStatus = "VERIFIED" | "SUBMITTED" | "PENDING";

export type LicenceRow = {
  /** Key into LICENCE_KIND_LABELS. */
  kind: string;
  /** The owner's own name for an "Other licence". */
  customName: string | null;
  number: string;
  authority: string | null;
  /** YYYY-MM-DD or null. */
  validFrom: string | null;
  validUntil: string | null;
  status: LicenceStatus;
  /** Where the copy is on file, e.g. "GK-DOC-1a2b3c4d" (shop_legal_documents id) or "GST portal". */
  reference: string;
  /** shop_legal_documents / seller_verifications id, when there is one. */
  sourceId: string | null;
};

export type AgreementSnapshot = {
  schema: 1;
  shopId: string;
  ownerUserId: string;
  seller: {
    legalName: string;
    tradeName: string;
    constitution: Constitution | null;
    addressLine: string;
    pincode: string;
    googleLocationUrl: string | null;
    sellerId: string;
    shopTypeKeys: string[];
    shopTypeLabels: string[];
    isMedical: boolean;
  };
  owner: { name: string; designation: Designation | null; mobileMasked: string | null; email: string | null };
  complaintContact: string;
  ids: { pan: string | null; gstin: string | null; shopAct: string | null; udyam: string | null; fssai: string | null };
  pharmacist: { name: string; registrationNumber: string; council: string | null } | null;
  bankLast4: string | null;
  licences: LicenceRow[];
  /** ISO instant the licence list was read. */
  licencesAsOf: string;
  fees: {
    registrationFeePaise: number;
    wholesaleRegistrationFeePaise: number;
    commissionBp: number;
    settlementDays: number;
    acceptMinutes: number;
    walletMinimumPaise: number;
    medicineShelfLifeMonths: number;
    perOrderCommissionPaise: number;
    billingManagementFeePaise: number;
  };
  slaChargesPaise: { lateReady: number; sellerCancel: number; lateThenCancel: number; defect: number; medicineBreach: number };
  platform: { signatoryName: string; signatoryDesignation: string; boardResolutionDate: string | null; eSealAssetId: string | null };
  place: string;
};

export type SignatureInfo =
  | { signed: false }
  | { signed: true; signerName: string; designation: Designation; signedAt: Date; sealDataUrl: string | null };

export function rupees(paise: number): string {
  const r = paise / 100;
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function percent(bp: number): string {
  const p = bp / 100;
  return `${p.toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`;
}

/** The template fields for one language. `effectiveAt` is the acceptance time (or "today" in a preview). */
export function localise(snapshot: AgreementSnapshot, lang: LegalLanguage, effectiveAt: Date, signature: SignatureInfo): TemplateData {
  const s = snapshot;
  const designation = signature.signed ? signature.designation : s.owner.designation;
  return {
    seller: {
      legalName: s.seller.legalName,
      tradeName: s.seller.tradeName,
      tradeNameDiffers: s.seller.tradeName.trim().toLowerCase() !== s.seller.legalName.trim().toLowerCase(),
      constitution: s.seller.constitution ? CONSTITUTION_LABELS[s.seller.constitution][lang] : null,
      address: `${s.seller.addressLine}${s.seller.addressLine.includes(s.seller.pincode) ? "" : ` – ${s.seller.pincode}`}`,
      pincode: s.seller.pincode,
      sellerId: s.seller.sellerId,
      shopTypes: s.seller.shopTypeLabels.join(", "),
    },
    owner: {
      name: signature.signed ? signature.signerName : s.owner.name,
      designation: designation ? DESIGNATION_LABELS[designation][lang] : null,
      mobileMasked: s.owner.mobileMasked,
      email: s.owner.email,
    },
    agreement: { effectiveDateLong: longDate(effectiveAt, lang), place: s.place },
    fees: {
      registrationFee: rupees(s.fees.registrationFeePaise),
      medicalRegistrationFee: rupees(s.fees.registrationFeePaise),
      wholesaleRegistrationFee: rupees(s.fees.wholesaleRegistrationFeePaise),
      commissionPct: percent(s.fees.commissionBp),
      settlementDays: s.fees.settlementDays,
      acceptMinutes: s.fees.acceptMinutes,
      walletMinimum: rupees(s.fees.walletMinimumPaise),
      medicineShelfLifeMonths: s.fees.medicineShelfLifeMonths,
      perOrderCommission: s.fees.perOrderCommissionPaise > 0 ? rupees(s.fees.perOrderCommissionPaise) : null,
      billingManagementFee: s.fees.billingManagementFeePaise > 0 ? rupees(s.fees.billingManagementFeePaise) : null,
    },
    sla: {
      lateReadyCharge: rupees(s.slaChargesPaise.lateReady),
      sellerCancelCharge: rupees(s.slaChargesPaise.sellerCancel),
      lateThenCancelCharge: rupees(s.slaChargesPaise.lateThenCancel),
      defectCharge: rupees(s.slaChargesPaise.defect),
      medicineBreachCharge: rupees(s.slaChargesPaise.medicineBreach),
    },
    platform: {
      signatoryName: s.platform.signatoryName,
      signatoryDesignation: s.platform.signatoryDesignation,
      boardResolutionDate: s.platform.boardResolutionDate,
    },
  };
}

/** LicenceRow.reference of a row the signer declared on the signing screen (not from the shop's records). */
export const DECLARED_AT_SIGNING = "Declared at signing";

/** Stable JSON (sorted keys) so the same data always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * What Annexure A rests on: the licences on file (type, number, authority, validity — not the review status, so
 * an admin approving a licence does not ask for a new signature), the shop's names, address and owner account. When it
 * differs from the last signed snapshot's, the owner re-confirms (brief §5).
 */
export function materialFingerprint(s: AgreementSnapshot): string {
  return sha256Hex(
    canonicalJson({
      legalName: s.seller.legalName,
      tradeName: s.seller.tradeName,
      address: s.seller.addressLine,
      pincode: s.seller.pincode,
      // The owner is the account (a change of owner); the name typed as the signature is not compared.
      owner: s.ownerUserId,
      licences: s.licences
        // What the signer declared on the signing screen (a pharmacist with no pharmacy profile) is not on file.
        .filter((l) => l.reference !== DECLARED_AT_SIGNING)
        .map((l) => ({ kind: l.kind, name: l.customName, number: l.number, authority: l.authority, from: l.validFrom, until: l.validUntil }))
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    }),
  );
}
