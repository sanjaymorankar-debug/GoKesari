/**
 * Photo shopping list → lines (docs/smart-shopping-2026-11, Feature 1 §1–2).
 *
 * The customer's photos (one list, 1–N pages; the browser has already
 * compressed, oriented and cropped them) are checked, re-encoded privately,
 * read by the AI provider (handwritten or printed; Marathi, Hindi, English,
 * Gujarati, Kannada, Tamil, Telugu, Bengali, Urdu or mixed), and each line is
 * given a quantity (regional words and units normalised) and matched to the
 * master catalogue. Nothing is a wishlist yet: the customer reviews the lines
 * and saves them (wishlist.ts).
 *
 * A photo that cannot be read is recorded as UNREADABLE with a reason the
 * customer is shown — never an empty wishlist.
 */
import { and, eq, isNull, lte } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { type BaseUnit, parseQuantity, unitFromWord } from "@/lib/qty-words";
import { LANGUAGE_NAMES, type ScannedLine } from "@/lib/smart-list";
import { runAi } from "@/server/ai/provider";
import { db } from "@/server/db";
import { shoppingListScanPages, shoppingListScans } from "@/server/db/schema";
import { discardBlobs, putBlob, readBlob, scheduleOrphanSweep } from "@/server/media/blob-store";
import { requireFeature } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { matchProducts } from "./match";

export const SCAN_FLAG = "smart_list_scan_enabled" as const;

const conf = z.number().min(0).max(100);

export const listReadSchema = z.object({
  readable: z.boolean(),
  /** BLURRY | DARK | NOT_A_LIST | EMPTY when not readable. */
  unreadable_reason: z.string().nullable(),
  handwritten: z.boolean(),
  /** ISO 639-1 codes of the languages written on the list. */
  languages: z.array(z.string()),
  is_bill: z.boolean(),
  lines: z.array(
    z.object({
      /** The line exactly as written. */
      raw: z.string(),
      language: z.string(),
      /** The item in plain English ("Sugar"). */
      item_en: z.string(),
      /** The item in the customer's app language (script of that language). */
      item_local: z.string(),
      brand: z.string().nullable(),
      quantity: z.number().nullable(),
      /** kg, g, L, ml, piece, dozen, packet, box, metre — as written, or null. */
      unit: z.string().nullable(),
      read_confidence: conf,
    }),
  ),
});
export type ListRead = z.infer<typeof listReadSchema>;

function instructions(targetLang: string): string {
  return `You read photographed Indian shopping lists (kirana / grocery lists) — handwritten or printed, on paper, notebooks or diaries — in Marathi, Hindi, English, Gujarati, Kannada, Tamil, Telugu, Bengali, Urdu, or a mix (e.g. Marathi in Devanagari with English words). Several images are pages of ONE list.
For every item line return:
- raw: the line exactly as written (original script).
- language: ISO 639-1 code of the line (mr, hi, en, gu, kn, ta, te, bn, ur).
- item_en: the item's common English grocery name, singular, no quantity (साखर → Sugar, तूप → Ghee, कांदा → Onion, तांदूळ → Rice, गहू → Wheat, तेल → Cooking oil, दूध → Milk, साबण → Soap, अंडी → Eggs, पोहे → Poha, डाळ → Dal). Keep brand names as written (Parle-G, Amul).
- item_local: the item's name in ${LANGUAGE_NAMES[targetLang] ?? "English"}, in that language's script.
- brand: brand if written, else null.
- quantity and unit: as written, regional digits converted (२ → 2). Local words: अर्धा/आधा = 0.5, पाव = 0.25 kg, दीड/डेढ़ = 1.5, अडीच/ढाई = 2.5, सव्वा = 1.25, पावणे X = X − 0.25, डझन/दर्जन = dozen, नग = piece, पाकीट/पैकेट = packet. unit one of kg, g, L, ml, piece, dozen, packet, box, metre, or null when none is written.
- read_confidence 0–100: how sure you are you read this line correctly (handwriting clarity).
Rules: skip crossed-out lines, headings, dates and totals. If the image is a shop bill or invoice, set is_bill true and list only the PRODUCT NAMES and their quantities — never treat a price, amount or bill total as a quantity. If the photo is too blurry or too dark to read, or is not a list, set readable false with unreadable_reason BLURRY, DARK, NOT_A_LIST or EMPTY and return no lines. Never invent items that are not written.`;
}

