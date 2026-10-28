/**
 * Dealer registration, verification and approval (docs/dealer-programme,
 * GKS-DR-001/002/004).
 *
 * Lifecycle: DRAFT → PENDING (the applicant submits) → APPROVED or REJECTED
 * (an admin decides, with a reason for a rejection); APPROVED ↔ SUSPENDED;
 * APPROVED / SUSPENDED → TERMINATED. A rejected applicant may edit and submit
 * again (back to DRAFT). Only ADMIN decides; operators read (masked).
 *
 * On approval: the dealer code (GKS-MH-<district>-…) is issued, the DEALER role
 * is granted to the applicant's account, and the agreement dates are set.
 * Suspension: every active code (the dealer's and the employees') is
 * suspended, so new registrations cannot use them. Reactivation wakes the
 * suspended codes (not those of deactivated employees). Termination retires
 * every code, deactivates the employees and revokes the DEALER role; shops
 * already registered stay live.
 *
 * Personal data: PAN and bank account numbers are stored encrypted with a
 * masked tail; documents are encrypted files. Admins reveal them one at a time,
 * each reveal audited. Nothing personal goes into a URL or a log.
 *
 * Every route also needs the dealer_programme_enabled flag (requireFeature).
 */
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import {
  DEALER_AGREEMENT_VERSION,
  DEALER_DOC_LABELS,
  DEALER_DOC_TYPES,
  DEALER_STATUS_LABELS,
  type DealerDocType,
  type DealerStatus,
  type DealerType,
} from "@/lib/dealers";
import { isPanEncryptionConfigured } from "@/lib/env";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { decryptBytes, decryptSecret, encryptBytes, encryptSecret, maskPan, panBlindIndex } from "@/lib/pan-crypto";
import { db, type DbClient } from "@/server/db";
import {
  dealerCodes,
  dealerDocumentRequirements,
  dealerDocuments,
  dealers,
  dealerSalespeople,
  dealerTerritories,
  geoAreas,
  users,
  type Dealer,
  type DealerSalesperson,
  type UserRole,
} from "@/server/db/schema";
import { verifyRegistrationOtp, sendRegistrationOtp } from "@/server/registration/otp";
import { bankCheckConfig, bankCheckDecision, callCashfreeBav } from "@/server/services/bank-account-check";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { flagCoversDistrict, getFeatureFlag } from "@/server/services/feature-flags";
import { geoAncestry } from "@/server/services/geo-areas";
import { notify } from "@/server/services/notifications";
import { grantRole, revokeRole } from "@/server/services/roles";
import { getRule } from "@/server/services/settings";
import { NOTIFICATION_TYPES } from "@/server/notifications/types";
import { activeCodeFor, dealerCodeFor, issueCode, listDealerCodes, replaceCode, salespersonCode, setCodesStatus } from "./codes";
import { holdDealerCommission } from "./commission";

export interface DealerActor {
  id: string;
  role: UserRole;
  email?: string | null;
}

const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT = /^[0-9]{9,18}$/;
const PIN = /^[1-9][0-9]{5}$/;
const MOBILE = /^[6-9][0-9]{9}$/;

const MAX_DOC_BYTES = 5 * 1024 * 1024;
const DOC_MIME: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/* ------------------------------------------------------------------ reads */

export async function getDealerForUser(userId: string, client: DbClient = db): Promise<Dealer | null> {
  const [row] = await client.select().from(dealers).where(eq(dealers.userId, userId)).limit(1);
  return row ?? null;
}

export async function getDealer(dealerId: string, client: DbClient = db): Promise<Dealer> {
  const [row] = await client.select().from(dealers).where(eq(dealers.id, dealerId)).limit(1);
  if (!row) throw notFound("Dealer");
  return row;
}

export async function documentRequirements(dealerType: DealerType, client: DbClient = db): Promise<{ docType: DealerDocType; required: boolean }[]> {
  const rows = await client.select().from(dealerDocumentRequirements).where(eq(dealerDocumentRequirements.dealerType, dealerType));
  const byType = new Map(rows.map((r) => [r.docType, r.required]));
  // A type missing from the table counts as optional.
  return DEALER_DOC_TYPES.map((docType) => ({ docType, required: byType.get(docType) ?? false }));
}

export async function listDocumentRequirements() {
  return db.select().from(dealerDocumentRequirements).orderBy(dealerDocumentRequirements.dealerType, dealerDocumentRequirements.docType);
}

/** ADMIN only: whether a dealer type must upload a document. Audited. */
export async function setDocumentRequirement(dealerType: DealerType, docType: DealerDocType, required: boolean, actor: DealerActor): Promise<void> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can change document requirements.");
  await db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(dealerDocumentRequirements)
      .where(and(eq(dealerDocumentRequirements.dealerType, dealerType), eq(dealerDocumentRequirements.docType, docType)));
    if (before) {
      await tx
        .update(dealerDocumentRequirements)
        .set({ required, updatedBy: actor.id, updatedAt: new Date() })
        .where(and(eq(dealerDocumentRequirements.dealerType, dealerType), eq(dealerDocumentRequirements.docType, docType)));
    } else {
      // One unique key (the primary key): a target-less DO NOTHING is safe on the split layout.
      await tx.insert(dealerDocumentRequirements).values({ dealerType, docType, required, updatedBy: actor.id }).onConflictDoNothing();
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_DOC_REQUIREMENT_CHANGED,
        entityType: "dealer_document_requirement",
        entityId: `${dealerType}:${docType}`,
        previousValue: before ? { required: before.required } : null,
        newValue: { required },
      },
      tx,
    );
  });
}

export async function territoryCodes(dealerId: string, client: DbClient = db): Promise<string[]> {
  const rows = await client.select({ code: dealerTerritories.areaCode }).from(dealerTerritories).where(eq(dealerTerritories.dealerId, dealerId));
  return rows.map((r) => r.code).sort();
}

