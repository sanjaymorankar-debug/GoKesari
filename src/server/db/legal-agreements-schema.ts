/**
 * Seller agreements (drizzle/0212_seller_agreements.sql, docs/seller-agreements-2026-11): versioned agreement
 * templates, the frozen shop data they were filled with, signing requests, the immutable acceptance record and
 * the signed PDFs. No foreign keys to shops / users: the evidence outlives a deleted shop or account.
 */
import { sql } from "drizzle-orm";
import { boolean, customType, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const AGREEMENT_DOC_TYPES = ["SELLER_SLA", "MEDICAL_ONBOARDING", "TERMS_OF_USE", "PRIVACY_POLICY"] as const;
export type LegalAgreementType = (typeof AGREEMENT_DOC_TYPES)[number];
export const AGREEMENT_LANGUAGES = ["en", "mr", "hi"] as const;
export type LegalLanguage = (typeof AGREEMENT_LANGUAGES)[number];
export const AGREEMENT_DOC_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export const AGREEMENT_REVIEW_STATUSES = ["NOT_REQUIRED", "PENDING_LEGAL_REVIEW", "REVIEWED"] as const;
export const SIGNING_REASONS = ["REGISTRATION", "EXISTING_SHOP", "NEW_VERSION", "ANNEXURE_UPDATE"] as const;
export type SigningReason = (typeof SIGNING_REASONS)[number];
export const SIGNING_INITIATORS = ["SELF", "ADMIN", "OPERATOR", "DEALER"] as const;
export type SigningInitiator = (typeof SIGNING_INITIATORS)[number];
export const APP_PLATFORMS = ["web", "android", "ios"] as const;
export type AppPlatform = (typeof APP_PLATFORMS)[number];

/** Numbers as written in the source document, compared with the admin configuration before publishing. */
export type LegalSourceValues = {
  commissionPct?: number;
  settlementDays?: number;
  registrationFeeRupees?: number;
  wholesaleRegistrationFeeRupees?: number;
  acceptMinutes?: number;
  slaChargesRupees?: Partial<Record<"lateReady" | "sellerCancel" | "lateThenCancel" | "defect" | "medicineBreach", number>>;
};

/** A clause the admin must confirm a lawyer has reviewed before publishing (none in v1.0). */
export type LegalReviewNote = { key: string; text: string; confirmedBy?: string | null; confirmedAt?: string | null };

export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    docType: text("doc_type", { enum: AGREEMENT_DOC_TYPES }).notNull(),
    /** Shop type keys the document applies to; empty = every shop. */
    appliesToShopTypes: text("applies_to_shop_types").array().notNull().default(sql`'{}'::text[]`),
    language: text("language", { enum: AGREEMENT_LANGUAGES }).notNull(),
    version: text("version").notNull(),
    effectiveDate: date("effective_date").notNull(),
    title: text("title").notNull(),
    templateBody: text("template_body").notNull(),
    letterheadTemplate: text("letterhead_template").notNull().default("agt-letterhead-v1"),
    templateSha256: text("template_sha256").notNull(),
    sourceValues: jsonb("source_values").$type<LegalSourceValues>().notNull().default({}),
    status: text("status", { enum: AGREEMENT_DOC_STATUSES }).notNull().default("DRAFT"),
    reviewStatus: text("review_status", { enum: AGREEMENT_REVIEW_STATUSES }).notNull().default("NOT_REQUIRED"),
    reviewNotes: jsonb("review_notes").$type<LegalReviewNote[]>().notNull().default([]),
    changeSummary: text("change_summary"),
    requiresResign: boolean("requires_resign").notNull().default(true),
    noticeSentAt: timestamp("notice_sent_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    retiredBy: uuid("retired_by"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("legal_documents_type_lang_version_uq").on(t.docType, t.language, t.version),
    index("legal_documents_status_idx").on(t.docType, t.status, t.effectiveDate),
  ],
);
export type LegalDocumentRow = typeof legalDocuments.$inferSelect;

