/**
 * Many GSTINs per shop (owner, 25-Nov-2026; drizzle/0202_shop_gst_registrations.sql).
 *
 * A shop keeps its main GSTIN on shops.gstin. A shop chain registered in several states adds the
 * other GSTINs here after going live — any PAN, each checked with the KYC vendor. An order
 * delivered in a state where the shop has a VERIFIED extra GSTIN is invoiced under that GSTIN,
 * with its outlet address from the GST record. Shops are not referenced by foreign key
 * (seller-side table): the service checks the link.
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const SHOP_GST_REGISTRATION_STATUSES = ["PENDING", "VERIFIED", "MANUAL_REVIEW", "FAILED"] as const;
export type ShopGstRegistrationStatus = (typeof SHOP_GST_REGISTRATION_STATUSES)[number];

export const shopGstRegistrations = pgTable(
  "shop_gst_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    /** base64(iv || tag || ciphertext) of the GSTIN. Never logged. */
    gstinEncrypted: text("gstin_encrypted").notNull(),
    /** Display form, e.g. "27XXXXXXXX34F1Z5". */
    gstinMasked: text("gstin_masked").notNull(),
    /** HMAC blind index (pan-crypto docBlindIndex("GSTIN", …)). */
    gstinHash: text("gstin_hash").notNull(),
    /** Two-digit GST state code, the GSTIN's first two digits ("27"). */
    stateCode: text("state_code").notNull(),
    status: text("status").$type<ShopGstRegistrationStatus>().notNull().default("PENDING"),
    legalName: text("legal_name"),
    tradeName: text("trade_name"),
    /** The outlet's address as on the GST record (printed on the invoice). */
    outletAddress: text("outlet_address"),
    outletPincode: text("outlet_pincode"),
    providerId: text("provider_id"),
    providerRef: text("provider_ref"),
    lastErrorCode: text("last_error_code"),
    consentGivenAt: ts("consent_given_at"),
    consentVersion: text("consent_version"),
    addedBy: uuid("added_by"),
    verifiedAt: ts("verified_at"),
    removedAt: ts("removed_at"),
    removedBy: uuid("removed_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("shop_gst_registrations_shop_idx").on(t.shopId),
    uniqueIndex("shop_gst_registrations_shop_hash_uq").on(t.shopId, t.gstinHash).where(sql`${t.removedAt} IS NULL`),
    // One GSTIN per state per shop: that is what picks the invoice's GSTIN.
    uniqueIndex("shop_gst_registrations_shop_state_uq").on(t.shopId, t.stateCode).where(sql`${t.removedAt} IS NULL`),
    index("shop_gst_registrations_hash_idx").on(t.gstinHash),
  ],
);

export type ShopGstRegistration = typeof shopGstRegistrations.$inferSelect;