/** The districts a dealer's territory lies in (code and short code), sorted by code. */
export async function territoryDistricts(dealerId: string, client: DbClient = db): Promise<{ code: string; shortCode: string | null; name: string }[]> {
  const out = new Map<string, { code: string; shortCode: string | null; name: string }>();
  for (const code of await territoryCodes(dealerId, client)) {
    const district = (await geoAncestry(code)).find((a) => a.level === "DISTRICT");
    if (district) out.set(district.code, { code: district.code, shortCode: district.shortCode, name: district.name });
  }
  return [...out.values()].sort((a, b) => a.code.localeCompare(b.code));
}

/* ------------------------------------------------------------ the view */

export interface DealerDocumentView {
  id: string;
  docType: DealerDocType;
  label: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: "SUBMITTED" | "ACCEPTED" | "REJECTED";
  reviewNote: string | null;
  uploadedAt: Date;
}

export interface DealerView {
  id: string;
  status: DealerStatus;
  statusLabel: string;
  statusReason: string | null;
  legalName: string;
  contactName: string;
  dealerType: DealerType;
  mobileMasked: string | null;
  mobileVerified: boolean;
  mobileVerificationMethod: string | null;
  email: string | null;
  emailVerified: boolean;
  panMasked: string | null;
  gstin: string | null;
  shopActNumber: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; pincode: string | null; state: string | null };
  bank: { holderName: string | null; accountMasked: string | null; ifsc: string | null; status: string; reason: string | null };
  agreement: { version: string | null; acceptedAt: Date | null; start: string | null; end: string | null; currentVersion: string };
  territories: string[];
  /** The same areas by name ("Kothrud", "Pune"), in the same order. */
  territoryNames: string[];
  requirements: { docType: DealerDocType; label: string; required: boolean; status: "MISSING" | "SUBMITTED" | "ACCEPTED" | "REJECTED" }[];
  documents: DealerDocumentView[];
  codes: { id: string; code: string; kind: string; status: string; salespersonId: string | null; createdAt: Date }[];
  isInternal: boolean;
  source: string;
  submittedAt: Date | null;
  decidedAt: Date | null;
}

const maskMobile = (e164: string | null) => (e164 ? `${e164.slice(0, 3)}••••••${e164.slice(-4)}` : null);
const maskAccount = (last4: string | null) => (last4 ? `••••${last4}` : null);

/** The dealer as the dealer and staff see it: personal numbers masked. */
export async function dealerView(dealer: Dealer, client: DbClient = db): Promise<DealerView> {
  const [requirements, docs, codes, territories] = await Promise.all([
    documentRequirements(dealer.dealerType, client),
    client
      .select({
        id: dealerDocuments.id,
        docType: dealerDocuments.docType,
        fileName: dealerDocuments.fileName,
        mimeType: dealerDocuments.mimeType,
        sizeBytes: dealerDocuments.sizeBytes,
        status: dealerDocuments.status,
        reviewNote: dealerDocuments.reviewNote,
        uploadedAt: dealerDocuments.uploadedAt,
      })
      .from(dealerDocuments)
      .where(eq(dealerDocuments.dealerId, dealer.id))
      .orderBy(desc(dealerDocuments.uploadedAt)),
    listDealerCodes(dealer.id, client),
    territoryCodes(dealer.id, client),
  ]);
  const names = territories.length
    ? new Map((await client.select({ code: geoAreas.code, name: geoAreas.name }).from(geoAreas).where(inArray(geoAreas.code, territories))).map((a) => [a.code, a.name]))
    : new Map<string, string>();
  const latest = new Map<DealerDocType, (typeof docs)[number]>();
  for (const d of docs) if (!latest.has(d.docType)) latest.set(d.docType, d);
  return {
    id: dealer.id,
    status: dealer.status,
    statusLabel: DEALER_STATUS_LABELS[dealer.status],
    statusReason: dealer.statusReason,
    legalName: dealer.legalName,
    contactName: dealer.contactName,
    dealerType: dealer.dealerType,
    mobileMasked: maskMobile(dealer.mobileE164),
    mobileVerified: dealer.mobileVerifiedAt !== null,
    mobileVerificationMethod: dealer.mobileVerificationMethod,
    email: dealer.email,
    emailVerified: dealer.emailVerifiedAt !== null,
    panMasked: dealer.panLast4 ? maskPan(dealer.panLast4) : null,
    gstin: dealer.gstin,
    shopActNumber: dealer.shopActNumber,
    address: { line1: dealer.addressLine1, line2: dealer.addressLine2, city: dealer.city, pincode: dealer.pincode, state: dealer.state },
    bank: {
      holderName: dealer.bankHolderName,
      accountMasked: maskAccount(dealer.bankAccountLast4),
      ifsc: dealer.bankIfsc,
      status: dealer.bankStatus,
      reason: dealer.bankStatusReason,
    },
    agreement: {
      version: dealer.agreementVersion,
      acceptedAt: dealer.agreementAcceptedAt,
      start: dealer.agreementStart,
      end: dealer.agreementEnd,
      currentVersion: DEALER_AGREEMENT_VERSION,
    },
    territories,
    territoryNames: territories.map((c) => names.get(c) ?? c),
    requirements: requirements.map((r) => ({
      docType: r.docType,
      label: DEALER_DOC_LABELS[r.docType],
      required: r.required,
      status: latest.get(r.docType)?.status ?? "MISSING",
    })),
    documents: docs.map((d) => ({ ...d, label: DEALER_DOC_LABELS[d.docType] })),
    codes: codes.map((c) => ({ id: c.id, code: c.code, kind: c.kind, status: c.status, salespersonId: c.salespersonId, createdAt: c.createdAt })),
    isInternal: dealer.isInternal,
    source: dealer.source,
    submittedAt: dealer.submittedAt,
    decidedAt: dealer.decidedAt,
  };
}

/* ----------------------------------------------------------- application */

export interface DealerApplicationInput {
  legalName: string;
  contactName: string;
  dealerType: DealerType;
  /** 10 digits; blank keeps the saved number. */
  mobile?: string | null;
  /** Blank keeps the saved PAN (the form shows it masked). */
  pan?: string | null;
  gstin?: string | null;
  shopActNumber?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  pincode: string;
  state?: string | null;
  /** geo_areas codes (district, taluka/city or locality). */
  territories: string[];
  bank?: { holderName: string; accountNumber: string; ifsc: string } | null;
}

