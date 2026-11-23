/**
 * Voice price & offer assistant (docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md).
 *
 * The shop owner says (or types) a product, or scans its barcode, and the change:
 * "Amul Taaza 1 litre price 58", "साखर 10 टक्के सूट रविवार पर्यंत". Two steps:
 *
 *   1. interpret — the deterministic reader (lib/voice-command-parse) first, AI (VOICE_COMMAND) only
 *      when it finds no change or no product words; the product is matched among THIS shop's own
 *      listings; the result is a proposal with what was understood, a read-back in English, Hindi and
 *      Marathi, and any problem (above MRP, offer too big, not sure which product …). Nothing changes.
 *   2. apply — after the owner says yes: the price through setShopPrices (price history is kept, as on
 *      the inventory page) and the offer through saveShopOffer (shop offers, audited), both re-checked.
 *
 * Owner only, like the inventory page's price "Save" and shop offers; staff price changes keep going
 * through the price-request flow. Hidden while voice_price_assistant_enabled is off for the shop's district.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { devanagariToLatin, hasDevanagari } from "@/lib/devanagari-latin";
import { AppError, conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaiseCompact, formatQuantity } from "@/lib/money";
import { MAX_PRICE_PAISE } from "@/lib/price-rules";
import { offerEndsAt, parseVoiceCommand, type OfferUntil, type SpokenOffer } from "@/lib/voice-command-parse";
import { AiUnavailableError, runAi } from "@/server/ai/provider";
import type { UserRole } from "@/server/db/schema";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { findProductByBarcode } from "@/server/services/barcode-lookup";
import { setShopPrices } from "@/server/services/catalogue";
import { requireFeatureForShop } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { saveShopOffer } from "@/server/services/shop-offers";

export const VOICE_PRICE_FLAG = "voice_price_assistant_enabled" as const;

export type VoiceLangKey = "en" | "hi" | "mr";
type Text3 = Record<VoiceLangKey, string>;

export interface VoiceActor {
  id: string;
  role: UserRole;
}

export interface VoiceListing {
  shopProductId: string;
  productId: string;
  name: string;
  /** "Amul Taaza · 1 L" */
  label: string;
  imageUrl: string | null;
  unit: string;
  kind: "PACKAGED" | "LOOSE";
  pricePaise: number | null;
  mrpPaise: number | null;
  /** Match score 0–100 (100 when picked by id or barcode). */
  score: number;
}

export interface ProposedOffer {
  discountType: "PERCENT" | "FLAT";
  percent: number | null;
  flatPaise: number | null;
  startsAt: string;
  endsAt: string;
}

export type IssueCode =
  | "NO_CHANGE"
  | "NO_PRODUCT"
  | "PRODUCT_NOT_FOUND"
  | "CHOOSE_PRODUCT"
  | "NOT_LISTED"
  | "ABOVE_MRP"
  | "BIG_DROP"
  | "BIG_RISE"
  | "NO_PRICE_FOR_OFFER"
  | "PERCENT_RANGE"
  | "FLAT_TOO_BIG"
  | "BUY_GET_FREE"
  | "PRICE_RANGE";

export interface VoiceIssue {
  code: IssueCode;
  /** A blocking issue stops "publish" until the owner fixes it. */
  blocking: boolean;
  message: Text3;
}

export interface VoiceProposal {
  text: string;
  /** The product words heard ("amul taaza 1 litre"). */
  productText: string | null;
  candidates: VoiceListing[];
  chosen: VoiceListing | null;
  newPricePaise: number | null;
  offer: ProposedOffer | null;
  /** What a customer pays per unit once both are live (null: no price to start from). */
  finalPricePaise: number | null;
  issues: VoiceIssue[];
  readBack: Text3;
  aiUsed: boolean;
  canPublish: boolean;
}

/* ------------------------------------------------------------ access */

async function assertVoiceAccess(shopId: string, actor: VoiceActor) {
  const [shop] = await db
    .select({ id: shops.id, ownerId: shops.ownerId, pincode: shops.pincode })
    .from(shops)
    .where(and(eq(shops.id, shopId), isNull(shops.deletedAt)));
  if (!shop) throw notFound("Shop");
  await requireFeatureForShop(VOICE_PRICE_FLAG, shop);
  if (shop.ownerId !== actor.id) throw forbidden("Only the shop's owner can change prices and offers by voice.");
  return shop;
}