const ACCEPTED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/** Checks and re-encodes one page: oriented, at most 2000 px, webp. Throws a 422 the customer can act on. */
async function preparePage(bytes: Buffer, maxBytes: number): Promise<{ webp: Buffer; jpeg: Buffer }> {
  if (bytes.length === 0) throw validationFailed("One of the photos is empty. Take it again.");
  if (bytes.length > maxBytes) throw validationFailed(`Each photo can be at most ${Math.round(maxBytes / 1_048_576)} MB.`);
  try {
    const base = sharp(bytes, { limitInputPixels: 50_000_000, failOn: "error" }).rotate().resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true });
    const [webp, jpeg] = await Promise.all([base.clone().webp({ quality: 80 }).toBuffer(), base.clone().jpeg({ quality: 85 }).toBuffer()]);
    return { webp, jpeg };
  } catch {
    throw validationFailed("This photo could not be opened. Take it again or choose a JPG or PNG photo.", { reason: "PHOTO_UNREADABLE" });
  }
}

function normaliseUnit(unit: string | null): string | null {
  if (!unit) return null;
  const u = unit.trim().toLowerCase();
  if (u === "packet" || u === "packets") return "packet";
  return unitFromWord(u) ? u : null;
}

/** Quantity of a line: the written words first (they are exact), else the AI's number + unit, else 1 piece. */
export function quantityOf(line: Pick<ListRead["lines"][number], "raw" | "quantity" | "unit">): { amount: number; unit: BaseUnit; display: string } {
  const fromText = parseQuantity(line.raw);
  if (fromText) return fromText;
  const unit = normaliseUnit(line.unit);
  if (line.quantity != null && line.quantity > 0) {
    const parsed = parseQuantity(`${line.quantity} ${unit ?? ""}`);
    if (parsed) return parsed;
  }
  return { amount: 1, unit: "piece", display: "1 piece" };
}

export interface ScanResult {
  scanId: string;
  status: "READ" | "UNREADABLE";
  unreadableReason: string | null;
  languages: string[];
  handwritten: boolean | null;
  isBill: boolean;
  lines: ScannedLine[];
}

