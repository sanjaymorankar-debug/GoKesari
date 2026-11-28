/**
 * Onboarding v2 (docs/onboarding-v2-2026-11; drizzle/0215_onboarding_v2.sql). Owner brief 26-Nov-2026 18.19 IST.
 *
 * Additive tables only, everything behind the feature flag `onboarding_v2`:
 *  - onboarding_role_history: who gave / took which marketplace role, when (stored UTC, shown IST).
 *  - team_invitations: a dealer / team lead asks a customer to join "My team"; the role is added only on accept.
 *  - franchise_plans: admin-managed subscription plans for a paid franchise zone.
 *  - registration_licence_entries: one row per required licence of a shop registration draft (4 options).
 *
 * users / dealers / dealer_salespeople / shop_registration_drafts are referenced by id without foreign keys where
 * the brief's "no FKs between seller and customer tables" rule applies (CLAUDE.md); services check the links.
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** The marketplace roles of the brief (staff roles stay in user_role_grants). */
export const MARKETPLACE_ROLES = [
  "customer",
  "shop_owner",
  "dealer_free",
  "franchisee_paid",
  "team_lead",
  "agent",
  "admin",
  "operator",
] as const;
export type MarketplaceRole = (typeof MARKETPLACE_ROLES)[number];

export const ROLE_HISTORY_ACTIONS = ["GRANTED", "REVOKED", "UPGRADED", "DOWNGRADED", "REASSIGNED", "MIGRATED", "OVERRIDE"] as const;
export type RoleHistoryAction = (typeof ROLE_HISTORY_ACTIONS)[number];

export const onboardingRoleHistory = pgTable(
  "onboarding_role_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: MARKETPLACE_ROLES }).notNull(),
    action: text("action", { enum: ROLE_HISTORY_ACTIONS }).notNull(),
    /** For UPGRADED / DOWNGRADED / REASSIGNED: the role or parent before and after. */
    fromValue: text("from_value"),
    toValue: text("to_value"),
    dealerId: uuid("dealer_id"),
    salespersonId: uuid("salesperson_id"),
    actorUserId: uuid("actor_user_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("onboarding_role_history_user_idx").on(t.userId, t.createdAt),
    index("onboarding_role_history_dealer_idx").on(t.dealerId, t.createdAt),
  ],
);

export const TEAM_INVITE_ROLES = ["TEAM_LEAD", "AGENT"] as const;
export const TEAM_INVITE_STATUSES = ["PENDING", "ACCEPTED", "DECLINED", "CANCELLED", "EXPIRED"] as const;
export type TeamInviteStatus = (typeof TEAM_INVITE_STATUSES)[number];

export const teamInvitations = pgTable(
  "team_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dealerId: uuid("dealer_id").notNull(),
    invitedByUserId: uuid("invited_by_user_id").notNull(),
    /** Set when a team lead (not the dealer) adds an agent under themselves. */
    invitedBySalespersonId: uuid("invited_by_salesperson_id"),
    /** Known customer account; null while an invite link waits for an unregistered person to sign up. */
    inviteeUserId: uuid("invitee_user_id"),
    inviteeMobileE164: text("invitee_mobile_e164"),
    inviteeEmail: text("invitee_email"),
    role: text("role", { enum: TEAM_INVITE_ROLES }).notNull(),
    /** AGENT only: the team lead (dealer_salespeople.id) the agent reports to; null = the dealer directly. */
    parentSalespersonId: uuid("parent_salesperson_id"),
    /** sha256 of the invite-link token (the token itself is never stored). */
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: TEAM_INVITE_STATUSES }).notNull().default("PENDING"),
    channels: jsonb("channels").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The dealer_salespeople row created on accept. */
    salespersonId: uuid("salesperson_id"),
  },
  (t) => [
    uniqueIndex("team_invitations_token_unique").on(t.tokenHash),
    index("team_invitations_dealer_idx").on(t.dealerId, t.status),
    index("team_invitations_invitee_idx").on(t.inviteeUserId, t.status),
  ],
);

export const franchisePlans = pgTable(
  "franchise_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    durationMonths: integer("duration_months").notNull().default(12),
    /** Price per zone before GST; null = the zone's own tier fee (franchise_zone_fee_versions). */
    pricePerZonePaise: integer("price_per_zone_paise"),
    gstExtra: boolean("gst_extra").notNull().default(true),
    isLaunchOffer: boolean("is_launch_offer").notNull().default(false),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [uniqueIndex("franchise_plans_code_unique").on(t.code)],
);

export const LICENCE_OPTIONS = ["ENTER", "UPLOAD", "SCAN", "LATER"] as const;
export type LicenceOption = (typeof LICENCE_OPTIONS)[number];
export const LICENCE_ENTRY_STATUSES = ["VERIFIED", "PENDING_OPERATOR", "PROMISED", "REJECTED"] as const;
export type LicenceEntryStatus = (typeof LICENCE_ENTRY_STATUSES)[number];

export const registrationLicenceEntries = pgTable(
  "registration_licence_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    shopId: uuid("shop_id"),
    /** Document key from shop_document_rules (FSSAI, DRUG_LICENCE, DOCTOR_REGISTRATION, ...). */
    licenceKey: text("licence_key").notNull(),
    option: text("option", { enum: LICENCE_OPTIONS }).notNull(),
    licenceNumber: text("licence_number"),
    holderName: text("holder_name"),
    validUntil: text("valid_until"),
    issuingAuthority: text("issuing_authority"),
    /** Uploaded / scanned file (media id or storage key). */
    fileRef: text("file_ref"),
    /** What OCR read, kept for the operator check. */
    ocr: jsonb("ocr").$type<Record<string, string | null>>(),
    status: text("status", { enum: LICENCE_ENTRY_STATUSES }).notNull(),
    statusReason: text("status_reason"),
    promiseAcceptedAt: timestamp("promise_accepted_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyRef: text("verify_ref"),
    /** 0217: the operator who decided a PENDING_OPERATOR entry (Admin → Shop documents → Registration licences). */
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /**
     * 0231 (owner, 28-Nov-2026): an EXPIRED licence promised for renewal at registration (option LATER, status PROMISED):
     * the expiry date the owner was shown, and when the renewal was promised. Chased like a missing promised licence.
     */
    expiredOn: text("expired_on"),
    renewalPromisedAt: timestamp("renewal_promised_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("registration_licence_entries_draft_key_unique").on(t.draftId, t.licenceKey),
    index("registration_licence_entries_shop_idx").on(t.shopId),
    index("registration_licence_entries_status_idx").on(t.status),
  ],
);

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * 0217 (Flow 2): a licence file uploaded or scanned during registration, before the shop exists — encrypted
 * (encryptBytes), opened by operators from the registration-licences queue. `registration_licence_entries.file_ref`
 * holds this row's id.
 */
export const registrationLicenceFiles = pgTable(
  "registration_licence_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull(),
    ownerUserId: uuid("owner_user_id").notNull(),
    licenceKey: text("licence_key").notNull(),
    /** FILE: chosen from files / photos; CAMERA: taken with the camera (Scan). */
    source: text("source", { enum: ["FILE", "CAMERA"] }).notNull().default("FILE"),
    contentType: text("content_type", { enum: ["application/pdf", "image/jpeg", "image/png", "image/webp"] }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    dataEncrypted: bytea("data_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("registration_licence_files_draft_idx").on(t.draftId, t.licenceKey)],
);
export type RegistrationLicenceEntry = typeof registrationLicenceEntries.$inferSelect;
