/**
 * Smart shopping (docs/smart-shopping-2026-11; drizzle/0167_smart_shopping.sql):
 * the AI usage log shared by every AI feature, and the customer's photo
 * shopping list → wishlist.
 *
 * Foreign keys to users exist in the SQL; products and shops are not
 * referenced by key (seller-side tables: the service checks those links).
 * Re-exported by schema.ts.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, customType, index, integer, numeric, pgTable, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });

/** One row per AI call (photo or text read). Never the photo or the text itself. */
export const aiUsageLog = pgTable(
  "ai_usage_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** LIST_SCAN | PRODUCT_PHOTO | VOICE_PARSE | WHATSAPP_INTENT */
    feature: text("feature").notNull(),
    userId: uuid("user_id").notNull(),
    shopId: uuid("shop_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Estimated cost, micro-US-dollars; null when the model's price is unknown. */
    costMicros: bigint("cost_micros", { mode: "number" }),
    latencyMs: integer("latency_ms").notNull(),
    imageCount: smallint("image_count").notNull().default(0),
    /** OK | DECLINED | ERROR */
    outcome: text("outcome").notNull(),
    error: text("error"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("ai_usage_log_user_day_idx").on(t.userId, t.createdAt), index("ai_usage_log_feature_idx").on(t.feature, t.createdAt)],
);

/** A customer's photographed list (1–N pages), read by AI. Photos are private and deleted after the retention days. */
export const shoppingListScans = pgTable(
  "shopping_list_scans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    /** READ | UNREADABLE | FAILED */
    status: text("status").notNull(),
    /** What the photo was judged to be in: ["mr","en"]. */
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    handwritten: boolean("handwritten"),
    /** Why it could not be read (BLURRY, DARK, NOT_A_LIST, EMPTY), shown to the user. */
    unreadableReason: text("unreadable_reason"),
    pageCount: smallint("page_count").notNull(),
    lineCount: smallint("line_count").notNull().default(0),
    /** Lines read, as JSON (raw text, translation, quantity, candidates) — the review screen's input. */
    lines: text("lines_json").notNull().default("[]"),
    /** Photos are deleted after this; the row stays (without photos) for accuracy reports. */
    photosExpireAt: ts("photos_expire_at").notNull(),
    photosDeletedAt: ts("photos_deleted_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("shopping_list_scans_user_idx").on(t.userId, t.createdAt), index("shopping_list_scans_expiry_idx").on(t.photosExpireAt)],
);

/** A page photo of a scan (compressed webp). Served only to its customer (and admins). */
export const shoppingListScanPages = pgTable(
  "shopping_list_scan_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scanId: uuid("scan_id").notNull(),
    pageNo: smallint("page_no").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storage: text("storage", { enum: ["DB", "DISK"] }).notNull().default("DB"),
    storageKey: text("storage_key"),
    data: bytea("data"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("shopping_list_scan_pages_scan_idx").on(t.scanId, t.pageNo)],
);

/** A saved wishlist (from a scan, or typed). Items point at master products, so any shop can be compared. */
export const smartWishlists = pgTable(
  "smart_wishlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    scanId: uuid("scan_id"),
    name: text("name").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [index("smart_wishlists_user_idx").on(t.userId, t.updatedAt)],
);

export const smartWishlistItems = pgTable(
  "smart_wishlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wishlistId: uuid("wishlist_id").notNull(),
    position: smallint("position").notNull(),
    /** As written on the list ("साखर १ किलो"); null for an item added by hand. */
    originalText: text("original_text"),
    originalLang: text("original_lang"),
    nameEn: text("name_en").notNull(),
    /** In the customer's app language (or the list's language). */
    nameLocal: text("name_local"),
    /** Master product (products.id); null = not matched yet. */
    productId: uuid("product_id"),
    /** 0–100: how sure the match is. Null for a product the customer picked. */
    matchConfidence: smallint("match_confidence"),
    /** What AI suggested first, to measure accuracy against what the customer kept. */
    aiProductId: uuid("ai_product_id"),
    userEdited: boolean("user_edited").notNull().default(false),
    /** Requested amount in the base unit (g, ml, piece, pack, box, m). */
    quantityAmount: numeric("quantity_amount", { precision: 12, scale: 3 }).notNull(),
    quantityUnit: text("quantity_unit").notNull(),
    /** PENDING | ORDERED | NOT_ORDERED */
    status: text("status").notNull().default("PENDING"),
    /** The order (orders.id) this item went into last. */
    lastOrderId: uuid("last_order_id"),
    lastShopId: uuid("last_shop_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("smart_wishlist_items_list_idx").on(t.wishlistId, t.position)],
);
