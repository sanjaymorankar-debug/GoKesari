/**
 * Product tracker for the smart-shopping brief (owner, 22-Nov-2026 18.23 IST): every feature and sub-feature
 * with status (Not started / In progress / Done / Blocked + reason), environment (Local / TEST / PROD) and
 * the IST date/time of its last change. Statuses are edited in STATUS below as work moves.
 *
 *   npx tsx scripts/qa/smart-shopping-tracker.ts <out.xlsx> [<out2.xlsx> …]
 */
import ExcelJS from "exceljs";

type Status = "Not started" | "In progress" | "Done" | "Blocked";
type Row = { id: string; feature: string; sub: string; status: Status; reason?: string; local: string; test: string; prod: string; when: string; where: string };

const NOW = process.env.TRACKER_TIME ?? "22-Nov-2026 19.50 IST";
const L = "Built, tests pass";
const PENDING = "Pending deploy";
const AI = "Blocked: ANTHROPIC_API_KEY not set on this site";
const META = "Blocked: Meta WhatsApp keys + approved templates";
const TEST_STATE = process.env.TRACKER_TEST ?? PENDING;
const PROD_STATE = process.env.TRACKER_PROD ?? PENDING;
const F4_TEST = process.env.TRACKER_F4_TEST ?? "In staging queue (PR #491)";
const F4_PROD = process.env.TRACKER_F4_PROD ?? "Not deployed";