/* ------------------------------------------------------------ listings */

type ListingRow = {
  shop_product_id: string;
  product_id: string;
  name: string;
  brand: string | null;
  image_url: string | null;
  unit: string;
  unit_size_milli: number;
  kind: "PACKAGED" | "LOOSE";
  online_price_paise: number | null;
  offline_price_paise: number | null;
  mrp_paise: number | null;
  score: number;
};

function toListing(r: ListingRow): VoiceListing {
  const size = Number(r.unit_size_milli);
  const pack = size > 0 ? formatQuantity(size, r.unit) : r.unit;
  const price = r.online_price_paise ?? r.offline_price_paise;
  return {
    shopProductId: r.shop_product_id,
    productId: r.product_id,
    name: r.name,
    label: `${r.name} · ${pack}`,
    imageUrl: r.image_url,
    unit: r.unit,
    kind: r.kind,
    pricePaise: price == null ? null : Number(price),
    mrpPaise: r.mrp_paise == null ? null : Number(r.mrp_paise),
    score: Math.max(0, Math.min(100, Math.round(Number(r.score) * 100))),
  };
}

const LISTING_COLUMNS = sql`
  sp.id AS shop_product_id, p.id AS product_id, p.name, b.name AS brand, COALESCE(sp.image_url, p.image_url) AS image_url,
  p.unit, p.unit_size_milli, p.kind, sp.online_price_paise, sp.offline_price_paise, p.mrp_paise`;

async function listingById(shopId: string, shopProductId: string): Promise<VoiceListing | null> {
  const rows = (await db.execute(sql`
    SELECT ${LISTING_COLUMNS}, 1.0 AS score
    FROM shop_products sp JOIN products p ON p.id = sp.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE sp.id = ${shopProductId} AND sp.shop_id = ${shopId} AND sp.deleted_at IS NULL
  `)) as unknown as ListingRow[];
  return rows[0] ? toListing(rows[0]) : null;
}

async function listingByProduct(shopId: string, productId: string): Promise<VoiceListing | null> {
  const rows = (await db.execute(sql`
    SELECT ${LISTING_COLUMNS}, 1.0 AS score
    FROM shop_products sp JOIN products p ON p.id = sp.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE sp.product_id = ${productId} AND sp.shop_id = ${shopId} AND sp.deleted_at IS NULL
    LIMIT 1
  `)) as unknown as ListingRow[];
  return rows[0] ? toListing(rows[0]) : null;
}

function cleanName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,/()\-₹]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * This shop's own listings that match spoken words: pg_trgm on the product name, its brand and the
 * local-language names (product_local_names: साखर = Sugar), plus a small bonus when a spoken pack size
 * ("1 litre", "500 g") matches the listing's.
 */
