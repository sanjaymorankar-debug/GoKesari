/**
 * Rider App v2 + Rider Pay Plans (docs/rider-app-v2-2026-11; drizzle/0210_rider_app_v2.sql).
 * Re-exported by schema.ts. Zones are HDMS delivery_zones (no foreign key: a zone can be removed
 * while an old, read-only plan version still names it).
 */
import { bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { PaySlab } from "@/lib/rider-pay-plan";
import { deliveryPartners, riderEarningSlots } from "./schema";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const PAY_PLAN_SCOPES = ["DEFAULT", "CITY", "ZONE"] as const;
export type PayPlanScope = (typeof PAY_PLAN_SCOPES)[number];
export const PAY_PLAN_STATUSES = ["DRAFT", "SCHEDULED", "ACTIVE", "RETIRED"] as const;
export type PayPlanStatus = (typeof PAY_PLAN_STATUSES)[number];

/** One version of a pay plan. Versions of the same plan share planKey; only DRAFT rows are edited. */
export const riderPayPlans = pgTable(
  "rider_pay_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planKey: uuid("plan_key").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    scopeType: text("scope_type").$type<PayPlanScope>().notNull().default("DEFAULT"),
    city: text("city"),
    zoneId: uuid("zone_id"),
    status: text("status").$type<PayPlanStatus>().notNull().default("DRAFT"),
    /** IST moment from which new offers use this version (set when published). */
    effectiveFrom: ts("effective_from"),
    baseFeePaise: integer("base_fee_paise").notNull(),
    /** The first part of the shop → customer leg the base fee covers, metres. */
    baseIncludedM: integer("base_included_m").notNull().default(0),
    slabs: jsonb("slabs").$type<PaySlab[]>().notNull().default([]),
    freeFirstMileM: integer("free_first_mile_m").notNull().default(0),
    firstMileRatePaise: integer("first_mile_rate_paise").notNull().default(0),
    firstMileCapPaise: integer("first_mile_cap_paise").notNull().default(0),
    freeWaitMin: integer("free_wait_min").notNull().default(0),
    waitRatePaise: integer("wait_rate_paise").notNull().default(0),
    waitCapPaise: integer("wait_cap_paise").notNull().default(0),
    extraDropFeePaise: integer("extra_drop_fee_paise").notNull().default(0),
    longDistanceM: integer("long_distance_m"),
    longDistanceBonusPaise: integer("long_distance_bonus_paise").notNull().default(0),
    minGuaranteePaise: integer("min_guarantee_paise").notNull().default(0),
    maxPerOrderPaise: integer("max_per_order_paise"),
    rerouteTolerancePct: integer("reroute_tolerance_pct").notNull().default(15),
    note: text("note"),
    /** The last simulator run on this version (required before publishing). */
    simulation: jsonb("simulation").$type<Record<string, unknown>>(),
    simulatedAt: ts("simulated_at"),
    createdBy: uuid("created_by"),
    publishedBy: uuid("published_by"),
    publishedAt: ts("published_at"),
    retiredAt: ts("retired_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rider_pay_plans_key_version_unique").on(t.planKey, t.version),
    index("rider_pay_plans_status_idx").on(t.status, t.scopeType),
  ],
);
export type RiderPayPlan = typeof riderPayPlans.$inferSelect;

export const SURGE_REASONS = ["RAIN", "FESTIVAL", "EVENT", "OTHER"] as const;
export type SurgeReason = (typeof SURGE_REASONS)[number];