const rows: Row[] = [
  // Shared
  { id: "SS-00.1", feature: "Shared", sub: "AI provider abstraction (swap provider/model in admin Rules), per-user daily limit, cost + latency log", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "src/server/ai/*, ai_usage_log (0167)" },
  { id: "SS-00.2", feature: "Shared", sub: "Quantity/unit reader: regional digits, Marathi/Hindi number words, अर्धा/पाव/दीड/डझन/नग/पाकीट", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "src/lib/qty-words.ts" },
  { id: "SS-00.3", feature: "Shared", sub: "Keys in env only (ANTHROPIC_API_KEY, META_WA_*); no key in code", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "src/lib/env.ts" },
  // Feature 1
  { id: "F1.1", feature: "F1 Photo list → wishlist → compare", sub: "Scan my list tile (home Tile Board + discovery home + cart)", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "ScanListTile" },
  { id: "F1.2", feature: "F1", sub: "Camera / gallery, multiple pages, compress, orientation, auto-crop, rotate/retake", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "src/lib/smart-list-image.ts, /wishlist/scan" },
  { id: "F1.3", feature: "F1", sub: "AI read: handwritten + printed; mr, hi, en, gu, kn, ta, te, bn, ur, mixed; language detected", status: "Blocked", reason: "Code done; needs ANTHROPIC_API_KEY on TEST/PROD", local: "Built (AI mocked in tests)", test: AI, prod: AI, when: NOW, where: "smart-list/scan.ts" },
  { id: "F1.4", feature: "F1", sub: "Item, qty, unit per line; local units normalised", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "qty-words + scan.ts" },
  { id: "F1.5", feature: "F1", sub: "English + app-language name, original text kept", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "scan.ts" },
  { id: "F1.6", feature: "F1", sub: "Catalogue match: fuzzy + local synonyms + spelling; confidence", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "smart-list/match.ts" },
  { id: "F1.7", feature: "F1", sub: "Unreadable (blurry/dark/not a list) → clear message + retake; never empty silently", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "scan.ts, scan-capture.tsx" },
  { id: "F1.8", feature: "F1", sub: "Review screen: editable rows, low-confidence highlight, change product, edit qty/unit, delete, add", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "wishlist-editor.tsx" },
  { id: "F1.9", feature: "F1", sub: "Save wishlist on account with image reference; reuse / re-order", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "smart_wishlists (0167)" },
  { id: "F1.10", feature: "F1", sub: "Nearby shops within admin radius (3 km)", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "compare.ts" },
  { id: "F1.11", feature: "F1", sub: "Per shop: distance, rating, X of Y, missing, total, delivery options with ETA + fee", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "compare.ts, compare-view.tsx" },
  { id: "F1.12", feature: "F1", sub: "Available only with enough stock; pack-size conversion with difference shown", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "qty-words planPacks" },
  { id: "F1.13", feature: "F1", sub: "Loose items with empty price: 'Price on confirmation', excluded from total", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "compare.ts" },
  { id: "F1.14", feature: "F1", sub: "Sort lowest total / nearest / most items; per-item breakdown; items × shops grid", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "compare-view.tsx" },
  { id: "F1.15", feature: "F1", sub: "Choose shop → normal cart → existing checkout/payment/fulfilment", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "wishlist.ts orderFromShop" },
  { id: "F1.16", feature: "F1", sub: "Re-check stock/price; show changes before payment", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "orderFromShop + cart validation" },
  { id: "F1.17", feature: "F1", sub: "Missing items stay 'not ordered'; order them from another shop later", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "/wishlist/<id>/compare?pending=1" },
  { id: "F1.18", feature: "F1", sub: "Private photos, auto-delete after admin-set days (30)", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "cron smart-list-photo-retention" },
  // Feature 2
  { id: "F2.1", feature: "F2 Shop: photo + voice → product", sub: "'Add product by photo' tile; 1–4 photos", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "/shop/photo-listing" },
  { id: "F2.2", feature: "F2", sub: "Price / stock / unit by voice (mr/hi/en) or typing; number words; read-back to confirm", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "price-stock-parse.ts, voice-input.ts" },
  { id: "F2.3", feature: "F2", sub: "Units: piece/nug, kg, g, litre, ml, dozen, packet, box, metre, custom", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "price-stock-parse.ts" },
  { id: "F2.4", feature: "F2", sub: "AI extraction: brand, name, variant, pack, MRP, category, barcode, FSSAI, specs, veg mark, maker, expiry", status: "Blocked", reason: "Code done; needs ANTHROPIC_API_KEY on TEST/PROD", local: "Built (AI mocked in tests)", test: AI, prod: AI, when: NOW, where: "shop-photo-listing.ts" },
  { id: "F2.5", feature: "F2", sub: "Description + spec list in English and local language", status: "Blocked", reason: "AI key", local: "Built (AI mocked)", test: AI, prod: AI, when: NOW, where: "shop-photo-listing.ts" },
  { id: "F2.6", feature: "F2", sub: "Warn when selling price > MRP on pack", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "publish → 409 PRICE_ABOVE_MRP" },
  { id: "F2.7", feature: "F2", sub: "Match master by barcode, then brand+name+pack; else new product → admin pending/duplicate check", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "findMasterMatch, createProductForShop" },
  { id: "F2.8", feature: "F2", sub: "Shop price (MRP change this shop only), stock, unit", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "updateShopProduct" },
  { id: "F2.9", feature: "F2", sub: "Review screen, low-confidence highlight, Publish to my shop", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "shop-photo-listing.tsx" },
  { id: "F2.10", feature: "F2", sub: "Image resize/compress as product image (background removal optional: not done)", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "processProductPhoto" },
  { id: "F2.11", feature: "F2", sub: "Bulk mode: several products, review all at end", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "shop-photo-listing.tsx" },
  // Feature 3
  { id: "F3.1", feature: "F3 Orders on shop WhatsApp", sub: "Meta WhatsApp Cloud API provider with templates", status: "Blocked", reason: "Meta Business verification, number, permanent token, approved templates", local: "Built (Meta mocked in tests)", test: META, prod: META, when: NOW, where: "whatsapp-meta.ts" },
  { id: "F3.2", feature: "F3", sub: "Shop opt-in, prefilled number, up to 3 staff numbers, test message on save", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "/shop/settings/whatsapp" },
  { id: "F3.3", feature: "F3", sub: "On order placed: order ID, IST time, customer, items, total, payment, fulfilment, area/distance, link", status: "Done", local: L, test: META, prod: META, when: NOW, where: "queueShopWhatsAppForEvent" },
  { id: "F3.4", feature: "F3", sub: "Accept / Reject buttons → same as app; customer notified; signed webhook", status: "Done", local: L, test: META, prod: META, when: NOW, where: "/api/webhooks/whatsapp" },
  { id: "F3.5", feature: "F3", sub: "First action wins (app or any number); later taps told who and when (IST); never twice", status: "Done", local: L, test: META, prod: META, when: NOW, where: "webhook.ts + order row lock" },
  { id: "F3.6", feature: "F3", sub: "Follow-ups: customer cancelled, partner assigned, delivered via OTP", status: "Done", local: L, test: META, prod: META, when: NOW, where: "event hooks" },
  { id: "F3.7", feature: "F3", sub: "Fallback in-app + SMS + e-mail on failure; message log for admin/operator", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "/admin/whatsapp-messages" },
  { id: "F3.8", feature: "F3", sub: "TEST sends only to +91 91751 93009; PROD to real numbers", status: "Done", local: L, test: "Needs WHATSAPP_TEST_RECIPIENT set on TEST", prod: PROD_STATE, when: NOW, where: "WHATSAPP_TEST_RECIPIENT" },
  { id: "F3.9", feature: "F3", sub: "Feature flag; pending Meta items listed", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "FEATURE3_WHATSAPP_ORDERS.md" },
  // Feature 4 — change price or offer by voice (owner request 23-Nov-2026)
  { id: "F4.1", feature: "F4 Voice price & offer", sub: "Page /shop/voice-price + shop board tile (Products → more); flag voice_price_assistant_enabled; rule voicePriceAssistant", status: "Done", local: L, test: F4_TEST, prod: F4_PROD, when: NOW, where: "src/app/shop/voice-price, menus.ts" },
  { id: "F4.2", feature: "F4", sub: "Speak in 9 languages (mr, hi, en, gu, kn, ta, te, bn, ur) on phone or browser; type; scan barcode", status: "Done", local: L, test: F4_TEST, prod: F4_PROD, when: NOW, where: "voice-price-assistant.tsx, lib/voice-input" },
  { id: "F4.3", feature: "F4", sub: "Built-in reader: price, % / ₹ off, until weekday / days / week, yes/no; Hindi + Marathi number words 1–100; Hinglish", status: "Done", local: L, test: F4_TEST, prod: F4_PROD, when: NOW, where: "lib/voice-command-parse.ts, lib/number-words-in.ts" },
  { id: "F4.4", feature: "F4", sub: "Product match in the shop's own listings: fuzzy, local names, Devanagari → Latin skeleton, pack size, barcode; choose when unsure", status: "Done", local: L, test: F4_TEST, prod: F4_PROD, when: NOW, where: "services/voice-price-assistant.ts" },
  { id: "F4.5", feature: "F4", sub: "AI fallback for other languages / dialects / loose phrasing (VOICE_COMMAND), logged with cost", status: "Blocked", reason: "Code done; needs ANTHROPIC_API_KEY on TEST/PROD (built-in reader works without it)", local: "Built (AI mocked in tests)", test: AI, prod: AI, when: NOW, where: "services/voice-price-assistant.ts" },
  { id: "F4.6", feature: "F4", sub: "Shows and reads back what was understood (en/hi/mr); publishes only after Yes / “हो / हाँ”", status: "Done", local: L, test: F4_TEST, prod: F4_PROD, when: NOW, where: "voice-price-assistant.tsx" },
  { id: "F4.7", feature: "F4", sub: "Publish: price via setShopPrices (history), offer via shop offers (audited); MRP, 1–90%, ₹ off < price, stale price, owner only", status: "Done", local: L, test: F4_TEST, prod: F4_PROD, when: NOW, where: "applyVoiceCommand" },
  { id: "F4.8", feature: "F4", sub: "Buy-X-get-Y offers; several products in one sentence", status: "Not started", reason: "Shop offers support % and ₹ off only; owner to decide if needed", local: "—", test: "—", prod: "—", when: NOW, where: "—" },
  { id: "F4.9", feature: "F4", sub: "Test with the flag on: shop owner, typed commands on staging; real phone + microphone", status: "In progress", reason: "Staging run 23-Nov 14.43–14.53 IST: 18 pass, 1 fail (fixed in F4.10). Microphone on a real phone: owner to test", local: "—", test: "Tested 23-Nov (typed, API); phone pending owner", prod: "Pending owner", when: NOW, where: "Test_Cases_Tracking/VOICE_PRICE_ASSISTANT_STAGING_TEST_RESULTS_2026-11-23.md" },
  { id: "F4.10", feature: "F4", sub: "Fixes after the staging test: published message shows old → new price (#496); warn when a new price is over 3× today's; refuse an offer on a product with no price (#497)", status: "Done", local: L, test: "Deployed (PRs #496, #497 staging-verified 23-Nov)", prod: "Live 23-Nov 21.11 IST (release PR #502, post-deploy check passed)", when: NOW, where: "services/voice-price-assistant.ts, rules.ts bigRiseWarnTimes" },
  // Admin
  { id: "AD.1", feature: "Admin / Operator", sub: "Settings: radius, AI provider, photo retention, WhatsApp per shop, templates", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "Rules smartShopping / whatsappShopOrders; shop WhatsApp page" },
  { id: "AD.2", feature: "Admin / Operator", sub: "Dashboards: scans/day, OCR match accuracy, products by photo, WhatsApp stats", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "/admin/smart-shopping, /admin/photo-listing, /admin/whatsapp-messages" },
  // Mobile
  { id: "MB.1", feature: "Mobile apps", sub: "All 3 features in Android + iOS (WebView pages, Tile Board)", status: "Done", local: L, test: TEST_STATE, prod: PROD_STATE, when: NOW, where: "website pages" },
  { id: "MB.2", feature: "Mobile apps", sub: "Native speech to text (Android WebView has none); mic permission; /wishlist App Links; 1.13.0", status: "Done", local: "Built, 61 app tests pass", test: "Needs EAS build", prod: "Needs store release", when: NOW, where: "mobile/src/speech.ts" },
  { id: "MB.3", feature: "Mobile apps", sub: "Build both apps and prepare store release", status: "Blocked", reason: "EAS build + store upload need the owner's Expo / Play / App Store accounts", local: "-", test: "-", prod: "-", when: NOW, where: "mobile/RELEASE_NOTES.md 1.13.0" },
  // Testing
  { id: "QA.1", feature: "Testing", sub: "OCR set: 20 photos (handwritten Marathi, printed Hindi, English, mixed, blurry, low light)", status: "In progress", reason: "20 synthetic printed images ready; real handwritten photos needed from owner; run needs AI key", local: "Set + benchmark built", test: AI, prod: "Not run on PROD (paid AI + customer account)", when: NOW, where: "tests/fixtures/smart-list-ocr" },
  { id: "QA.2", feature: "Testing", sub: "Product-photo set: packaged FMCG, loose, medicines — extraction accuracy", status: "Blocked", reason: "Needs real product photos + AI key", local: "-", test: AI, prod: "-", when: NOW, where: "-" },
  { id: "QA.3", feature: "Testing", sub: "WhatsApp E2E incl. double tap + two numbers at once", status: "Blocked", reason: "Meta keys; covered by automated race tests locally (19 pass)", local: "19 tests pass", test: META, prod: META, when: NOW, where: "whatsapp-shop-orders.test.ts" },
];