export const legalDocumentSnapshots = pgTable(
  "legal_document_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    dataSha256: text("data_sha256").notNull(),
    /** Hash of what makes Annexure A (licences, name, address, owner): a change asks the owner to re-confirm. */
    materialFingerprint: text("material_fingerprint").notNull(),
    licenceIds: uuid("licence_ids").array().notNull().default(sql`'{}'::uuid[]`),
    licencesAsOf: timestamp("licences_as_of", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legal_document_snapshots_shop_idx").on(t.shopId, t.createdAt)],
);
export type LegalDocumentSnapshot = typeof legalDocumentSnapshots.$inferSelect;

export const legalSigningRequests = pgTable(
  "legal_signing_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    reason: text("reason", { enum: SIGNING_REASONS }).notNull(),
    status: text("status", { enum: ["OPEN", "SIGNED", "CANCELLED", "EXPIRED"] }).notNull().default("OPEN"),
    initiatedByUserId: uuid("initiated_by_user_id"),
    initiatedAs: text("initiated_as", { enum: SIGNING_INITIATORS }).notNull().default("SELF"),
    linkTokenHash: text("link_token_hash"),
    linkExpiresAt: timestamp("link_expires_at", { withTimezone: true }),
    linkSentAt: timestamp("link_sent_at", { withTimezone: true }),
    snapshotId: uuid("snapshot_id"),
    otpId: uuid("otp_id"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("legal_signing_requests_token_uq").on(t.linkTokenHash).where(sql`${t.linkTokenHash} IS NOT NULL`),
    index("legal_signing_requests_shop_idx").on(t.shopId, t.status, t.createdAt),
  ],
);
export type LegalSigningRequest = typeof legalSigningRequests.$inferSelect;

export type SignedPdfHashes = Partial<Record<LegalLanguage, string>>;

/** IMMUTABLE (trigger legal_acceptances_immutable): insert only. */
export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signingRequestId: uuid("signing_request_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    userId: uuid("user_id").notNull(),
    /** The English master row of the document version (null for Terms / Privacy, which live in policy_versions). */
    legalDocumentId: uuid("legal_document_id"),
    docType: text("doc_type", { enum: AGREEMENT_DOC_TYPES }).notNull(),
    version: text("version").notNull(),
    languageViewed: text("language_viewed", { enum: AGREEMENT_LANGUAGES }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    appPlatform: text("app_platform", { enum: APP_PLATFORMS }).notNull(),
    otpVerificationRef: uuid("otp_verification_ref"),
    signerName: text("signer_name").notNull(),
    signerDesignation: text("signer_designation").notNull(),
    dataSnapshotId: uuid("data_snapshot_id"),
    licenceIdsIncluded: uuid("licence_ids_included").array().notNull().default(sql`'{}'::uuid[]`),
    /** SHA-256 of each language's signed agreement PDF (before the acceptance certificate page is added). */
    signedPdfHashes: jsonb("signed_pdf_hashes").$type<SignedPdfHashes>().notNull().default({}),
    /** SHA-256 of each language's certified copy (agreement + certificate), the file the owner downloads. */
    certifiedPdfHashes: jsonb("certified_pdf_hashes").$type<SignedPdfHashes>().notNull().default({}),
    templateSha256: text("template_sha256"),
    registeredByRole: text("registered_by_role", { enum: SIGNING_INITIATORS }).notNull().default("SELF"),
    registeredByUserId: uuid("registered_by_user_id"),
    geoLocation: jsonb("geo_location").$type<{ lat: number; lng: number; accuracyM?: number } | null>(),
    /** Short public code on the certificate and the Verify page. */
    verifyCode: text("verify_code").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("legal_acceptances_verify_code_uq").on(t.verifyCode),
    index("legal_acceptances_shop_idx").on(t.shopId, t.acceptedAt),
    index("legal_acceptances_doc_idx").on(t.docType, t.version, t.acceptedAt),
    index("legal_acceptances_request_idx").on(t.signingRequestId),
  ],
);
export type LegalAcceptance = typeof legalAcceptances.$inferSelect;

/** IMMUTABLE: the signed PDFs, encrypted with encryptBytes (src/lib/pan-crypto.ts). */
export const legalSignedFiles = pgTable(
  "legal_signed_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    acceptanceId: uuid("acceptance_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    legalDocumentId: uuid("legal_document_id"),
    language: text("language", { enum: AGREEMENT_LANGUAGES }).notNull(),
    kind: text("kind", { enum: ["SIGNED", "CERTIFIED"] }).notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    dataEncrypted: bytea("data_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("legal_signed_files_acceptance_lang_kind_uq").on(t.acceptanceId, t.language, t.kind),
    index("legal_signed_files_sha_idx").on(t.sha256),
  ],
);
export type LegalSignedFile = typeof legalSignedFiles.$inferSelect;

export const legalShopAgreementStates = pgTable(
  "legal_shop_agreement_states",
  {
    shopId: uuid("shop_id").primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull(),
    reason: text("reason", { enum: SIGNING_REASONS }).notNull(),
    requiredSince: timestamp("required_since", { withTimezone: true }).notNull(),
    graceUntil: timestamp("grace_until", { withTimezone: true }).notNull(),
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    lastSigningRequestId: uuid("last_signing_request_id"),
    satisfiedAt: timestamp("satisfied_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legal_shop_agreement_states_open_idx").on(t.graceUntil).where(sql`${t.satisfiedAt} IS NULL`)],
);
export type LegalShopAgreementState = typeof legalShopAgreementStates.$inferSelect;

export const legalPlatformAssets = pgTable("legal_platform_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind", { enum: ["E_SEAL"] }).notNull(),
  contentType: text("content_type", { enum: ["image/png", "image/jpeg"] }).notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  uploadedBy: uuid("uploaded_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type LegalPlatformAsset = typeof legalPlatformAssets.$inferSelect;

/** One signed-copy e-mail (first send or a Resend); delivered through document_emails (doc_type SELLER_AGREEMENTS, doc_id = this id). */
export const legalAgreementEmails = pgTable(
  "legal_agreement_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signingRequestId: uuid("signing_request_id").notNull(),
    shopId: uuid("shop_id").notNull(),
    kind: text("kind", { enum: ["SIGNED_COPY", "RESEND"] }).notNull(),
    includeBanners: boolean("include_banners").notNull().default(false),
    requestedBy: uuid("requested_by"),
    /** What was attached / linked at the last send: [{ filename, bytes, linked }]. */
    attachments: jsonb("attachments").$type<{ filename: string; bytes: number; linked: boolean }[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legal_agreement_emails_request_idx").on(t.signingRequestId, t.createdAt)],
);
export type LegalAgreementEmail = typeof legalAgreementEmails.$inferSelect;