const EDITABLE: readonly DealerStatus[] = ["DRAFT", "REJECTED"];

function clean(value: string | null | undefined, max = 200): string | null {
  const v = (value ?? "").trim().replace(/\s+/g, " ");
  return v ? v.slice(0, max) : null;
}

async function validateTerritories(codes: string[]): Promise<string[]> {
  const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))].sort();
  if (wanted.length === 0) throw validationFailed("Choose at least one district or area you will work in.", { fields: { territories: "Choose at least one area." } });
  if (wanted.length > 50) throw validationFailed("Choose at most 50 areas.", { fields: { territories: "At most 50." } });
  const rows = await db.select({ code: geoAreas.code, level: geoAreas.level, status: geoAreas.status }).from(geoAreas).where(inArray(geoAreas.code, wanted));
  const ok = new Set(rows.filter((r) => r.status === "ACTIVE" && ["DISTRICT", "TALUKA", "LOCALITY"].includes(r.level)).map((r) => r.code));
  const bad = wanted.filter((c) => !ok.has(c));
  if (bad.length) throw validationFailed(`Unknown area: ${bad.join(", ")}.`, { fields: { territories: "Choose areas from the list." } });
  return wanted;
}

/**
 * Creates or updates the signed-in user's application (DRAFT, or a REJECTED
 * one, which goes back to DRAFT). The mobile number's verification is cleared
 * when the number changes; bank details are checked with the bank after the
 * save (checkDealerBank).
 */
export async function saveApplication(input: DealerApplicationInput, actor: DealerActor & { email: string | null }): Promise<Dealer> {
  if (!isPanEncryptionConfigured()) {
    // PAN, bank numbers and documents are stored only encrypted; without the key nothing personal is accepted.
    throw new AppError("CONFLICT", "Dealer applications are not available on this site yet (secure storage is not set up).");
  }
  const legalName = clean(input.legalName, 120);
  const contactName = clean(input.contactName, 120);
  if (!legalName) throw validationFailed("Enter the legal or business name.", { fields: { legalName: "Required." } });
  if (!contactName) throw validationFailed("Enter the owner's or representative's name.", { fields: { contactName: "Required." } });
  const mobileRaw = (input.mobile ?? "").replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
  if (mobileRaw && !MOBILE.test(mobileRaw)) throw validationFailed("Enter a 10-digit Indian mobile number.", { fields: { mobile: "10 digits." } });
  const pan = clean(input.pan)?.toUpperCase().replace(/\s/g, "") ?? null;
  if (pan && !PAN.test(pan)) throw validationFailed("That is not a valid PAN (e.g. ABCDE1234F).", { fields: { pan: "Invalid PAN." } });
  const gstin = clean(input.gstin)?.toUpperCase().replace(/\s/g, "") ?? null;
  if (gstin && !GSTIN.test(gstin)) throw validationFailed("That is not a valid GSTIN.", { fields: { gstin: "Invalid GSTIN." } });
  const saved = await getDealerForUser(actor.id);
  const effectivePan = pan ?? (saved?.panEnc ? decryptSecret(saved.panEnc) : null);
  if (gstin && effectivePan && gstin.slice(2, 12) !== effectivePan) {
    throw validationFailed("The GSTIN does not belong to this PAN.", { fields: { gstin: "GSTIN and PAN do not match." } });
  }
  const pincode = input.pincode.trim();
  if (!PIN.test(pincode)) throw validationFailed("Enter a 6-digit PIN code.", { fields: { pincode: "6 digits." } });
  const addressLine1 = clean(input.addressLine1);
  const city = clean(input.city, 80);
  if (!addressLine1 || !city) throw validationFailed("Enter the registered address.", { fields: { addressLine1: "Required.", city: "Required." } });
  let bank: { holderName: string; account: string; ifsc: string } | null = null;
  if (input.bank) {
    const holderName = clean(input.bank.holderName, 120);
    const account = input.bank.accountNumber.replace(/\s/g, "");
    const ifsc = input.bank.ifsc.trim().toUpperCase();
    if (!holderName) throw validationFailed("Enter the account holder's name.", { fields: { bankHolderName: "Required." } });
    if (!ACCOUNT.test(account)) throw validationFailed("Enter the account number (9 to 18 digits).", { fields: { bankAccountNumber: "9 to 18 digits." } });
    if (!IFSC.test(ifsc)) throw validationFailed("That is not a valid IFSC (e.g. HDFC0001234).", { fields: { bankIfsc: "Invalid IFSC." } });
    bank = { holderName, account, ifsc };
  }
  const territories = await validateTerritories(input.territories);
  const mobileE164 = mobileRaw ? `+91${mobileRaw}` : saved?.mobileE164;
  if (!mobileE164) throw validationFailed("Enter a 10-digit Indian mobile number.", { fields: { mobile: "10 digits." } });
  const panHash = pan ? panBlindIndex(pan) : null;

  if (panHash) {
    const [taken] = await db
      .select({ id: dealers.id, userId: dealers.userId })
      .from(dealers)
      .where(and(eq(dealers.panHash, panHash), ne(dealers.status, "REJECTED")))
      .limit(1);
    if (taken && taken.userId !== actor.id) throw conflict("A dealer with this PAN is already registered.");
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(dealers).where(eq(dealers.userId, actor.id)).for("update");
    if (existing && !EDITABLE.includes(existing.status)) {
      throw conflict(`Your application is ${DEALER_STATUS_LABELS[existing.status].toLowerCase()}; it can no longer be edited.`);
    }
    const bankChanged =
      bank !== null &&
      (!existing ||
        existing.bankIfsc !== bank.ifsc ||
        existing.bankAccountLast4 !== bank.account.slice(-4) ||
        existing.bankHolderName !== bank.holderName ||
        (existing.bankAccountEnc !== null && decryptSecret(existing.bankAccountEnc) !== bank.account));
    const values = {
      legalName,
      contactName,
      dealerType: input.dealerType,
      mobileE164,
      ...(existing?.mobileE164 !== mobileE164 ? { mobileVerifiedAt: null, mobileVerificationMethod: null } : {}),
      email: actor.email,
      // Signing in proved the account's email address.
      emailVerifiedAt: actor.email ? (existing?.emailVerifiedAt ?? new Date()) : null,
      ...(pan ? { panEnc: encryptSecret(pan), panHash, panLast4: pan.slice(-4) } : {}),
      gstin,
      shopActNumber: clean(input.shopActNumber, 60),
      addressLine1,
      addressLine2: clean(input.addressLine2),
      city,
      pincode,
      state: clean(input.state, 60) ?? "Maharashtra",
      ...(bank && bankChanged
        ? {
            bankHolderName: bank.holderName,
            bankAccountEnc: encryptSecret(bank.account),
            bankAccountLast4: bank.account.slice(-4),
            bankIfsc: bank.ifsc,
            bankStatus: "PENDING" as const,
            bankStatusReason: "Waiting for the bank check.",
            bankVerifiedAt: null,
            bankCheckRef: null,
          }
        : {}),
      status: "DRAFT" as const,
      updatedAt: new Date(),
    };
    let dealer: Dealer;
    if (existing) {
      [dealer] = await tx.update(dealers).set(values).where(eq(dealers.id, existing.id)).returning();
    } else {
      [dealer] = await tx.insert(dealers).values({ ...values, userId: actor.id, source: "APPLICATION" }).returning();
    }
    await tx.delete(dealerTerritories).where(eq(dealerTerritories.dealerId, dealer.id));
    for (const areaCode of territories) await tx.insert(dealerTerritories).values({ dealerId: dealer.id, areaCode });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_APPLICATION_SAVED,
        entityType: "dealer",
        entityId: dealer.id,
        previousValue: existing ? { status: existing.status } : null,
        newValue: { status: "DRAFT", dealerType: input.dealerType, territories, bankChanged },
      },
      tx,
    );
    return dealer;
  });
}