async function main() {
  const outs = process.argv.slice(2);
  if (outs.length === 0) throw new Error("Give at least one output .xlsx path.");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Tracker", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "ID", width: 9 },
    { header: "Feature", width: 26 },
    { header: "Sub-feature", width: 70 },
    { header: "Status", width: 13 },
    { header: "Blocked / reason", width: 44 },
    { header: "Local", width: 24 },
    { header: "TEST (test.gokesari.com)", width: 34 },
    { header: "PROD (gokesari.com)", width: 34 },
    { header: "Updated (IST)", width: 22 },
    { header: "Where", width: 40 },
  ];
  for (const r of rows) ws.addRow([r.id, r.feature, r.sub, r.status, r.reason ?? "", r.local, r.test, r.prod, r.when, r.where]);
  const fill: Record<Status, string> = { Done: "FFC6EFCE", "In progress": "FFFFEB9C", "Not started": "FFDDEBF7", Blocked: "FFFFC7CE" };
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8730C" } };
  ws.eachRow((row, i) => {
    row.alignment = { vertical: "top", wrapText: true };
    if (i > 1) row.getCell(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill[row.getCell(4).value as Status] } };
  });
  ws.autoFilter = "A1:J1";
  const s = wb.addWorksheet("Summary");
  s.columns = [{ header: "Status", width: 16 }, { header: "Count", width: 10 }];
  for (const st of ["Done", "In progress", "Not started", "Blocked"]) s.addRow([st, { formula: `COUNTIF(Tracker!D:D,"${st}")` }]);
  s.addRow(["Total", { formula: "SUM(B2:B5)" }]);
  s.getRow(1).font = { bold: true };
  for (const out of outs) await wb.xlsx.writeFile(out);
  console.log(`${rows.length} rows → ${outs.join(", ")}`);
}

void main();