/** A manual surge switch (rain, festival, event) for a city or one zone; ends by itself at endsAt. */
export const riderSurges = pgTable(
  "rider_surges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    city: text("city"),
    zoneId: uuid("zone_id"),
    multiplierBp: integer("multiplier_bp").notNull().default(10000),
    flatPaise: integer("flat_paise").notNull().default(0),
    reason: text("reason").$type<SurgeReason>().notNull(),
    note: text("note"),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    endedAt: ts("ended_at"),
    endedBy: uuid("ended_by"),
    createdBy: uuid("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("rider_surges_window_idx").on(t.endsAt, t.startsAt)],
);
export type RiderSurge = typeof riderSurges.$inferSelect;

export const riderSlotBookings = pgTable(
  "rider_slot_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryPartnerId: uuid("delivery_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "cascade" }),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => riderEarningSlots.id, { onDelete: "cascade" }),
    slotDate: date("slot_date").notNull(),
    status: text("status").$type<"BOOKED" | "CANCELLED">().notNull().default("BOOKED"),
    remindedAt: ts("reminded_at"),
    cancelledAt: ts("cancelled_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rider_slot_bookings_unique").on(t.deliveryPartnerId, t.slotId, t.slotDate).where(sql`status = 'BOOKED'`),
    index("rider_slot_bookings_date_idx").on(t.slotDate, t.slotId),
  ],
);
export type RiderSlotBooking = typeof riderSlotBookings.$inferSelect;

export const riderReferrals = pgTable(
  "rider_referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerPartnerId: uuid("referrer_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "cascade" }),
    referredPartnerId: uuid("referred_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "cascade" }),
    status: text("status").$type<"PENDING" | "QUALIFIED" | "EXPIRED">().notNull().default("PENDING"),
    /** The terms at the time of referral (rule riderReferral), kept so a later change never moves the goalposts. */
    deliveriesRequired: integer("deliveries_required").notNull(),
    withinDays: integer("within_days").notNull(),
    rewardPaise: integer("reward_paise").notNull(),
    qualifiedAt: ts("qualified_at"),
    /** The rider adjustment that paid the reward. */
    paidAdjustmentId: uuid("paid_adjustment_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("rider_referrals_referred_unique").on(t.referredPartnerId),
    index("rider_referrals_referrer_idx").on(t.referrerPartnerId),
  ],
);
export type RiderReferral = typeof riderReferrals.$inferSelect;

export interface NetworkHospital {
  name: string;
  city: string;
  address?: string;
  phone?: string;
}

export const riderInsurancePolicies = pgTable("rider_insurance_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  insurer: text("insurer").notNull(),
  policyNumber: text("policy_number").notNull(),
  healthCoverPaise: bigint("health_cover_paise", { mode: "number" }).notNull().default(0),
  accidentCoverPaise: bigint("accident_cover_paise", { mode: "number" }).notNull().default(0),
  opdCoverPaise: bigint("opd_cover_paise", { mode: "number" }).notNull().default(0),
  /** Eligible when the rider completed at least minDeliveries in the last lookbackDays. */
  minDeliveries: integer("min_deliveries").notNull().default(1),
  lookbackDays: integer("lookback_days").notNull().default(30),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to").notNull(),
  hospitalsUrl: text("hospitals_url"),
  hospitals: jsonb("hospitals").$type<NetworkHospital[]>().notNull().default([]),
  claimHelp: text("claim_help"),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: uuid("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type RiderInsurancePolicy = typeof riderInsurancePolicies.$inferSelect;

export const riderNominees = pgTable("rider_nominees", {
  deliveryPartnerId: uuid("delivery_partner_id")
    .primaryKey()
    .references(() => deliveryPartners.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  relation: text("relation").notNull(),
  mobile: text("mobile"),
  dateOfBirth: date("date_of_birth"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
export type RiderNominee = typeof riderNominees.$inferSelect;

export const riderSosEvents = pgTable(
  "rider_sos_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deliveryPartnerId: uuid("delivery_partner_id")
      .notNull()
      .references(() => deliveryPartners.id, { onDelete: "cascade" }),
    deliveryOrderId: uuid("delivery_order_id"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    accuracyM: integer("accuracy_m"),
    status: text("status").$type<"OPEN" | "ACKNOWLEDGED" | "CLOSED">().notNull().default("OPEN"),
    acknowledgedBy: uuid("acknowledged_by"),
    acknowledgedAt: ts("acknowledged_at"),
    closedAt: ts("closed_at"),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("rider_sos_events_status_idx").on(t.status, t.createdAt)],
);
export type RiderSosEvent = typeof riderSosEvents.$inferSelect;