export async function sendDealerMobileOtp(actor: DealerActor, ip: string | null) {
  const dealer = await getDealerForUser(actor.id);
  if (!dealer?.mobileE164) throw validationFailed("Save your application with a mobile number first.");
  if (dealer.mobileVerifiedAt) return { alreadyVerified: true as const };
  const sent = await sendRegistrationOtp(dealer.mobileE164, ip, (code, minutes) => `${code} is your GoKesari dealer verification code. It expires in ${minutes} minutes. Do not share it.`);
  return { alreadyVerified: false as const, ...sent };
}

export async function verifyDealerMobile(actor: DealerActor, code: string): Promise<Dealer> {
  const dealer = await getDealerForUser(actor.id);
  if (!dealer?.mobileE164) throw validationFailed("Save your application with a mobile number first.");
  const at = await verifyRegistrationOtp(dealer.mobileE164, code);
  const [row] = await db
    .update(dealers)
    .set({ mobileVerifiedAt: at, mobileVerificationMethod: "OTP", updatedAt: new Date() })
    .where(eq(dealers.id, dealer.id))
    .returning();
  return row;
}

function sniffMime(bytes: Buffer): string | null {
  if (bytes.subarray(0, 4).toString("latin1") === "%PDF") return "application/pdf";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * Uploads one document for the signed-in user's dealer (while DRAFT, REJECTED
 * or PENDING — a pending applicant replaces a rejected document). PDF, JPEG,
 * PNG or WebP, up to 5 MB, checked from the bytes; stored encrypted.
 */
export async function uploadDealerDocument(
  actor: DealerActor,
  docType: DealerDocType,
  file: { name: string; bytes: Buffer },
): Promise<DealerDocumentView> {
  if (!isPanEncryptionConfigured()) throw new AppError("CONFLICT", "Document upload is not available on this site yet (secure storage is not set up).");
  const dealer = await getDealerForUser(actor.id);
  if (!dealer) throw validationFailed("Save your application first.");
  if (!["DRAFT", "REJECTED", "PENDING"].includes(dealer.status)) throw conflict("Documents can no longer be changed.");
  if (!(DEALER_DOC_TYPES as readonly string[]).includes(docType)) throw validationFailed("Unknown document type.");
  if (file.bytes.length === 0) throw validationFailed("The file is empty.");
  if (file.bytes.length > MAX_DOC_BYTES) throw validationFailed("The file is larger than 5 MB.");
  const mimeType = sniffMime(file.bytes);
  if (!mimeType || !DOC_MIME[mimeType]) throw validationFailed("Upload a PDF, JPEG, PNG or WebP file.");
  const fileName = (file.name.replace(/[^\w.\- ]+/g, "_").slice(0, 100) || `document.${DOC_MIME[mimeType]}`).trim();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(dealerDocuments)
      .values({
        dealerId: dealer.id,
        docType,
        fileName,
        mimeType,
        sizeBytes: file.bytes.length,
        content: encryptBytes(file.bytes),
        uploadedBy: actor.id,
      })
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_DOCUMENT_UPLOADED,
        entityType: "dealer",
        entityId: dealer.id,
        newValue: { documentId: row.id, docType, sizeBytes: row.sizeBytes, mimeType },
      },
      tx,
    );
    return {
      id: row.id,
      docType,
      label: DEALER_DOC_LABELS[docType],
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      status: row.status,
      reviewNote: null,
      uploadedAt: row.uploadedAt,
    };
  });
}

/**
 * Submits the application (DRAFT → PENDING). Needs: mobile verified (or SMS
 * not available on this site — then an admin confirms the number by phone at
 * approval), every required document uploaded, the agreement accepted, and at
 * least one area in a district where the dealer programme is on.
 */