export async function searchShopListings(shopId: string, text: string, limit = 5): Promise<VoiceListing[]> {
  const words = cleanName(text);
  const name = words.replace(/[0-9०-९]+/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return [];
  const like = `%${name.replace(/[%_\\]/g, "")}%`;
  // A Hindi/Marathi recogniser writes "अमूल बटर"; the catalogue says "Amul Butter".
  const latin = hasDevanagari(name) ? devanagariToLatin(name) : "";
  // Consonant skeleton: vowels and doubled letters vary most between spellings ("batar" / "butter" → "btr").
  const skeleton = (s: string) => s.replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1").replace(/\s+/g, " ").trim();
  const latinSkeleton = latin ? skeleton(latin) : "";
  const NAME_SKELETON = sql.raw(String.raw`regexp_replace(regexp_replace(lower(coalesce(b.name, '') || ' ' || p.name), '[aeiou]', '', 'g'), '(.)\1+', '\1', 'g')`);
  const rows = (await db.execute(sql`
    WITH cand AS (
      SELECT ${LISTING_COLUMNS},
        GREATEST(
          similarity(lower(p.name), ${name}),
          word_similarity(${name}, lower(p.name)),
          word_similarity(${name}, lower(coalesce(b.name, '') || ' ' || p.name)),
          CASE WHEN pln.search_text IS NOT NULL THEN word_similarity(${name}, pln.search_text) ELSE 0 END,
          CASE WHEN ${latin} <> '' THEN word_similarity(${latin}, lower(coalesce(b.name, '') || ' ' || p.name)) * 0.95 ELSE 0 END,
          CASE WHEN ${latinSkeleton} <> '' THEN word_similarity(${latinSkeleton},
            ${NAME_SKELETON}) * 0.9 ELSE 0 END,
          -- pg_trgm sees no letters in Devanagari on a C-locale database: a plain "contains" for local names.
          CASE WHEN pln.search_text IS NOT NULL AND strpos(lower(pln.search_text), ${name}) > 0 THEN 1.0 ELSE 0 END
        ) AS score
      FROM shop_products sp
      JOIN products p ON p.id = sp.product_id
      LEFT JOIN brands b ON b.id = p.brand_id
      LEFT JOIN product_local_names pln ON pln.product_id = p.id
      WHERE sp.shop_id = ${shopId} AND sp.deleted_at IS NULL
        AND (
          p.name % ${name} OR p.name ILIKE ${like} OR ${name} <% lower(coalesce(b.name, '') || ' ' || p.name)
          OR (pln.search_text IS NOT NULL AND ${name} <% pln.search_text)
          OR (${latin} <> '' AND word_similarity(${latin}, lower(coalesce(b.name, '') || ' ' || p.name)) >= 0.4)
          OR (pln.search_text IS NOT NULL AND strpos(lower(pln.search_text), ${name}) > 0)
          OR (${latinSkeleton} <> '' AND word_similarity(${latinSkeleton},
            ${NAME_SKELETON}) >= 0.5)
        )
    )
    SELECT DISTINCT ON (shop_product_id) * FROM cand ORDER BY shop_product_id, score DESC
  `)) as unknown as ListingRow[];
  const spokenSize = spokenPackMilli(words);
  return rows
    .map((r) => {
      const l = toListing(r);
      if (spokenSize && Number(r.unit_size_milli) > 0 && sameSize(spokenSize, Number(r.unit_size_milli), r.unit)) {
        l.score = Math.min(100, l.score + 15);
      }
      return l;
    })
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit);
}

/** "1 litre" / "500 g" / "2 kg" in the spoken words → { milli, unit } in catalogue units (L, ml, kg, g). */
function spokenPackMilli(words: string): { milli: number; unit: string } | null {
  const m = words.match(/(\d+(?:\.\d+)?)\s*(kg|किलो|g|gm|gram|grams|ग्राम|ग्रॅम|l|ltr|litre|liter|लिटर|लीटर|ml|मिली)\b/u);
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  if (/^(kg|किलो)$/u.test(u)) return { milli: Math.round(n * 1000), unit: "kg" };
  if (/^(g|gm|gram|grams|ग्राम|ग्रॅम)$/u.test(u)) return { milli: Math.round(n * 1000), unit: "g" };
  if (/^(ml|मिली)$/u.test(u)) return { milli: Math.round(n * 1000), unit: "ml" };
  return { milli: Math.round(n * 1000), unit: "L" };
}

function sameSize(spoken: { milli: number; unit: string }, listingMilli: number, listingUnit: string): boolean {
  const toBase = (milli: number, unit: string) => (unit === "kg" || unit === "L" ? milli * 1000 : milli);
  const base = (u: string) => (u === "kg" || u === "g" ? "mass" : u === "L" || u === "ml" ? "volume" : u);
  return base(spoken.unit) === base(listingUnit) && toBase(spoken.milli, spoken.unit) === toBase(listingMilli, listingUnit);
}

/* ------------------------------------------------------------ AI fallback */

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

export const voiceCommandSchema = z.object({
  productName: z.string().nullable().describe("The product as the owner named it, brand and pack size included, in English letters if known; null if none"),
  newPriceRupees: z.number().nullable().describe("The new selling price in rupees, null if the owner did not ask to change the price"),
  discountPercent: z.number().nullable().describe("Percent off for an offer, null if none"),
  discountRupees: z.number().nullable().describe("Rupees off each item for an offer, null if none"),
  offerDays: z.number().nullable().describe("How many days the offer runs, today counting as day 1, if said as a length"),
  untilWeekday: z.enum(WEEKDAY_NAMES).nullable().describe("The weekday the offer runs until, if said that way"),
  buyGetFree: z.boolean().describe("True if the owner asked for a buy-X-get-Y or free-item offer"),
});
type AiCommand = z.infer<typeof voiceCommandSchema>;

