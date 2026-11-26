/**
 * Dual authentication (docs/dual-auth-2026-11; drizzle/0219_dual_auth.sql; flag dual_auth).
 *
 * trusted_devices: a browser / app that finished both factors (mobile SMS code + e-mail) for an account. Trusted
 * for 30 days (rule dualAuth.trustDays); the cookie gk_device holds a random token, the table only its sha256.
 * Re-exported by schema.ts.
 */
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./schema";

export const trustedDevices = pgTable(
  "trusted_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceHash: text("device_hash").notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    trustedAt: timestamp("trusted_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("trusted_devices_user_device_unique").on(t.userId, t.deviceHash), index("trusted_devices_expires_idx").on(t.expiresAt)],
);
export type TrustedDevice = typeof trustedDevices.$inferSelect;