export async function submitApplication(actor: DealerActor, acceptAgreementVersion: string, options: { smsAvailable: boolean }): Promise<Dealer> {
  const dealer = await getDealerForUser(actor.id);
  if (!dealer) throw validationFailed("Save your application first.");
  if (dealer.status !== "DRAFT") throw conflict("Only a draft application can be submitted.");
  if (acceptAgreementVersion !== DEALER_AGREEMENT_VERSION) {
    throw validationFailed("Read and accept the current dealer agreement.", { fields: { agreement: "Accept the agreement." } });
  }
  if (!dealer.mobileVerifiedAt && options.smsAvailable) throw validationFailed("Verify your mobile number with the code we send you.", { fields: { mobile: "Not verified." } });
  const view = await dealerView(dealer);
  const missing = view.requirements.filter((r) => r.required && (r.status === "MISSING" || r.status === "REJECTED"));
  if (missing.length) throw validationFailed(`Upload: ${missing.map((m) => m.label).join(", ")}.`, { fields: { documents: "Required documents missing." }, missing: missing.map((m) => m.docType) });
  if (!dealer.panEnc && view.requirements.some((r) => r.docType === "PAN" && r.required)) throw validationFailed("Enter your PAN.", { fields: { pan: "Required." } });
  if (dealer.dealerType === "COMPANY" && !dealer.gstin && view.requirements.some((r) => r.docType === "GSTIN" && r.required)) {
    throw validationFailed("Enter your GSTIN.", { fields: { gstin: "Required." } });
  }
  if (dealer.bankStatus === "NOT_PROVIDED") throw validationFailed("Add the bank account your commission is paid to.", { fields: { bank: "Required." } });
  const flag = await getFeatureFlag("dealer_programme_enabled");
  const districts = await territoryDistricts(dealer.id);
  if (!districts.some((d) => flagCoversDistrict(flag, d.code))) {
    throw validationFailed("GoKesari is not appointing dealers in your areas yet. Choose an area in a district where the programme is open.", {
      fields: { territories: "Not open in these districts yet." },
    });
  }
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(dealers)
      .set({ status: "PENDING", submittedAt: now, agreementVersion: DEALER_AGREEMENT_VERSION, agreementAcceptedAt: now, statusReason: null, updatedAt: now })
      .where(and(eq(dealers.id, dealer.id), eq(dealers.status, "DRAFT")))
      .returning();
    if (!row) throw conflict("The application changed; reload and try again.");
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_APPLICATION_SUBMITTED,
        entityType: "dealer",
        entityId: dealer.id,
        newValue: { agreementVersion: DEALER_AGREEMENT_VERSION, mobileVerified: dealer.mobileVerifiedAt !== null },
      },
      tx,
    );
    await notify({ userId: actor.id, type: NOTIFICATION_TYPES.DEALER_APPLICATION_RECEIVED, vars: { legalName: row.legalName }, actionUrl: "/dealer" }, tx);
    return row;
  });
}

/* ------------------------------------------------------------- the bank */

/**
 * Asks the bank (Cashfree Bank Account Verification, the same check shops'
 * accounts get) whether the dealer's account is valid and in the holder's
 * name. Not configured, or the bank unreachable → stays PENDING; an admin may
 * then verify by the cancelled cheque at approval. Runs outside any
 * transaction (an outside call).
 */
export async function checkDealerBank(dealerId: string, actor: DealerActor): Promise<Dealer> {
  const dealer = await getDealer(dealerId);
  if (!dealer.bankAccountEnc || !dealer.bankIfsc || !dealer.bankHolderName) throw validationFailed("No bank account to check.");
  if (dealer.bankStatus === "VERIFIED") return dealer;
  const config = bankCheckConfig();
  if (!config) return dealer;
  const outcome = await callCashfreeBav(config, { accountNumber: decryptSecret(dealer.bankAccountEnc), ifsc: dealer.bankIfsc, name: dealer.bankHolderName });
  const threshold = (await getRule("bankAccounts")).nameMatchThreshold;
  const decision = bankCheckDecision(outcome, dealer.bankHolderName, threshold);
  const update = decision.decided
    ? decision.verified
      ? { bankStatus: "VERIFIED" as const, bankVerifiedAt: new Date(), bankStatusReason: decision.reason }
      : { bankStatus: "FAILED" as const, bankStatusReason: decision.reason }
    : { bankStatusReason: outcome.result === "ERROR" ? "The bank could not be reached; it will be checked again." : "Waiting for the bank check." };
  const [row] = await db
    .update(dealers)
    .set({ ...update, bankCheckRef: outcome.referenceId, updatedAt: new Date() })
    .where(eq(dealers.id, dealerId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.DEALER_BANK_CHECKED,
    entityType: "dealer",
    entityId: dealerId,
    newValue: { result: outcome.result, decided: decision.decided, verified: decision.verified, score: decision.score, referenceId: outcome.referenceId },
  });
  return row;
}

/* ---------------------------------------------------------- admin review */

export async function listDealers(filter: { status?: DealerStatus | "ALL"; q?: string } = {}) {
  const rows = await db
    .select()
    .from(dealers)
    .where(
      and(
        filter.status && filter.status !== "ALL" ? eq(dealers.status, filter.status) : sql`true`,
        filter.q ? sql`(${dealers.legalName} ilike ${"%" + filter.q + "%"} or ${dealers.contactName} ilike ${"%" + filter.q + "%"})` : sql`true`,
      ),
    )
    .orderBy(desc(dealers.updatedAt))
    .limit(500);
  return rows.map((d) => ({
    id: d.id,
    legalName: d.legalName,
    contactName: d.contactName,
    dealerType: d.dealerType,
    status: d.status,
    statusLabel: DEALER_STATUS_LABELS[d.status],
    city: d.city,
    isInternal: d.isInternal,
    source: d.source,
    submittedAt: d.submittedAt,
    updatedAt: d.updatedAt,
  }));
}

/** ADMIN only: accept or reject one document (a rejection needs a note, sent to the dealer). */
export async function reviewDealerDocument(documentId: string, decision: "ACCEPTED" | "REJECTED", note: string | null, actor: DealerActor): Promise<void> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can review dealer documents.");
  const why = clean(note, 500);
  if (decision === "REJECTED" && !why) throw validationFailed("Say why the document is rejected.", { fields: { note: "Required." } });
  await db.transaction(async (tx) => {
    const [doc] = await tx.select().from(dealerDocuments).where(eq(dealerDocuments.id, documentId)).for("update");
    if (!doc) throw notFound("Document");
    await tx
      .update(dealerDocuments)
      .set({ status: decision, reviewNote: why, reviewedBy: actor.id, reviewedAt: new Date() })
      .where(eq(dealerDocuments.id, documentId));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_DOCUMENT_REVIEWED,
        entityType: "dealer",
        entityId: doc.dealerId,
        previousValue: { documentId, status: doc.status },
        newValue: { documentId, status: decision, note: why },
      },
      tx,
    );
    const [dealer] = await tx.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, doc.dealerId));
    if (decision === "REJECTED" && dealer?.userId) {
      await notify(
        { userId: dealer.userId, type: NOTIFICATION_TYPES.DEALER_DOCUMENT_REJECTED, vars: { docLabel: DEALER_DOC_LABELS[doc.docType], note: why ?? "" }, actionUrl: "/dealer/apply" },
        tx,
      );
    }
  });
}