const AI_INSTRUCTIONS = `You read one sentence a shop owner in India said (speech-to-text, may be messy) to change a product's price or add a discount offer in their online shop. The sentence can be in Marathi, Hindi, English, Gujarati, Kannada, Tamil, Telugu, Bengali, Urdu, a regional dialect or a mix, in any script.
Extract only what was said: the product name (keep brand and pack size, e.g. "Amul Taaza 1 litre"), the new selling price in rupees, and an offer as percent off or rupees off each item, with how long it runs (days, or until a weekday).
"सूट", "सवलत", "छूट", "कमी", "off", "discount" mean an offer. "किंमत", "भाव", "दाम", "रेट", "price" mean the selling price.
A pack size (1 litre, 500 g) is never a price. Never invent values: use null for anything not said.`;

/* ------------------------------------------------------------ interpret */

export interface InterpretInput {
  text: string;
  shopProductId?: string | null;
  barcode?: string | null;
}

export async function interpretVoiceCommand(shopId: string, actor: VoiceActor, input: InterpretInput, now = new Date()): Promise<VoiceProposal> {
  await assertVoiceAccess(shopId, actor);
  const rule = await getRule("voicePriceAssistant");
  const text = input.text.trim().slice(0, 500);
  const parsed = parseVoiceCommand(text);

  let productText = parsed.productText;
  let newPricePaise = parsed.newPricePaise;
  let offer: SpokenOffer | null = parsed.offer;
  let until: OfferUntil | null = parsed.until;
  let buyGetFree = parsed.buyGetFree;
  let aiUsed = false;

  const productGiven = Boolean(input.shopProductId || input.barcode);
  if ((!parsed.hasChange || (!productText && !productGiven)) && /[\p{L}\p{N}]/u.test(text) && !parsed.confirm) {
    try {
      const ai = await runAi<AiCommand>(
        { feature: "VOICE_COMMAND", userId: actor.id, shopId },
        { text, instructions: AI_INSTRUCTIONS, schema: voiceCommandSchema, maxTokens: 400 },
      );
      const o = ai.output;
      if (o) {
        const before = JSON.stringify([productText, newPricePaise, offer, until, buyGetFree]);
        // When the reader understood no change, its leftover words are not a reliable product name.
        productText = (parsed.hasChange ? productText : null) ?? (o.productName?.trim() || null) ?? productText;
        if (newPricePaise === null && o.newPriceRupees != null && o.newPriceRupees > 0) newPricePaise = Math.round(o.newPriceRupees * 100);
        if (!offer && o.discountPercent != null && o.discountPercent > 0) offer = { type: "PERCENT", percent: Math.round(o.discountPercent) };
        else if (!offer && o.discountRupees != null && o.discountRupees > 0) offer = { type: "FLAT", flatPaise: Math.round(o.discountRupees * 100) };
        if (!until && o.untilWeekday) until = { kind: "weekday", weekday: WEEKDAY_NAMES.indexOf(o.untilWeekday) };
        else if (!until && o.offerDays != null && o.offerDays >= 1) until = { kind: "days", days: Math.min(90, Math.round(o.offerDays)) };
        buyGetFree = buyGetFree || o.buyGetFree;
        aiUsed = JSON.stringify([productText, newPricePaise, offer, until, buyGetFree]) !== before;
      }
    } catch (error) {
      // AI off, over its limit or failing is not an error here: the owner rephrases or types.
      if (!(error instanceof AiUnavailableError) && !(error instanceof AppError && error.code === "RATE_LIMITED")) throw error;
    }
  }

  const issues: VoiceIssue[] = [];

  // Which listing.
  let candidates: VoiceListing[] = [];
  let chosen: VoiceListing | null = null;
  if (input.shopProductId) {
    chosen = await listingById(shopId, input.shopProductId);
    if (!chosen) throw notFound("Product");
    candidates = [chosen];
  } else if (input.barcode) {
    const found = await findProductByBarcode(shopId, input.barcode);
    if (!found) throw validationFailed("Enter the barcode number (at least 6 digits).");
    if (found.match?.listed) chosen = await listingByProduct(shopId, found.match.productId);
    if (chosen) candidates = [chosen];
    else issues.push(issue("NOT_LISTED", true, found.match?.name ?? found.code));
  } else if (productText) {
    candidates = await searchShopListings(shopId, productText);
    const [first, second] = candidates;
    if (first && first.score >= rule.autoPickScore && (!second || first.score - second.score >= 10)) chosen = first;
    if (!candidates.length) issues.push(issue("PRODUCT_NOT_FOUND", true, productText));
    else if (!chosen) issues.push(issue("CHOOSE_PRODUCT", true));
  } else {
    issues.push(issue("NO_PRODUCT", true));
  }

  // What changes.
  if (!newPricePaise && !offer) issues.push(issue(buyGetFree ? "BUY_GET_FREE" : "NO_CHANGE", true));
  else if (buyGetFree) issues.push(issue("BUY_GET_FREE", false));

  if (newPricePaise !== null && (newPricePaise <= 0 || newPricePaise > MAX_PRICE_PAISE)) issues.push(issue("PRICE_RANGE", true));
  if (chosen && newPricePaise !== null && chosen.mrpPaise != null && newPricePaise > chosen.mrpPaise) {
    issues.push(issue("ABOVE_MRP", true, formatPaiseCompact(chosen.mrpPaise)));
  }
  if (chosen && newPricePaise !== null && chosen.pricePaise != null && newPricePaise < chosen.pricePaise * (1 - rule.bigDropWarnPercent / 100)) {
    issues.push(issue("BIG_DROP", false, formatPaiseCompact(chosen.pricePaise)));
  }
  // No MRP means no ceiling, so a slip ("9000" for "90") is caught here instead (owner, 23-Nov).
  if (chosen && newPricePaise !== null && chosen.pricePaise != null && newPricePaise > chosen.pricePaise * rule.bigRiseWarnTimes) {
    issues.push(issue("BIG_RISE", false, formatPaiseCompact(chosen.pricePaise)));
  }

  const base = newPricePaise ?? chosen?.pricePaise ?? null;
  let proposedOffer: ProposedOffer | null = null;
  let finalPricePaise = base;
  if (offer) {
    const endsAt = offerEndsAt(until, now, rule.defaultOfferDays);
    proposedOffer = {
      discountType: offer.type,
      percent: offer.type === "PERCENT" ? offer.percent : null,
      flatPaise: offer.type === "FLAT" ? offer.flatPaise : null,
      startsAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
    };
    // An offer on a product with no selling price does nothing for customers (owner, 23-Nov): say a price with it.
    if (chosen && base === null) issues.push(issue("NO_PRICE_FOR_OFFER", true));
    if (offer.type === "PERCENT" && (offer.percent < 1 || offer.percent > 90)) issues.push(issue("PERCENT_RANGE", true));
    if (offer.type === "FLAT" && base !== null && offer.flatPaise >= base) issues.push(issue("FLAT_TOO_BIG", true, formatPaiseCompact(base)));
    if (base !== null) {
      finalPricePaise = offer.type === "PERCENT" ? Math.round((base * (100 - offer.percent)) / 100) : Math.max(0, base - offer.flatPaise);
    }
  }

  const proposal: VoiceProposal = {
    text,
    productText,
    candidates,
    chosen,
    newPricePaise,
    offer: proposedOffer,
    finalPricePaise,
    issues,
    readBack: { en: "", hi: "", mr: "" },
    aiUsed,
    canPublish: Boolean(chosen) && !issues.some((i) => i.blocking) && (newPricePaise !== null || proposedOffer !== null),
  };
  proposal.readBack = readBackOf(proposal);
  return proposal;
}

