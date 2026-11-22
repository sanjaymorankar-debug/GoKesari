/**
 * Add product by photo + voice (docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md;
 * drizzle/0168_shop_photo_listing.sql).
 *
 * One row per product shot: what the AI read (each field with its confidence) next to what the owner
 * published, for the admin's "products added by photo" and AI-accuracy report. Shops, products and
 * listings are seller-side tables and are not referenced by key (the service checks those links).
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { bigint, customType, index, integer, jsonb, numeric, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });

export type PhotoListingStatus = "DRAFT" | "UNREADABLE" | "PUBLISHED" | "DISCARDED";
export type PhotoListingOutcome = "LINKED_MASTER" | "UPDATED_LISTING" | "REUSED_EXISTING" | "CREATED_PENDING" | "CREATED_APPROVED";
export type PhotoSide = "FRONT" | "BACK" | "LABEL" | "BARCODE" | "OTHER";

export const shopPhotoListings = pgTable(
  "shop_photo_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopId: uuid("shop_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    status: text("status").$type<PhotoListingStatus>().notNull().default("DRAFT"),
    /** BLURRY | DARK | NOT_A_PRODUCT | CUT_OFF | OTHER — shown with "please retake". */
    unreadableReason: text("unreadable_reason"),
    photoCount: smallint("photo_count").notNull().default(0),
    /** The shop's local language for the second description (mr / hi). */
    localLang: text("local_lang").notNull().default("hi"),
    aiModel: text("ai_model"),
    /** What the AI read: { field: { value, confidence } } plus descriptions and spec lists. */
    aiFields: jsonb("ai_fields").$type<Record<string, unknown>>(),
    /** GTIN | BRAND_NAME_PACK | null (no master match found when the photos were read). */
    matchType: text("match_type"),
    matchProductId: uuid("match_product_id"),
    matchScore: smallint("match_score"),
    /** What the owner published (same field names as aiFields, plain values). */
    publishedFields: jsonb("published_fields").$type<Record<string, unknown>>(),
    changedFields: text("changed_fields").array().notNull().default(sql`'{}'::text[]`),
    fieldsKept: smallint("fields_kept").notNull().default(0),
    fieldsChanged: smallint("fields_changed").notNull().default(0),
    outcome: text("outcome").$type<PhotoListingOutcome>(),
    productId: uuid("product_id"),
    shopProductId: uuid("shop_product_id"),
    pricePaise: bigint("price_paise", { mode: "number" }),
    priceUnit: text("price_unit"),
    stock: numeric("stock", { precision: 14, scale: 3 }),
    stockUnit: text("stock_unit"),
    customUnit: text("custom_unit"),
    /** The owner's spoken or typed price/stock sentence, as given. */
    voiceText: text("voice_text"),
    photosExpireAt: ts("photos_expire_at").notNull(),
    photosDeletedAt: ts("photos_deleted_at"),
    publishedAt: ts("published_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("shop_photo_listings_shop_idx").on(t.shopId, t.status, t.createdAt),
    index("shop_photo_listings_report_idx").on(t.publishedAt),
    index("shop_photo_listings_expiry_idx").on(t.photosExpireAt),
  ],
);
export type ShopPhotoListing = typeof shopPhotoListings.$inferSelect;

/** A photo the AI read (JPEG, no EXIF). Served only to the shop's owner while the draft is open. */
export const shopPhotoListingPhotos = pgTable(
  "shop_photo_listing_photos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id").notNull(),
    position: smallint("position").notNull(),
    side: text("side").$type<PhotoSide>().notNull().default("FRONT"),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("shop_photo_listing_photos_listing_idx").on(t.listingId, t.position)],
);