/**
 * A document's file. The dealer may open their own; an ADMIN may open any,
 * and every admin opening is audited. Operators and others are refused.
 */
export async function dealerDocumentFile(documentId: string, actor: DealerActor): Promise<{ bytes: Buffer; mimeType: string; fileName: string }> {
  const [doc] = await db.select().from(dealerDocuments).where(eq(dealerDocuments.id, documentId));
  if (!doc) throw notFound("Document");
  const [dealer] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, doc.dealerId));
  const own = dealer?.userId === actor.id;
  if (!own && actor.role !== "ADMIN") throw notFound("Document");
  if (!own) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.DEALER_DOCUMENT_VIEWED,
      entityType: "dealer",
      entityId: doc.dealerId,
      newValue: { documentId, docType: doc.docType },
    });
  }
  return { bytes: decryptBytes(doc.content), mimeType: doc.mimeType, fileName: doc.fileName };
}

/** ADMIN only: the full PAN or bank account number, each reveal audited with a reason. */
export async function revealDealerSecret(dealerId: string, what: "PAN" | "BANK_ACCOUNT", reason: string, actor: DealerActor): Promise<string> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can reveal a dealer's PAN or bank account.");
  const why = clean(reason, 300);
  if (!why || why.length < 5) throw validationFailed("Say why you need to see it.", { fields: { reason: "Give a reason." } });
  const dealer = await getDealer(dealerId);
  const enc = what === "PAN" ? dealer.panEnc : dealer.bankAccountEnc;
  if (!enc) throw notFound(what === "PAN" ? "PAN" : "Bank account");
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: what === "PAN" ? AUDIT_ACTIONS.DEALER_PAN_REVEALED : AUDIT_ACTIONS.DEALER_BANK_REVEALED,
    entityType: "dealer",
    entityId: dealerId,
    newValue: { reason: why },
  });
  return decryptSecret(enc);
}

/* ------------------------------------------------------------- decisions */

