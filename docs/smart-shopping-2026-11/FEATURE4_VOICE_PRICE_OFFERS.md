# Feature 4 — change price or offer by voice (shop owners)

*Owner request 23-Nov-2026: "voice-based commands where the shopkeeper opens his shop, names or scans the
product and asks GoKesari to change the price … also offer discounts … understand all dialects and languages,
show what it understood, and publish once he says yes."*

**Flag:** `voice_price_assistant_enabled` (Admin → Feature flags; off until switched on; can be limited to
districts). **Rule:** `voicePriceAssistant` (Settings → Rules). **Page:** `/shop/voice-price` — shop board,
Products group → more → "Change price or offer by voice".

## What the shop owner does

1. Picks the language they will speak: मराठी, हिंदी, English, ગુજરાતી, ಕನ್ನಡ, தமிழ், తెలుగు, বাংলা or اردو.
   The default comes from the shop's state.
2. Taps **🎤 Speak** and says the product and the change, types it, or scans the barcode first. Examples:
   - "Amul Taaza 1 litre price 58 rupees"
   - "अमूल ताजाची किंमत अठ्ठावन्न रुपये करा"
   - "साखर 10 टक्के सूट रविवार पर्यंत" (10% off until Sunday)
   - "अमूल बटर 260 रुपये और 10 रुपये छूट" (a new price and ₹10 off, together)
   - "Parle G 2 rupees off for 3 days"
   - "Amul Taaza ka rate 59 kar do"
3. GoKesari shows **what it understood** and reads it aloud in the page language. It shows:
   - the product, with its photo and MRP;
   - the old price → the new price;
   - the offer and its end date;
   - what customers will pay.
   When it isn't sure which product was meant, it shows up to 5 of the shop's products to tap.
4. The owner taps **Yes, publish** or taps **🎤 Say yes / no** and says "हो / हाँ / yes" or "नाही / नहीं / no".
   Only then does anything change.

## What happens on "yes"

- **Price:** goes through `setShopPrices`, the same path as the inventory page's Save. It sets both the online
  and in-store price and writes to `product_price_history`.
- **Offer:** goes through `saveShopOffer`, the existing shop offers system. It is audited and appears in
  Marketing → Offers, where the owner can edit or stop it. It shows to customers the same way any offer does.
  - Kinds: percent off (1–90%) or rupees off each item, for one product.
  - Start: now. End: the end of the IST day said ("till Sunday", "3 days", "a week", "tomorrow"). If no end
    is said, the offer runs for `defaultOfferDays` (7).

## Safety checks

| Check | Result |
|---|---|
| New price above MRP | refused (Legal Metrology) |
| New price more than `bigDropWarnPercent` (50%) below today's | warning; the owner can still say yes |
| Percent off outside 1–90, or rupees off ≥ the price | refused |
| "Buy 1 get 1 free" | explained as not available yet: say a percent or rupees off instead |
| Product not in this shop | "add it first" (scanned barcode) or "not found, try another name" |
| Not sure which product | the owner taps one |
| Price changed between showing and "yes" (another device, the inventory page) | refused with the current price: say it again |
| Someone other than the shop's owner | refused. Staff keep using the price-request flow, as on the inventory page |
| Flag off | the page and APIs answer 404. A guest gets 401 or the sign-in page first |

## How it understands

- **Speech to text** happens on the phone (the app's recogniser, app 1.13.0+) or in the browser (Web Speech
  API). No audio reaches GoKesari, and there is no server speech key.
- **Built-in reader** (`src/lib/voice-command-parse.ts`). It needs no AI and costs nothing:
  - regional digits (४५);
  - Hindi and Marathi number words 1–100 (`src/lib/number-words-in.ts`), with spelling variants;
  - Marathi hundreds (दीडशे = 150);
  - rupee, percent, discount, "until", weekday and duration words in Marathi, Hindi and English, including
    Hindi and Marathi typed or recognised in Latin letters ("rate 59 kar do");
  - pack sizes ("1 litre", "500 g") stay part of the product name.
- **Product match:** only this shop's own listings, through:
  - pg_trgm on the name and brand;
  - local names and synonyms (`product_local_names`: साखर = Sugar);
  - a Devanagari → Latin spelling with a consonant skeleton, so "अमूल बटर" finds "Amul Butter";
  - a bonus when the spoken pack size matches.
  It is picked without asking when its score is at least `autoPickScore` (60) and clearly ahead of the next.
- **AI** (`VOICE_COMMAND`, through the shared provider layer) is used only when the reader finds no change or
  no product words. That covers other languages, dialects and loose phrasing. It is logged in `ai_usage_log`,
  shows on `/admin/smart-shopping`, and counts toward the per-user daily AI limit. It costs about ₹1–2 per call
  on the default model. When AI is off or failing, the owner is asked to say it again.

## API

| Method & path | Does |
|---|---|
| `POST /api/shops/:id/voice-price/interpret` | `{ text, shopProductId?, barcode? }` → the proposal (`chosen`, `candidates`, `newPricePaise`, `offer`, `finalPricePaise`, `issues[]`, `readBack{en,hi,mr}`, `canPublish`). Changes nothing |
| `POST /api/shops/:id/voice-price/apply` | `{ shopProductId, newPricePaise, offer, expectedPricePaise }` → publishes. Every check is repeated |

No new tables and no migration.

## Tests

- `tests/unit/voice-command-parse.test.ts`: Marathi, Hindi and English phrases; yes/no; IST end dates;
  Devanagari → Latin; buy-get-free counts.
- `tests/integration/voice-price-assistant.test.ts` (14), with a real database and AI mocked:
  - flag off, guest and owner-only access;
  - price change with history;
  - Marathi offer by local name;
  - Hindi price + offer;
  - MRP, big drop, 95% off;
  - choosing between candidates;
  - barcode;
  - a stale price;
  - the AI fallback and AI off;
  - buy-get-free;
  - the routes.

## Not in this version

- Buy-X-get-Y offers. Shop offers support only percent and rupees off.
- Several products in one sentence.
- Changing stock by voice. Feature 2 covers new products.
- Shoppers searching by voice.
