/**
 * Franchise dealer module, Pune PMR area booking (drizzle/0157_franchise_pmr.sql; docs/franchise/README.md).
 *
 * Foreign keys to dealers, shops, referral_codes and dealer_salespeople exist in the SQL; they are not
 * repeated here so this file needs no import from schema.ts (which re-exports it). The capacity rule
 * (two slots a zone, one slot an owner) is the pair of partial unique indexes in the SQL.
 */
import { bigint, boolean, date, integer, jsonb, numeric, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";

import type { AllocationStatus, BookingStatus, CouponScope, LatLng, ZoneStatus, ZoneTier } from "@/lib/franchise";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const money = (name: string) => bigint(name, { mode: "number" });

export const franchiseZoneSets = pgTable("franchise_zone_sets", {
  code: text("code").primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseZoneSet = typeof franchiseZoneSets.$inferSelect;

export const franchiseZones = pgTable("franchise_zones", {
  zoneId: text("zone_id").primaryKey(),
  zoneSetCode: text("zone_set_code").notNull(),
  clusterNo: integer("cluster_no").notNull(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  civicBody: text("civic_body"),
  reason: text("reason").notNull(),
  status: text("status").$type<ZoneStatus>().notNull().default("COMING_SOON"),
  reservedForDealerId: uuid("reserved_for_dealer_id"),
  reservedUntil: ts("reserved_until"),
  maxOwners: smallint("max_owners").notNull().default(2),
  isTest: boolean("is_test").notNull().default(false),
  statusReason: text("status_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseZone = typeof franchiseZones.$inferSelect;

export const franchiseAreas = pgTable("franchise_areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneSetCode: text("zone_set_code").notNull(),
  areaNo: integer("area_no").notNull(),
  name: text("name").notNull(),
  region: text("region").notNull(),
  civicBody: text("civic_body"),
  notes: text("notes"),
  /** null = Unzoned: free teams may register shops here, no franchise can be bought. */
  zoneId: text("zone_id"),
  lat: numeric("lat", { precision: 9, scale: 6, mode: "number" }),
  lng: numeric("lng", { precision: 9, scale: 6, mode: "number" }),
  pincodes: text("pincodes").array().notNull().default([]),
  aliases: text("aliases").array().notNull().default([]),
  locationSource: text("location_source", { enum: ["APPROXIMATE", "ADMIN"] }).notNull().default("APPROXIMATE"),
  isTest: boolean("is_test").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseArea = typeof franchiseAreas.$inferSelect;

export const franchiseAreaZoneHistory = pgTable("franchise_area_zone_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  areaId: uuid("area_id").notNull(),
  oldZoneId: text("old_zone_id"),
  newZoneId: text("new_zone_id"),
  reason: text("reason").notNull(),
  changedBy: uuid("changed_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const franchiseShopAreaPeriods = pgTable("franchise_shop_area_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  areaId: uuid("area_id").notNull(),
  zoneId: text("zone_id"),
  validFrom: ts("valid_from").notNull().defaultNow(),
  validTo: ts("valid_to"),
  source: text("source", { enum: ["REGISTRATION", "ADMIN", "OPERATOR", "BACKFILL"] }).notNull(),
  reason: text("reason"),
  setBy: uuid("set_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseShopAreaPeriod = typeof franchiseShopAreaPeriods.$inferSelect;

export const franchiseZoneBusiness = pgTable("franchise_zone_business", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: text("zone_id").notNull(),
  batchId: uuid("batch_id").notNull(),
  metric: text("metric", { enum: ["INDEX", "ANNUAL_CR"] }).notNull(),
  value: numeric("value", { precision: 14, scale: 2, mode: "number" }).notNull(),
  source: text("source").notNull(),
  asOf: date("as_of", { mode: "string" }).notNull(),
  provisional: boolean("provisional").notNull().default(false),
  status: text("status", { enum: ["DRAFT", "PUBLISHED", "SUPERSEDED", "DISCARDED"] }).notNull().default("DRAFT"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  publishedBy: uuid("published_by"),
  publishedAt: ts("published_at"),
});
export type FranchiseZoneBusiness = typeof franchiseZoneBusiness.$inferSelect;

export const franchiseZoneFeeVersions = pgTable("franchise_zone_fee_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: text("zone_id").notNull(),
  businessId: uuid("business_id"),
  tier: text("tier").$type<ZoneTier>().notNull(),
  value: numeric("value", { precision: 14, scale: 2, mode: "number" }).notNull(),
  average: numeric("average", { precision: 14, scale: 4, mode: "number" }).notNull(),
  diffBp: integer("diff_bp").notNull(),
  feePaise: money("fee_paise").notNull(),
  reason: text("reason").notNull(),
  provisional: boolean("provisional").notNull().default(false),
  effectiveFrom: ts("effective_from").notNull().defaultNow(),
  supersededAt: ts("superseded_at"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseZoneFeeVersion = typeof franchiseZoneFeeVersions.$inferSelect;

export const franchiseZoneStatusHistory = pgTable("franchise_zone_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  zoneId: text("zone_id").notNull(),
  oldStatus: text("old_status").$type<ZoneStatus | null>(),
  newStatus: text("new_status").$type<ZoneStatus>().notNull(),
  reason: text("reason").notNull(),
  reservedForDealerId: uuid("reserved_for_dealer_id"),
  reservedUntil: ts("reserved_until"),
  changedBy: uuid("changed_by"),
  scheduledFor: ts("scheduled_for"),
  appliedAt: ts("applied_at"),
  cancelledAt: ts("cancelled_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseZoneStatusChange = typeof franchiseZoneStatusHistory.$inferSelect;

export const franchiseCoupons = pgTable("franchise_coupons", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  note: text("note"),
  discountType: text("discount_type", { enum: ["PERCENT", "FLAT"] }).notNull(),
  percentBp: integer("percent_bp"),
  flatPaise: money("flat_paise"),
  maxDiscountPaise: money("max_discount_paise"),
  scope: jsonb("scope").$type<CouponScope>().notNull().default({ all: true }),
  appliesOn: text("applies_on", { enum: ["NEW", "RENEWAL", "BOTH"] }).notNull().default("BOTH"),
  visibility: text("visibility", { enum: ["PUBLIC", "PRIVATE"] }).notNull().default("PUBLIC"),
  startsAt: ts("starts_at").notNull(),
  endsAt: ts("ends_at").notNull(),
  totalLimit: integer("total_limit"),
  perDealerLimit: integer("per_dealer_limit"),
  minCartPaise: money("min_cart_paise"),
  firstPurchaseOnly: boolean("first_purchase_only").notNull().default(false),
  launchOnly: boolean("launch_only").notNull().default(false),
  status: text("status", { enum: ["ACTIVE", "PAUSED"] }).notNull().default("ACTIVE"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseCoupon = typeof franchiseCoupons.$inferSelect;

export const franchiseCouponAssignments = pgTable("franchise_coupon_assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  couponId: uuid("coupon_id").notNull(),
  dealerId: uuid("dealer_id"),
  mobileE164: text("mobile_e164"),
  email: text("email"),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseCouponAssignment = typeof franchiseCouponAssignments.$inferSelect;

export const franchiseCouponRedemptions = pgTable("franchise_coupon_redemptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  couponId: uuid("coupon_id").notNull(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  bookingId: uuid("booking_id").notNull(),
  discountPaise: money("discount_paise").notNull(),
  status: text("status", { enum: ["HELD", "USED", "RELEASED"] }).notNull().default("HELD"),
  heldUntil: ts("held_until").notNull(),
  usedAt: ts("used_at"),
  releasedAt: ts("released_at"),
  releaseReason: text("release_reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseCouponRedemption = typeof franchiseCouponRedemptions.$inferSelect;

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
  /** The zones' list fees together; base = list − discount (the taxable amount). */
  listPaise: money("list_paise").notNull(),
  discountPaise: money("discount_paise").notNull().default(0),
  couponId: uuid("coupon_id"),
  couponCode: text("coupon_code"),
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
  /** The zone's list fee, locked for the term. */
  feePaise: money("fee_paise").notNull(),
  /** This payment's coupon share (the list fee stays locked). */
  discountPaise: money("discount_paise").notNull().default(0),
  tier: text("tier").$type<ZoneTier>().notNull(),
  feeVersionId: uuid("fee_version_id"),
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
  discountPaise: money("discount_paise").notNull().default(0),
  tier: text("tier").$type<ZoneTier | null>(),
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
  /** The franchise this code belongs to (one per owner per franchise); closed for new shops at its expiry. */
  allocationId: uuid("allocation_id").notNull(),
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
  /** TEAM: a Model B shop of the owner's team; UPGRADE: an earlier free-dealership shop of his team in the zone. */
  origin: text("origin", { enum: ["TEAM", "UPGRADE"] }).notNull().default("TEAM"),
  franchiseCodeId: uuid("franchise_code_id"),
  memberId: uuid("member_id"),
  status: text("status", { enum: ["ACTIVE", "HELD", "REVERSED"] }).notNull().default("ACTIVE"),
  holdReason: text("hold_reason"),
  registeredAt: ts("registered_at").notNull().defaultNow(),
  activatedAt: ts("activated_at"),
  /** Referral move (22-Nov-2026): attached to this franchise from this moment (null: from the start). Earlier
   * attachments are in franchise_shop_team_periods. */
  attachedFrom: ts("attached_from"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type FranchiseShopAttribution = typeof franchiseShopAttributions.$inferSelect;

/** Referral move (owner, 22-Nov-2026): a shop's earlier attachment to another franchise's team, [validFrom, validTo).
 * Recurring commission for orders delivered in that window stays with that franchise ("old stays, new from move"). */
export const franchiseShopTeamPeriods = pgTable("franchise_shop_team_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull(),
  zoneId: text("zone_id").notNull(),
  allocationId: uuid("allocation_id").notNull(),
  ownerDealerId: uuid("owner_dealer_id").notNull(),
  validFrom: ts("valid_from"),
  validTo: ts("valid_to").notNull(),
  reason: text("reason").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
export type FranchiseShopTeamPeriod = typeof franchiseShopTeamPeriods.$inferSelect;

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