export type DealerDecision =
  | { action: "APPROVE"; agreementStart: string; agreementEnd: string; mobileConfirmedByCall?: boolean; bankVerifiedByDocument?: boolean }
  | { action: "REJECT" | "SUSPEND" | "REACTIVATE" | "TERMINATE"; reason: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

async function districtShortCode(dealerId: string, client: DbClient): Promise<string> {
  const districts = await territoryDistricts(dealerId, client);
  const flag = await getFeatureFlag("dealer_programme_enabled");
  const open = districts.filter((d) => flagCoversDistrict(flag, d.code) && d.shortCode);
  const pick = open[0] ?? districts.find((d) => d.shortCode);
  if (!pick?.shortCode) throw validationFailed("The dealer has no district in their areas; a code cannot be made.");
  return pick.shortCode;
}

async function salespeopleCodes(dealerId: string, client: DbClient, onlyActivePeople: boolean): Promise<string[]> {
  const rows = await client
    .select({ id: dealerCodes.id, personStatus: dealerSalespeople.status })
    .from(dealerCodes)
    .leftJoin(dealerSalespeople, eq(dealerSalespeople.id, dealerCodes.salespersonId))
    .where(eq(dealerCodes.dealerId, dealerId));
  return rows.filter((r) => !onlyActivePeople || r.personStatus === null || r.personStatus === "ACTIVE").map((r) => r.id);
}

/**
 * ADMIN only. Approve (PENDING → APPROVED: documents accepted, mobile and bank
 * verified — or confirmed by the admin — agreement dates; issues the code and
 * grants the DEALER role), reject (PENDING), suspend (APPROVED), reactivate
 * (SUSPENDED) or terminate (APPROVED / SUSPENDED). A reason is required for
 * everything but approval; the dealer is notified.
 */
export async function decideDealer(dealerId: string, decision: DealerDecision, actor: DealerActor): Promise<{ dealer: Dealer; code: string | null }> {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can approve, reject, suspend or terminate dealers.");
  const reason = decision.action === "APPROVE" ? null : clean(decision.reason, 500);
  if (decision.action !== "APPROVE" && (!reason || reason.length < 5)) throw validationFailed("Give the reason (it is sent to the dealer).", { fields: { reason: "Required." } });

  // Users whose DEALER role ends with a termination; revoked after the commit (revokeRole runs its own transaction).
  const revoke: string[] = [];
  const result = await db.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!dealer) throw notFound("Dealer");
    if (dealer.isInternal) throw conflict("GoKesari Direct cannot be changed here.");
    const from = dealer.status;
    const allowed: Record<DealerDecision["action"], DealerStatus[]> = {
      APPROVE: ["PENDING"],
      REJECT: ["PENDING"],
      SUSPEND: ["APPROVED"],
      REACTIVATE: ["SUSPENDED"],
      TERMINATE: ["APPROVED", "SUSPENDED"],
    };
    if (!allowed[decision.action].includes(from)) {
      throw new AppError("INVALID_STATE_TRANSITION", `A ${DEALER_STATUS_LABELS[from].toLowerCase()} dealer cannot be ${decision.action.toLowerCase()}d.`);
    }
    const now = new Date();
    let code: string | null = null;
    let to: DealerStatus;
    revoke.length = 0;
    const extra: Partial<typeof dealers.$inferInsert> = {};

    if (decision.action === "APPROVE") {
      if (!DATE.test(decision.agreementStart) || !DATE.test(decision.agreementEnd) || decision.agreementEnd < decision.agreementStart) {
        throw validationFailed("Give the agreement's start and end dates (end on or after start).", { fields: { agreementStart: "Required.", agreementEnd: "Required." } });
      }
      if (!dealer.mobileVerifiedAt && !decision.mobileConfirmedByCall) {
        throw validationFailed("The mobile number is not verified. Confirm it by calling the dealer, then tick the box.", { fields: { mobile: "Not verified." } });
      }
      const view = await dealerView(dealer, tx);
      const notAccepted = view.requirements.filter((r) => r.required && r.status !== "ACCEPTED");
      if (notAccepted.length) throw validationFailed(`Accept these documents first: ${notAccepted.map((r) => r.label).join(", ")}.`);
      if (dealer.bankStatus !== "VERIFIED") {
        const bankProof = view.requirements.find((r) => r.docType === "BANK_PROOF");
        if (!decision.bankVerifiedByDocument || bankProof?.status !== "ACCEPTED") {
          throw validationFailed("The bank account is not verified. Accept the cancelled cheque / bank proof and confirm the account from it.", { fields: { bank: "Not verified." } });
        }
        Object.assign(extra, { bankStatus: "VERIFIED", bankVerifiedAt: now, bankStatusReason: "Verified by an admin from the bank proof." });
      }
      if (!dealer.mobileVerifiedAt) Object.assign(extra, { mobileVerifiedAt: now, mobileVerificationMethod: "ADMIN_CALL" });
      Object.assign(extra, { agreementStart: decision.agreementStart, agreementEnd: decision.agreementEnd });
      to = "APPROVED";
      const short = await districtShortCode(dealer.id, tx);
      const existing = (await listDealerCodes(dealer.id, tx)).find((c) => c.kind !== "SALESPERSON" && c.status === "ACTIVE");
      code =
        existing?.code ??
        (await issueCode(tx, { dealerId: dealer.id, kind: "DEALER", makeCode: () => dealerCodeFor(short), label: `Dealer: ${dealer.legalName}`, referrerName: dealer.legalName, referrerUserId: dealer.userId }, actor)).code;
      if (dealer.userId) await grantRole(dealer.userId, "DEALER", { source: "ADMIN", grantedBy: actor.id, activateIfCustomer: true }, tx);
    } else if (decision.action === "REJECT") {
      to = "REJECTED";
    } else if (decision.action === "SUSPEND") {
      to = "SUSPENDED";
      await setCodesStatus(tx, await salespeopleCodes(dealer.id, tx, false), ["ACTIVE"], "SUSPENDED", actor, `dealer suspended: ${reason}`);
    } else if (decision.action === "REACTIVATE") {
      to = "APPROVED";
      await setCodesStatus(tx, await salespeopleCodes(dealer.id, tx, true), ["SUSPENDED"], "ACTIVE", actor, `dealer reactivated: ${reason}`);
      code = await activeCodeFor(dealer.id, null, tx);
    } else {
      to = "TERMINATED";
      await setCodesStatus(tx, await salespeopleCodes(dealer.id, tx, false), ["ACTIVE", "SUSPENDED"], "RETIRED", actor, `dealer terminated: ${reason}`);
      const people = await tx
        .update(dealerSalespeople)
        .set({ status: "INACTIVE", deactivatedAt: now, updatedAt: now })
        .where(and(eq(dealerSalespeople.dealerId, dealer.id), eq(dealerSalespeople.status, "ACTIVE")))
        .returning({ userId: dealerSalespeople.userId });
      revoke.push(...[dealer.userId, ...people.map((p) => p.userId)].filter((u): u is string => Boolean(u)));
    }

    const [row] = await tx
      .update(dealers)
      .set({ ...extra, status: to, statusReason: reason, decidedAt: now, decidedBy: actor.id, updatedAt: now })
      .where(eq(dealers.id, dealer.id))
      .returning();
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.DEALER_STATUS_CHANGED,
        entityType: "dealer",
        entityId: dealer.id,
        previousValue: { status: from },
        newValue: { status: to, reason, code, ...(decision.action === "APPROVE" ? { agreementStart: decision.agreementStart, agreementEnd: decision.agreementEnd } : {}) },
      },
      tx,
    );
    if (dealer.userId) {
      const detail =
        to === "APPROVED" && code
          ? `Your dealer code is ${code}. Share it with shops, or register shops from your dealer page.`
          : reason
            ? `Reason: ${reason}`
            : "";
      await notify(
        { userId: dealer.userId, type: NOTIFICATION_TYPES.DEALER_STATUS_CHANGED, vars: { statusLabel: DEALER_STATUS_LABELS[to], detail }, actionUrl: "/dealer", dedupeKey: `dealer-status:${dealer.id}:${to}:${now.getTime()}` },
        tx,
      );
    }
    return { dealer: row, code };
  });
  for (const userId of revoke) {
    // "does not hold this role" (never signed in as a dealer) is fine.
    await revokeRole(userId, "DEALER", { id: actor.id, role: actor.role }).catch(() => undefined);
  }
  // Commission (step 5): a suspended or terminated dealer's open entries wait for an admin; reactivation releases them.
  if (decision.action === "SUSPEND" || decision.action === "TERMINATE") await holdDealerCommission(dealerId, true, actor);
  if (decision.action === "REACTIVATE") await holdDealerCommission(dealerId, false, actor);
  return result;
}

/** ADMIN only: replace the dealer's own code (or an employee's), keeping history. */
export async function replaceDealerCode(dealerId: string, dealerCodeId: string, reason: string, actor: DealerActor) {
  if (actor.role !== "ADMIN") throw forbidden("Only an admin can replace a code.");
  const why = clean(reason, 300);
  if (!why || why.length < 5) throw validationFailed("Say why the code is replaced.", { fields: { reason: "Required." } });
  return db.transaction(async (tx) => {
    const dealer = await getDealer(dealerId, tx);
    const [dc] = await tx.select().from(dealerCodes).where(and(eq(dealerCodes.id, dealerCodeId), eq(dealerCodes.dealerId, dealerId)));
    if (!dc) throw notFound("Code");
    const short = dc.salespersonId ? null : await districtShortCode(dealerId, tx);
    return replaceCode(tx, dealerCodeId, () => (short ? dealerCodeFor(short) : salespersonCode()), `Dealer: ${dealer.legalName}`, actor, why);
  });
}

