/**
 * Referral sharing (docs/referral-sharing-2026-11; drizzle/0211_referral_link_events.sql).
 *
 * Tracking only: every share button press, link click, first app open and deferred claim of a
 * referral link. Rewards and commission are never decided from here — they stay with the existing
 * referral tables. users is not referenced by foreign key (a tracking row must never block an
 * account deletion). Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const REFERRAL_LINK_EVENTS = ["SHARE", "CLICK", "APP_OPEN", "CLAIM"] as const;
export const REFERRAL_LINK_KINDS = ["CUSTOMER", "SHOP", "DEALER", "FRANCHISE", "GOKESARI", "UNKNOWN"] as const;
export type ReferralLinkEvent = (typeof REFERRAL_LINK_EVENTS)[number];
export type ReferralLinkKind = (typeof REFERRAL_LINK_KINDS)[number];

export const referralLinkEvents = pgTable(
  "referral_link_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    kind: text("kind", { enum: REFERRAL_LINK_KINDS }).notNull(),
    event: text("event", { enum: REFERRAL_LINK_EVENTS }).notNull(),
    channel: text("channel"),
    outcome: text("outcome").notNull().default("OK"),
    referrerUserId: uuid("referrer_user_id"),
    actorUserId: uuid("actor_user_id"),
    ipHash: text("ip_hash"),
    inApp: boolean("in_app").notNull().default(false),
    claimedByUserId: uuid("claimed_by_user_id"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("referral_link_events_code_idx").on(t.code, t.createdAt),
    index("referral_link_events_referrer_idx").on(t.referrerUserId, t.createdAt).where(sql`${t.referrerUserId} IS NOT NULL`),
    index("referral_link_events_deferred_idx").on(t.ipHash, t.createdAt).where(sql`${t.event} = 'CLICK' AND ${t.claimedAt} IS NULL`),
    index("referral_link_events_created_idx").on(t.createdAt),
  ],
);
export type ReferralLinkEventRow = typeof referralLinkEvents.$inferSelect;