/** Reads a list photo. `targetLang` is the customer's app language (en, hi, mr). */
export async function scanShoppingList(userId: string, files: { bytes: Buffer; contentType: string }[], targetLang: string): Promise<ScanResult> {
  await requireFeature(SCAN_FLAG);
  const rule = await getRule("smartShopping");
  if (files.length === 0) throw validationFailed("Take or choose a photo of your list.");
  if (files.length > rule.maxPagesPerScan) throw validationFailed(`At most ${rule.maxPagesPerScan} pages per list.`);
  for (const f of files) {
    if (f.contentType && !ACCEPTED.has(f.contentType.toLowerCase())) throw validationFailed("Upload a JPG, PNG, WebP or HEIC photo.");
  }

  const pages: { webp: Buffer; jpeg: Buffer }[] = [];
  for (const f of files) pages.push(await preparePage(f.bytes, rule.maxUploadMb * 1_048_576));

  // AI first (no transaction open while it runs), then store photos + result together.
  const read = await runAi({ feature: "LIST_SCAN", userId }, {
    images: pages.map((p) => ({ bytes: p.jpeg, contentType: "image/jpeg" })),
    instructions: instructions(targetLang),
    schema: listReadSchema,
    maxTokens: 8_000,
  });
  const out = read.output;

  let lines: ScannedLine[] = [];
  let status: ScanResult["status"] = "UNREADABLE";
  let reason: string | null = "EMPTY";
  if (out && out.readable) {
    const items = out.lines.filter((l) => l.item_en.trim() || l.raw.trim()).slice(0, 100);
    lines = await Promise.all(
      items.map(async (l) => {
        const q = quantityOf(l);
        const candidates = await matchProducts({ nameEn: l.item_en, nameLocal: l.item_local, raw: l.raw, brand: l.brand });
        const best = candidates[0] ?? null;
        return {
          raw: l.raw,
          language: l.language,
          nameEn: l.item_en.trim() || l.raw.trim(),
          nameLocal: l.item_local.trim(),
          brand: l.brand,
          quantityAmount: q.amount,
          quantityUnit: q.unit,
          quantityDisplay: q.display,
          readConfidence: Math.round(l.read_confidence),
          productId: best?.productId ?? null,
          // The weaker of "read it right" and "matched it right".
          matchConfidence: best ? Math.min(Math.round(l.read_confidence), best.score) : 0,
          candidates,
        } satisfies ScannedLine;
      }),
    );
    if (lines.length > 0) {
      status = "READ";
      reason = null;
    }
  } else if (out) {
    reason = ["BLURRY", "DARK", "NOT_A_LIST", "EMPTY"].includes(out.unreadable_reason ?? "") ? out.unreadable_reason : "BLURRY";
  } else {
    reason = "NOT_A_LIST";
  }

  const blobs = await Promise.all(pages.map((p) => putBlob(p.webp, "webp")));
  let scanId: string;
  try {
    scanId = await db.transaction(async (tx) => {
      const [scan] = await tx
        .insert(shoppingListScans)
        .values({
          userId,
          status,
          languages: out?.languages ?? [],
          handwritten: out?.handwritten ?? null,
          unreadableReason: reason,
          pageCount: pages.length,
          lineCount: lines.length,
          lines: JSON.stringify(lines),
          photosExpireAt: new Date(Date.now() + rule.photoRetentionDays * 86_400_000),
        })
        .returning({ id: shoppingListScans.id });
      await tx.insert(shoppingListScanPages).values(
        blobs.map((b, i) => ({
          scanId: scan.id,
          pageNo: i + 1,
          contentType: "image/webp",
          sizeBytes: pages[i].webp.length,
          storage: b.storage,
          storageKey: b.storageKey,
          data: b.data,
        })),
      );
      return scan.id;
    });
  } catch (e) {
    await discardBlobs(blobs);
    throw e;
  }

  return { scanId, status, unreadableReason: reason, languages: out?.languages ?? [], handwritten: out?.handwritten ?? null, isBill: out?.is_bill ?? false, lines };
}

/** A scan's lines and page count, for its owner. */
export async function getScan(userId: string, scanId: string) {
  const scan = await db.query.shoppingListScans.findFirst({ where: and(eq(shoppingListScans.id, scanId), eq(shoppingListScans.userId, userId)) });
  return scan ?? null;
}

/** A page photo of the customer's own scan (null once deleted by retention). */
export async function readScanPage(userId: string | null, scanId: string, pageNo: number, opts: { admin?: boolean } = {}): Promise<Buffer | null> {
  const scan = await db.query.shoppingListScans.findFirst({ where: eq(shoppingListScans.id, scanId) });
  if (!scan || (!opts.admin && scan.userId !== userId) || scan.photosDeletedAt) return null;
  const page = await db.query.shoppingListScanPages.findFirst({
    where: and(eq(shoppingListScanPages.scanId, scanId), eq(shoppingListScanPages.pageNo, pageNo)),
  });
  if (!page) return null;
  return readBlob({ storage: page.storage, storageKey: page.storageKey, data: page.data });
}

/** Deletes list photos past their retention date (rule smartShopping.photoRetentionDays). Returns how many scans. */
export async function sweepExpiredScanPhotos(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: shoppingListScans.id })
    .from(shoppingListScans)
    .where(and(lte(shoppingListScans.photosExpireAt, now), isNull(shoppingListScans.photosDeletedAt)))
    .limit(500);
  let done = 0;
  for (const { id } of due) {
    const keys = await db.transaction(async (tx) => {
      const rows = await tx.delete(shoppingListScanPages).where(eq(shoppingListScanPages.scanId, id)).returning({ key: shoppingListScanPages.storageKey });
      await tx.update(shoppingListScans).set({ photosDeletedAt: now }).where(eq(shoppingListScans.id, id));
      return rows.map((r) => r.key);
    });
    scheduleOrphanSweep(keys);
    done++;
  }
  return done;
}