/* -------------------------------------------------------- employees */

export interface SalespersonView {
  id: string;
  employeeId: string;
  name: string;
  mobileMasked: string | null;
  status: "ACTIVE" | "INACTIVE";
  code: string | null;
  createdAt: Date;
}

async function salespersonViews(dealerId: string, client: DbClient = db): Promise<SalespersonView[]> {
  const [people, codes] = await Promise.all([
    client.select().from(dealerSalespeople).where(eq(dealerSalespeople.dealerId, dealerId)).orderBy(dealerSalespeople.createdAt),
    listDealerCodes(dealerId, client),
  ]);
  return people.map((p: DealerSalesperson) => {
    const mine = codes.filter((c) => c.salespersonId === p.id && (c.status === "ACTIVE" || c.status === "SUSPENDED"));
    return {
      id: p.id,
      employeeId: p.employeeId,
      name: p.name,
      mobileMasked: maskMobile(p.mobileE164),
      status: p.status,
      code: mine.length ? mine[mine.length - 1].code : null,
      createdAt: p.createdAt,
    };
  });
}

export async function listSalespeople(dealerId: string): Promise<SalespersonView[]> {
  return salespersonViews(dealerId);
}

/** The approved dealer behind the signed-in user (a dealer acting in their portal). */
export async function requireApprovedDealer(actor: DealerActor): Promise<Dealer> {
  const dealer = await getDealerForUser(actor.id);
  if (!dealer) throw notFound("Dealer");
  if (dealer.status !== "APPROVED") throw forbidden("Your dealer account is not active.");
  return dealer;
}

/**
 * The dealer adds an employee: the dealer's own Employee ID (unique within the
 * dealer, any text), name and optional mobile. An employee code (GKS-FE-…) is
 * issued at once. Each employee belongs to exactly one dealer.
 */
export async function addSalesperson(
  dealerId: string,
  input: { employeeId: string; name: string; mobile?: string | null },
  actor: DealerActor,
): Promise<SalespersonView> {
  const employeeId = clean(input.employeeId, 48);
  const name = clean(input.name, 120);
  if (!employeeId) throw validationFailed("Enter the employee's ID.", { fields: { employeeId: "Required." } });
  if (!name) throw validationFailed("Enter the employee's name.", { fields: { name: "Required." } });
  let mobileE164: string | null = null;
  if (input.mobile && input.mobile.trim()) {
    const m = input.mobile.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "");
    if (!MOBILE.test(m)) throw validationFailed("Enter a 10-digit mobile number, or leave it blank.", { fields: { mobile: "10 digits." } });
    mobileE164 = `+91${m}`;
  }
  return db.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!dealer) throw notFound("Dealer");
    if (dealer.status !== "APPROVED") throw forbidden("Employees can be added only while the dealer is approved.");
    const [dupe] = await tx
      .select({ id: dealerSalespeople.id })
      .from(dealerSalespeople)
      .where(and(eq(dealerSalespeople.dealerId, dealerId), sql`lower(${dealerSalespeople.employeeId}) = lower(${employeeId})`));
    if (dupe) throw conflict("You already have an employee with this ID.", { fields: { employeeId: "Already used." } });
    const [person] = await tx
      .insert(dealerSalespeople)
      .values({ dealerId, employeeId, name, mobileE164, source: actor.role === "ADMIN" ? "ADMIN" : "DEALER" })
      .returning();
    await issueCode(tx, { dealerId, salespersonId: person.id, kind: "SALESPERSON", makeCode: salespersonCode, label: `${dealer.legalName}: ${name} (${employeeId})`, referrerName: name }, actor);
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_SALESPERSON_SAVED, entityType: "dealer", entityId: dealerId, newValue: { salespersonId: person.id, employeeId, status: "ACTIVE" } },
      tx,
    );
    return (await salespersonViews(dealerId, tx)).find((p) => p.id === person.id)!;
  });
}

/**
 * Deactivates or reactivates an employee of `dealerId`. Deactivated: their
 * code is refused for new registrations; shops they already brought stay
 * theirs. An employee of another dealer is "not found".
 */
export async function setSalespersonStatus(dealerId: string, salespersonId: string, status: "ACTIVE" | "INACTIVE", actor: DealerActor): Promise<SalespersonView> {
  return db.transaction(async (tx) => {
    const [dealer] = await tx.select().from(dealers).where(eq(dealers.id, dealerId)).for("update");
    if (!dealer) throw notFound("Dealer");
    const [person] = await tx
      .select()
      .from(dealerSalespeople)
      .where(and(eq(dealerSalespeople.id, salespersonId), eq(dealerSalespeople.dealerId, dealerId)))
      .for("update");
    if (!person) throw notFound("Employee");
    if (status === "ACTIVE" && dealer.status !== "APPROVED") throw forbidden("Employees can be reactivated only while the dealer is approved.");
    if (person.status !== status) {
      const now = new Date();
      await tx
        .update(dealerSalespeople)
        .set({ status, deactivatedAt: status === "INACTIVE" ? now : null, updatedAt: now })
        .where(eq(dealerSalespeople.id, salespersonId));
      const codes = await tx.select({ id: dealerCodes.id }).from(dealerCodes).where(eq(dealerCodes.salespersonId, salespersonId));
      await setCodesStatus(
        tx,
        codes.map((c) => c.id),
        status === "INACTIVE" ? ["ACTIVE"] : ["SUSPENDED"],
        status === "INACTIVE" ? "SUSPENDED" : "ACTIVE",
        actor,
        status === "INACTIVE" ? "employee deactivated" : "employee reactivated",
      );
      await recordAudit(
        { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.DEALER_SALESPERSON_SAVED, entityType: "dealer", entityId: dealerId, previousValue: { status: person.status }, newValue: { salespersonId, status } },
        tx,
      );
    }
    return (await salespersonViews(dealerId, tx)).find((p) => p.id === salespersonId)!;
  });
}

/** Users named on the dealer (for staff screens): the applicant's account email. */
export async function dealerAccountEmail(dealer: Dealer): Promise<string | null> {
  if (!dealer.userId) return null;
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, dealer.userId));
  return u?.email ?? null;
}