/* ------------------------------------------------------------ apply */

export const applySchema = z.object({
  shopProductId: z.string().uuid(),
  newPricePaise: z.number().int().positive().max(MAX_PRICE_PAISE).nullable(),
  offer: z
    .object({
      discountType: z.enum(["PERCENT", "FLAT"]),
      percent: z.number().int().min(1).max(90).nullable(),
      flatPaise: z.number().int().min(1).max(10_000_000).nullable(),
      endsAt: z.coerce.date(),
    })
    .nullable(),
  /** The price the owner saw when confirming: a change since then is refused (no surprise overwrite). */
  expectedPricePaise: z.number().int().nullable(),
  text: z.string().max(500).optional(),
});
export type ApplyInput = z.infer<typeof applySchema>;

export interface ApplyResult {
  shopProductId: string;
  label: string;
  pricePaise: number | null;
  offerId: string | null;
  offerEndsAt: string | null;
  summary: Text3;
}

export async function applyVoiceCommand(shopId: string, actor: VoiceActor, input: ApplyInput, now = new Date()): Promise<ApplyResult> {
  await assertVoiceAccess(shopId, actor);
  if (input.newPricePaise === null && !input.offer) throw validationFailed("Say a new price or an offer first.");
  const listing = await listingById(shopId, input.shopProductId);
  if (!listing) throw notFound("Product");
  if ((listing.pricePaise ?? null) !== input.expectedPricePaise) {
    throw conflict(
      `The price of ${listing.label} changed since you checked it — it is now ${listing.pricePaise == null ? "not set" : formatPaiseCompact(listing.pricePaise)}. Please say it again.`,
      { pricePaise: listing.pricePaise },
    );
  }
  // Every check before the first write, so a refused offer never leaves a half-done change.
  if (input.newPricePaise !== null && listing.mrpPaise != null && input.newPricePaise > listing.mrpPaise) {
    throw validationFailed(`The price can't be more than the MRP (${formatPaiseCompact(listing.mrpPaise)}).`);
  }
  const base = input.newPricePaise ?? listing.pricePaise;
  if (input.offer) {
    const o = input.offer;
    if (base === null) throw validationFailed("This product has no selling price yet. Say the price with the offer.");
    if (o.discountType === "PERCENT" && !o.percent) throw validationFailed("Percent off must be between 1 and 90.");
    if (o.discountType === "FLAT" && !o.flatPaise) throw validationFailed("Enter the amount off each item.");
    if (o.discountType === "FLAT" && base !== null && o.flatPaise! >= base) throw validationFailed("The rupees off must be less than the price.");
    if (!(o.endsAt > now)) throw validationFailed("The offer must end after now.");
    if (o.endsAt.getTime() - now.getTime() > 92 * 86_400_000) throw validationFailed("A voice offer can run for at most 90 days.");
  }

  const owner = { id: actor.id, role: "SHOP_OWNER" as const };
  if (input.newPricePaise !== null) {
    await setShopPrices(shopId, [{ shopProductId: listing.shopProductId, pricePaise: input.newPricePaise }], owner);
  }
  let offerId: string | null = null;
  if (input.offer) {
    const o = input.offer;
    const what = o.discountType === "PERCENT" ? `${o.percent}% off` : `${formatPaiseCompact(o.flatPaise!)} off`;
    const row = await saveShopOffer(
      shopId,
      {
        title: `${what} · ${listing.name}`.slice(0, 80),
        targetType: "PRODUCT",
        shopProductId: listing.shopProductId,
        categoryId: null,
        discountType: o.discountType,
        percent: o.discountType === "PERCENT" ? o.percent : null,
        flatPaise: o.discountType === "FLAT" ? o.flatPaise : null,
        startsAt: now,
        endsAt: o.endsAt,
        active: true,
      },
      owner,
    );
    offerId = row.id;
  }

  const after = await listingById(shopId, listing.shopProductId);
  const done: VoiceProposal = {
    text: input.text ?? "",
    productText: null,
    candidates: [],
    // The listing as it was before the change, so the message reads "₹56 → ₹58", not "₹58 → ₹58".
    chosen: listing,
    newPricePaise: input.newPricePaise,
    offer: input.offer
      ? { discountType: input.offer.discountType, percent: input.offer.percent, flatPaise: input.offer.flatPaise, startsAt: now.toISOString(), endsAt: input.offer.endsAt.toISOString() }
      : null,
    finalPricePaise: null,
    issues: [],
    readBack: { en: "", hi: "", mr: "" },
    aiUsed: false,
    canPublish: false,
  };
  return {
    shopProductId: listing.shopProductId,
    label: listing.label,
    pricePaise: after?.pricePaise ?? null,
    offerId,
    offerEndsAt: input.offer ? input.offer.endsAt.toISOString() : null,
    summary: publishedText(done),
  };
}

