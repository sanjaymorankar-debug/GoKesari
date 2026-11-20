/**
 * Franchise dealer module, Pune PMR area booking (drizzle/0157_franchise_pmr.sql; docs/franchise/README.md).
 *
 * Foreign keys to dealers, shops, referral_codes and dealer_salespeople exist in the SQL; they are not
 * repeated here so this file needs no import from schema.ts (which re-exports it). The capacity rule
 * (two slots a zone, one slot an owner) is the pair of partial unique indexes in the SQL.
 */
import { bigint, boolean, date, integer, jsonb, numeric, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";

import type { AllocationStatus, BookingStatus, LatLng, ZoneStatus } from "@/lib/franchise";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const money = (name: string) => bigint(name, { mode: "number" });

export const franchiseRegions = pgTable("franchise_regions", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const franchiseClusters = pgTable("franchise_clusters", {
  code: text("code").primaryKey(),
  regionCode: text("region_code").notNull(),
  name: text("name").notNull(),
  sortOrder: smallint("sort_order").notNull(),
});
export type FranchiseCluster = typeof franchiseClusters.$inferSelect;

export const franchiseZones = pgTable("franchise_zones", {
  zoneId: text("zone_id").primaryKey(),
  regionCode: text("region_code").notNull(),
  clusterCode: text("cluster_code").notNull(),
  name: text("name").notNull(),
  commercialProfile: text("commercial_profile").notNull(),
  origin: text("origin", { enum: ["ORIGINAL", "SPLIT", "SUB_ZONE", "TEST"] }).notNull(),
  splitFromZone: text("split_from_zone"),
  parentZoneId: text("parent_zone_id"),
  status: text("status").$type<ZoneStatus>().notNull().default("BOUNDARY_PENDING"),
  maxOwners: smallint("max_owners").notNull().default(2),
  isTest: boolean("is_test").notNull().default(false),
  sortKey: integer("sort_key").notNull(),
  statusReason: text("status_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseZone = typeof franchiseZones.$inferSelect;

export const franchiseZonePins = pgTable(
  "franchise_zone_pins",
  {
    zoneId: text("zone_id").notNull(),
    pincode: text("pincode").notNull(),
  },
  (t) => [primaryKey({ name: "franchise_zone_pins_pk", columns: [t.zoneId, t.pincode] })],
);

export const franchiseZoneEstimates = pgTable("franchise_zone_estimates", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: text("zone_id").notNull(),
  estShopCount: integer("est_shop_count").notNull(),
  gmvPerShopLakh: numeric("gmv_per_shop_lakh", { precision: 8, scale: 2, mode: "number" }).notNull(),
  asOf: date("as_of", { mode: "string" }).notNull(),
  source: text("source").notNull(),
  isCurrent: boolean("is_current").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseZoneEstimate = typeof franchiseZoneEstimates.$inferSelect;

export const franchiseZoneBoundaries = pgTable("franchise_zone_boundaries", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: text("zone_id").notNull(),
  version: integer("version").notNull(),
  refLat: numeric("ref_lat", { precision: 9, scale: 6, mode: "number" }),
  refLng: numeric("ref_lng", { precision: 9, scale: 6, mode: "number" }),
  refLabel: text("ref_label"),
  refSource: text("ref_source", { enum: ["AUTO_GEOCODE", "ADMIN", "GEOJSON"] }).notNull().default("ADMIN"),
  refNeedsReview: boolean("ref_needs_review").notNull().default(false),
  shape: text("shape", { enum: ["NONE", "POLYGON", "CIRCLE"] }).notNull().default("NONE"),
  polygon: jsonb("polygon").$type<LatLng[] | null>(),
  radiusM: integer("radius_m"),
  maxDistanceM: integer("max_distance_m"),
  status: text("status", { enum: ["DRAFT", "APPROVED", "SUPERSEDED"] }).notNull().default("DRAFT"),
  note: text("note"),
  approvedBy: uuid("approved_by"),
  approvedAt: ts("approved_at"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseZoneBoundary = typeof franchiseZoneBoundaries.$inferSelect;

export const franchiseConfigVersions = pgTable("franchise_config_versions", {
  version: integer("version").primaryKey(),
  effectiveFrom: ts("effective_from").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseConfigVersion = typeof franchiseConfigVersions.$inferSelect;

export const franchiseAgreementAcceptances = pgTable("franchise_agreement_acceptances", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  userId: uuid("user_id").notNull(),
  version: text("version").notNull(),
  textSha256: text("text_sha256").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  acceptedAt: ts("accepted_at").notNull().defaultNow(),
});

export const franchiseBookings = pgTable("franchise_bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  kind: text("kind", { enum: ["NEW", "RENEWAL"] }).notNull().default("NEW"),
  status: text("status").$type<BookingStatus>().notNull().default("RESERVED"),
  areaCount: integer("area_count").notNull(),
  feePerAreaPaise: money("fee_per_area_paise").notNull(),
  basePaise: money("base_paise").notNull(),
  gstRateBp: integer("gst_rate_bp").notNull(),
  gstPaise: money("gst_paise").notNull(),
  totalPaise: money("total_paise").notNull(),
  configVersion: integer("config_version").notNull(),
  launchOffer: boolean("launch_offer").notNull().default(false),
  agreementAcceptanceId: uuid("agreement_acceptance_id"),
  renewalAllocationId: uuid("renewal_allocation_id"),
  paymentIntentId: uuid("payment_intent_id"),
  holdExpiresAt: ts("hold_expires_at").notNull(),
  paidAt: ts("paid_at"),
  failureReason: text("failure_reason"),
  isTest: boolean("is_test").notNull().default(false),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseBooking = typeof franchiseBookings.$inferSelect;

export const franchiseAllocations = pgTable("franchise_allocations", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: text("zone_id").notNull(),
  slotNo: smallint("slot_no").notNull(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  bookingId: uuid("booking_id").notNull(),
  status: text("status").$type<AllocationStatus>().notNull().default("RESERVED"),
  holdExpiresAt: ts("hold_expires_at"),
  /** The first activation (start of the chain): the tail is counted from it. */
  activatedAt: ts("activated_at"),
  /** Start of the current 12-month term (moves on renewal). */
  periodStart: ts("period_start"),
  expiresAt: ts("expires_at"),
  tailEndAt: ts("tail_end_at"),
  renewalCount: integer("renewal_count").notNull().default(0),
  feePaise: money("fee_paise").notNull(),
  configVersion: integer("config_version").notNull(),
  launchOffer: boolean("launch_offer").notNull().default(false),
  launchSeq: integer("launch_seq"),
  endedAt: ts("ended_at"),
  endReason: text("end_reason"),
  isTest: boolean("is_test").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseAllocation = typeof franchiseAllocations.$inferSelect;

export const franchiseAllocationRenewals = pgTable("franchise_allocation_renewals", {
  id: uuid("id").primaryKey().defaultRandom(),
  allocationId: uuid("allocation_id").notNull(),
  bookingId: uuid("booking_id").notNull(),
  previousExpiresAt: ts("previous_expires_at").notNull(),
  newExpiresAt: ts("new_expires_at").notNull(),
  feePaise: money("fee_paise").notNull(),
  paidAt: ts("paid_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const franchiseCampaigns = pgTable("franchise_campaigns", {
  code: text("code").primaryKey(),
  closedAt: ts("closed_at"),
  closedReason: text("closed_reason"),
  ownersAtClose: integer("owners_at_close"),
  areasAtClose: integer("areas_at_close"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const franchiseCodes = pgTable("franchise_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  referralCodeId: uuid("referral_code_id").notNull(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  /** The booked area this dealer code belongs to (one code per dealer per area); null for a member's tracking code. */
  allocationId: uuid("allocation_id"),
  memberId: uuid("member_id"),
  status: text("status", { enum: ["ACTIVE", "SUSPENDED", "RETIRED"] }).notNull().default("ACTIVE"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseCode = typeof franchiseCodes.$inferSelect;

export const franchiseShopAttributions = pgTable("franchise_shop_attributions", {
  shopId: uuid("shop_id").primaryKey(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  zoneId: text("zone_id").notNull(),
  franchiseCodeId: uuid("franchise_code_id").notNull(),
  memberId: uuid("member_id"),
  status: text("status", { enum: ["ACTIVE", "HELD", "REVERSED"] }).notNull().default("ACTIVE"),
  holdReason: text("hold_reason"),
  /** Set when an admin tagged a shop outside the code's area (brief 21-Nov-2026 §1.5). */
  overrideReason: text("override_reason"),
  overrideBy: uuid("override_by"),
  registeredAt: ts("registered_at").notNull().defaultNow(),
  activatedAt: ts("activated_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseShopAttribution = typeof franchiseShopAttributions.$inferSelect;

export const franchiseShopAttributionHistory = pgTable("franchise_shop_attribution_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  reason: text("reason").notNull(),
  changedBy: uuid("changed_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const franchiseMonthlySnapshots = pgTable("franchise_monthly_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  allocationId: uuid("allocation_id").notNull(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  zoneId: text("zone_id").notNull(),
  code: text("code"),
  month: text("month").notNull(),
  configVersion: integer("config_version").notNull(),
  openingShopIds: jsonb("opening_shop_ids").$type<string[]>().notNull().default([]),
  openingShops: integer("opening_shops").notNull(),
  baselinePaise: money("baseline_paise").notNull(),
  newShops: integer("new_shops").notNull(),
  actualBusinessPaise: money("actual_business_paise").notNull(),
  allBusinessPaise: money("all_business_paise").notNull(),
  regBasePts: integer("reg_base_pts").notNull(),
  bizBasePts: integer("biz_base_pts").notNull(),
  totalBasePts: integer("total_base_pts").notNull(),
  mainPts: numeric("main_pts", { precision: 10, scale: 2, mode: "number" }).notNull(),
  bonusBp: integer("bonus_bp").notNull(),
  commissionRateBp: integer("commission_rate_bp").notNull(),
  rating: numeric("rating", { precision: 4, scale: 2, mode: "number" }).notNull(),
  bonusEligible: boolean("bonus_eligible").notNull().default(true),
  onboardingPaise: money("onboarding_paise").notNull(),
  recurringPaise: money("recurring_paise").notNull(),
  adjustmentsPaise: money("adjustments_paise").notNull().default(0),
  totalPayoutPaise: money("total_payout_paise").notNull(),
  nextOpeningShops: integer("next_opening_shops").notNull(),
  status: text("status", { enum: ["DRAFT", "LOCKED"] }).notNull().default("DRAFT"),
  calculatedAt: ts("calculated_at").notNull().defaultNow(),
  lockedAt: ts("locked_at"),
  lockedBy: uuid("locked_by"),
  statementEmailedAt: ts("statement_emailed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseMonthlySnapshot = typeof franchiseMonthlySnapshots.$inferSelect;

export const franchiseNotificationLog = pgTable("franchise_notification_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  allocationId: uuid("allocation_id"),
  kind: text("kind").notNull(),
  dueOn: date("due_on", { mode: "string" }).notNull(),
  channel: text("channel", { enum: ["EMAIL", "SMS", "WHATSAPP", "PUSH", "IN_APP", "ADMIN_ALERT"] }).notNull(),
  recipient: text("recipient").notNull(),
  status: text("status", { enum: ["QUEUED", "SENT", "FAILED", "SKIPPED"] }).notNull(),
  detail: text("detail"),
  sentAt: ts("sent_at").notNull().defaultNow(),
});

export const franchiseComplianceViolations = pgTable("franchise_compliance_violations", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  allocationId: uuid("allocation_id"),
  level: text("level", { enum: ["WARNING", "RECORDED", "SUSPENSION", "TERMINATION"] }).notNull(),
  note: text("note").notNull(),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const franchiseCalcRuns = pgTable("franchise_calc_runs", {
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  kind: text("kind", { enum: ["MONTHLY"] }).notNull(),
  status: text("status", { enum: ["RUNNING", "DONE", "FAILED"] }).notNull().default("RUNNING"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid("created_by"),
});