/* ------------------------------------------------------------ words */

function istDate(iso: string, lang: VoiceLangKey): string {
  const locale = lang === "en" ? "en-IN" : lang === "hi" ? "hi-IN" : "mr-IN";
  return new Date(iso).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

function offerWords(o: ProposedOffer, lang: VoiceLangKey): string {
  const amount = o.discountType === "PERCENT" ? `${o.percent}%` : formatPaiseCompact(o.flatPaise ?? 0);
  const until = istDate(o.endsAt, lang);
  if (lang === "hi") return `${amount} छूट, ${until} तक`;
  if (lang === "mr") return `${amount} सूट, ${until} पर्यंत`;
  return `${amount} off until ${until}`;
}

function readBackOf(p: VoiceProposal): Text3 {
  const out = {} as Text3;
  for (const lang of ["en", "hi", "mr"] as const) {
    const parts: string[] = [];
    const name = p.chosen?.label ?? p.productText ?? "";
    if (name) parts.push(name);
    if (p.newPricePaise !== null) {
      const from = p.chosen?.pricePaise != null ? `${formatPaiseCompact(p.chosen.pricePaise)} → ` : "";
      const to = formatPaiseCompact(p.newPricePaise);
      parts.push(lang === "hi" ? `कीमत ${from}${to}` : lang === "mr" ? `किंमत ${from}${to}` : `price ${from}${to}`);
    }
    if (p.offer) parts.push(offerWords(p.offer, lang));
    if (p.offer && p.finalPricePaise !== null) {
      const f = formatPaiseCompact(p.finalPricePaise);
      parts.push(lang === "hi" ? `ग्राहक ${f} देंगे` : lang === "mr" ? `ग्राहक ${f} देतील` : `customers pay ${f}`);
    }
    const ask = p.canPublish ? (lang === "hi" ? "सही है तो “हाँ” कहें।" : lang === "mr" ? "बरोबर असल्यास “हो” म्हणा." : "Say “yes” to publish.") : "";
    out[lang] = [parts.join(" · "), ask].filter(Boolean).join(". ");
  }
  return out;
}

function publishedText(p: VoiceProposal): Text3 {
  const body = readBackOf({ ...p, canPublish: false });
  return {
    en: `Published: ${body.en}`,
    hi: `प्रकाशित: ${body.hi}`,
    mr: `प्रसिद्ध केले: ${body.mr}`,
  };
}

function issue(code: IssueCode, blocking: boolean, value = ""): VoiceIssue {
  const m: Record<IssueCode, Text3> = {
    NO_CHANGE: {
      en: "I didn't hear a new price or an offer. Say, for example, “price 58 rupees” or “10 percent off till Sunday”.",
      hi: "नई कीमत या ऑफ़र सुनाई नहीं दिया। जैसे कहें: “कीमत 58 रुपये” या “10 प्रतिशत छूट रविवार तक”।",
      mr: "नवीन किंमत किंवा ऑफर ऐकू आली नाही. उदा. “किंमत 58 रुपये” किंवा “10 टक्के सूट रविवार पर्यंत” म्हणा.",
    },
    NO_PRODUCT: {
      en: "Which product? Say its name or scan its barcode.",
      hi: "कौन सा उत्पाद? उसका नाम बोलें या बारकोड स्कैन करें।",
      mr: "कोणते उत्पादन? त्याचे नाव सांगा किंवा बारकोड स्कॅन करा.",
    },
    PRODUCT_NOT_FOUND: {
      en: `“${value}” is not among your shop's products. Try another name or scan the barcode.`,
      hi: `“${value}” आपकी दुकान के उत्पादों में नहीं मिला। दूसरा नाम बोलें या बारकोड स्कैन करें।`,
      mr: `“${value}” तुमच्या दुकानाच्या उत्पादनांमध्ये सापडले नाही. दुसरे नाव सांगा किंवा बारकोड स्कॅन करा.`,
    },
    CHOOSE_PRODUCT: {
      en: "Which of these did you mean? Tap one.",
      hi: "इनमें से कौन सा? एक पर टैप करें।",
      mr: "यापैकी कोणते? एकावर टॅप करा.",
    },
    NOT_LISTED: {
      en: `${value} is not in your shop yet. Add it first (Add product), then change its price.`,
      hi: `${value} अभी आपकी दुकान में नहीं है। पहले उसे जोड़ें, फिर कीमत बदलें।`,
      mr: `${value} अजून तुमच्या दुकानात नाही. आधी ते जोडा, मग किंमत बदला.`,
    },
    ABOVE_MRP: {
      en: `The price can't be more than the MRP (${value}).`,
      hi: `कीमत MRP (${value}) से ज़्यादा नहीं हो सकती।`,
      mr: `किंमत MRP (${value}) पेक्षा जास्त असू शकत नाही.`,
    },
    BIG_RISE: {
      en: `That is much higher than today's price (${value}). Please check before saying yes.`,
      hi: `यह आज की कीमत (${value}) से बहुत ज़्यादा है। “हाँ” कहने से पहले जाँच लें।`,
      mr: `हे आजच्या किमतीपेक्षा (${value}) खूप जास्त आहे. “हो” म्हणण्याआधी तपासा.`,
    },
    NO_PRICE_FOR_OFFER: {
      en: "This product has no selling price yet. Say the price with the offer, for example “price 40 rupees and 10 percent off”.",
      hi: "इस उत्पाद की अभी कोई बिक्री कीमत नहीं है। ऑफ़र के साथ कीमत भी बोलें, जैसे “कीमत 40 रुपये और 10 प्रतिशत छूट”।",
      mr: "या उत्पादनाची अजून विक्री किंमत नाही. ऑफरसोबत किंमतही सांगा, उदा. “किंमत 40 रुपये आणि 10 टक्के सूट”.",
    },
    BIG_DROP: {
      en: `That is much lower than today's price (${value}). Please check before saying yes.`,
      hi: `यह आज की कीमत (${value}) से बहुत कम है। “हाँ” कहने से पहले जाँच लें।`,
      mr: `हे आजच्या किमतीपेक्षा (${value}) खूप कमी आहे. “हो” म्हणण्याआधी तपासा.`,
    },
    PERCENT_RANGE: {
      en: "Percent off must be between 1 and 90.",
      hi: "छूट 1 से 90 प्रतिशत के बीच होनी चाहिए।",
      mr: "सूट 1 ते 90 टक्क्यांच्या दरम्यान असावी.",
    },
    FLAT_TOO_BIG: {
      en: `The rupees off must be less than the price (${value}).`,
      hi: `छूट की रकम कीमत (${value}) से कम होनी चाहिए।`,
      mr: `सवलतीची रक्कम किमतीपेक्षा (${value}) कमी असावी.`,
    },
    BUY_GET_FREE: {
      en: "“Buy X get Y free” offers are not available yet — say percent or rupees off instead.",
      hi: "“X खरीदें Y मुफ़्त” ऑफ़र अभी उपलब्ध नहीं है — प्रतिशत या रुपये की छूट बोलें।",
      mr: "“X घ्या Y मोफत” ऑफर अजून उपलब्ध नाही — टक्के किंवा रुपयांची सूट सांगा.",
    },
    PRICE_RANGE: {
      en: "A price must be more than ₹0 and at most ₹10,00,000.",
      hi: "कीमत ₹0 से ज़्यादा और ₹10,00,000 तक होनी चाहिए।",
      mr: "किंमत ₹0 पेक्षा जास्त आणि ₹10,00,000 पर्यंत असावी.",
    },
  };
  return { code, blocking, message: m[code] };
}

/** For the page: is the assistant on for this shop, and may this user use it? */
export async function voiceAssistantAccess(shopId: string, actor: VoiceActor): Promise<"OK" | "OFF" | "NOT_OWNER"> {
  try {
    await assertVoiceAccess(shopId, actor);
    return "OK";
  } catch (error) {
    if (error instanceof AppError && error.status === 403) return "NOT_OWNER";
    return "OFF";
  }
}
