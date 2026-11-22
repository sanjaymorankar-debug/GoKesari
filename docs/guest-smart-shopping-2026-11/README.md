# Guest shopping, Smart Wishlist, list scanning and WhatsApp commerce: assessment and plan

*Brief received 22-Nov-2026 (the "GoKesari master development prompt", GS-001 … GS-037).
Code read at origin/staging 99074595 (migrations up to 0166). GoKesari only.*

This document covers deliverables 1–3, 5, 6, 8 and 9 of the brief: the architecture
assessment, the technical plan, the database, API and UI changes, the
integrations, the business decisions still needed, and the blockers.
The feature-wise tracker (deliverable 7) is
`GOKESARI_GUEST_SMART_SHOPPING_TRACKER_2026-11-22.xlsx` in this folder and in the
owner's `Devlopment_Trackers` folder. The API document (4) and the completion
report (10) are written as each phase lands.

---

## 1. Architecture assessment: what GoKesari already has

GoKesari already has more of this brief than the brief assumes. The work is
mostly **opening existing flows to guests and joining existing parts together**.
Very little needs to be built from nothing.

| Area | Today (staging) | Reuse | Gap |
|---|---|---|---|
| **Login** | Browsing, search, shop and product pages and price comparison are open to guests. Cart, checkout, orders, lists and tracking all call `requireUser()` / `requirePermission(ORDER_PLACE)`. The "Add to cart" button sends a guest to `/signin`. | NextAuth sessions (`src/server/auth.ts`); roles unchanged | No guest session. `carts.user_id` and `orders.user_id` are NOT NULL. |
| **Search** | `listStorefrontProducts` matches product, category, shop and area names, PIN, and Hindi/Marathi local names (`product_local_names`). Suggestions use trigram indexes. | Same service | Brand, GTIN/EAN/UPC and barcode are **not** searchable by customers. GTIN tools exist only for shop owners (`barcode-lookup.ts`, `pmd/gtin`). |
| **Location** | Location cookie, then the saved address; PIN or GPS picker; `serviceableShopIds`. | Same | None |
| **Lists** | "My lists" (`purchase_lists`, `purchase_list_items`, 0090): named lists, live price check, send to cart, reminders. | Service and UI | Items point at **one shop's listing** (`shop_product_id`), so a list cannot be priced at another shop. Signed-in customers only. |
| **List scanning (OCR + AI)** | Not built for lists. The same engine already reads **supplier bills** (`accounts/capture/extract-ai.ts`): Claude vision, printed and handwritten, English/Hindi/Marathi, photos and multi-page PDFs, confidence per field, review screen. Tesseract (English only) is used for KYC documents. | `extract-ai.ts` pattern, `blob-store`, upload checks | A list-reading prompt and schema, a recognition-history table, product matching for customers, and the confirmation screen. |
| **Product matching** | `pmd/match/engine.ts`: GTIN → MPN → brand+model → trigram, with scoring. Used only when importing products. | Engine and `product_local_names` | A customer-facing "text line → master product candidates" function. |
| **Shop comparison** | Per product only: `homePriceComparison` and `/search/compare`. `checkPurchaseList` prices a list with each shop's delivery fee. | Pricing via `priceLines` / `computeDeliveryFee` | Comparing a whole basket across shops, the three recommendations, the single-shop view, the per-product choice and quantity split. |
| **Cart and orders** | The cart already spans several shops. Checkout creates one order per shop. `order_groups` is the master order (`GK-YYYYMMDD-XXXXXX`) when the `parentOrders` rule is on. `order_status_history` exists. Order number is `DB-YYYYMMDD-XXXXXX`. | All of it | The brief's `GK-…-A/-B` suffix numbering is only a display choice (decision D-07). |
| **Inventory** | Stock is taken atomically at order time (`consumeOnlineStock`, guarded UPDATE). An unpaid online order holds stock until the payment intent expires; a failed or expired payment gives it back; cancellation restocks. | Same | No timed hold for a cart that has not been checked out (not needed; see §2.7). |
| **Checkout** | Wallet, COD (shop opt-in, ₹2,000 cap, risk checks) and Cashfree online. Contact details come from a saved address. Pickup vs delivery is decided by the **shop**, after the order. | Same | Guest contact fields; customer choice of pickup at checkout. |
| **OTP** | Sign-in codes go **by e-mail only**. There is no SMS sender. | `otp/service.ts` | Phone verification needs an SMS or WhatsApp sender (blocker B-02). |
| **Guest tracking** | Not built (`api/tracking/[orderId]` needs a signed-in owner). | — | Order number + verified contact + OTP. |
| **WhatsApp** | `WHATSAPP_PROVIDER` = `none` or `mock` only. `WhatsAppProvider` interface with template support exists. `shops.whatsapp_number` exists, but only as a wa.me link. No inbound webhook. | Provider interface, notification outbox (`notification_deliveries`, retries, DEAD), `emitEvent` catalogue, preferences | A real provider adapter, an inbound webhook with signature check, conversation state, the shop command parser, and shop number verification. |
| **Shop order actions** | `acceptOrder`, `rejectOrder` (refund + restock), `startPicking`, `markOrderReady`, `updateOrderStatus` (state machine, history, events). An acceptance SLA sweep exists. | **WhatsApp commands will call these same functions**, so the dashboard and WhatsApp can never disagree. | `shop_staff` has a CATALOGUE scope only; an ORDERS scope is needed for extra WhatsApp contacts. |
| **Payments** | Cashfree PG, server-side fetch before status moves, signed webhooks, idempotent refunds. One ORDER_GROUP payment covers several shops' orders. The platform collects and pays shops out in payout cycles. | All of it | None. The settlement model is already "platform collects, pays shops later" (decision D-08 confirms it). |
| **AI** | `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY`, model `claude-opus-5-5`, structured output. | Same client | None |
| **Admin configuration** | `RULES` registry (`platform_settings`, audited, edited at `/admin/settings`) and `feature_flags` (on/off per district, with change log). | Both | New rule groups and flags (§2.8). |
| **Mobile app** | Expo WebView of the website with native camera, push and Cashfree SDK. | The website's flows appear in the app automatically. Camera capture uses the existing picker. | None |
| **Vocestry.com** | No mention anywhere in the code. A web search on 22-Nov-2026 found **no public API documentation**. | — | Blocker B-04. |

**Conclusion.** The parts are there. The big pieces of new work are:

1. **Guest identity**: a guest customer who can own a cart, list and order.
2. **Lists of products, not shop listings**: master-product wishlist items.
3. **The basket comparison engine.**
4. **List reading**: scan, upload and typed lists through one AI engine.
5. **WhatsApp both ways**: a provider, the inbound webhook, and conversations.

Everything else is wiring.

---

## 2. Technical plan

### 2.1 Guest identity (GS-001, GS-018, GS-022, GS-036)

- **Guest session.** A signed, httpOnly, SameSite=Lax cookie `gk_guest` that
  holds a random 128-bit id, backed by a `guest_sessions` table. The table holds
  the id hash, created and last-seen times, the location, and an optional
  `guest_user_id`. Sessions expire after 30 idle days (rule `guestShopping`).
- **The guest is a real `users` row.** When a guest first needs to own something
  (a cart line or a list), the app creates a `users` row with
  `kind = GUEST`, role CUSTOMER, no e-mail and no way to sign in. That
  row owns the cart, lists and orders. **`carts.user_id` and `orders.user_id`
  stay NOT NULL**, so every existing query, report, invoice, refund, payout and
  RBAC check keeps working unchanged. We do not add a second "owner" column
  across 20+ tables.
- **Auth helper.** A new `requireShopper()` returns the signed-in user or the
  guest user. Cart, list, checkout and COD routes switch from `requireUser()` to
  it. Every other route (shop, dealer, franchise, operator, admin, rider) keeps
  `requireUser()` / `requirePermission()` unchanged.
- **Guest checkout** collects name, mobile, WhatsApp number (default: same as
  mobile), address/locality/PIN for delivery, optional e-mail and preferred
  channel. These are saved as an `addresses` row of the guest user, so checkout
  keeps using `addressId`. Phone verification by OTP applies to COD always, and
  to online payment if rule `guestShopping.verifyPhoneForOnline` is set. It
  needs an SMS or WhatsApp sender (B-02); until then the OTP goes to e-mail if
  given, otherwise guest COD stays off (D-03).
- **Merging at sign-up or sign-in.** If the guest later signs in or registers
  (offered after the first order, GS-001 §2.3), their cart, lists, addresses and
  orders move to the real account in one transaction, and the guest row is
  marked merged.
- **Guest tracking.** `/track` takes the order number + mobile or e-mail, sends
  an OTP, and shows a read-only order page for 30 minutes. Answers are the same
  whether the order exists or not (no enumeration). The page is rate-limited per
  IP and per order.
- **Abuse limits.** Per-IP rate limits on guest-session creation, scan uploads
  and checkout. Duplicate-order protection already exists (checkout
  `requestId`). The current guest COD limit is one open order.
- Everything sits behind feature flag **`GUEST_SHOPPING`** (district roll-out,
  off by default).

### 2.2 Search (GS-002)

- Add brand name (`brands`) and exact GTIN/EAN/UPC/barcode (normalised through
  `pmd` `gtinForms`) to `listStorefrontProducts` and the suggestions. A
  barcode-shaped query goes straight to the exact match.
- Homepage: a central search bar, location, and four tiles (Scan list, Upload
  list, WhatsApp, Track my order), plus a wishlist icon. The existing tile board
  stays below. Shop categories stay off the customer navigation as the brief
  asks; they already belong to registration.

### 2.3 Smart Wishlist (GS-003, GS-011)

- **Reuse `purchase_lists`; do not create a second wishlist.** Add
  `kind = WISHLIST` (an unnamed, current list per shopper) and add these columns
  to `purchase_list_items`:
  - `product_id`: the master product, so the list can be priced at any shop;
  - `shop_product_id` becomes optional (a pinned shop choice);
  - `requested_qty` + `requested_unit`, for example 2 L. This is kept separate
    from the pack size (for example 2 × 1 L packs), so the customer's
    requirement is never confused with the pack;
  - `source_text` and `source_lang` (traceability);
  - `match_confidence` and `scan_line_id`.
- **Unit normaliser** (`src/lib/units.ts`): kg/g, l/ml, pcs/packet/box/dozen,
  Devanagari and Gujarati numerals and unit words (लिटर/लीटर, किलो, नग, ग्रॅम …).
  500 g → 0.5 kg. It works out how many packs meet the requirement and shows
  that before anything is added.
- **Matcher** (`src/server/services/wishlist-match.ts`): text line → up to 5
  master-product candidates. Order of steps: GTIN; then `product_local_names`
  (Hindi/Marathi); then the `pmd` trigram engine; then category generics ("oil"
  → Sunflower / Groundnut / Soybean). It returns a confidence score. **Below the
  threshold, nothing is picked automatically**: the item is marked "Please
  choose".

### 2.4 List reading: scan, upload, typed and voice (GS-004 … GS-008)

- **One engine:** `src/server/services/list-reader.ts`. Input: up to 10 images
  (JPG/PNG/HEIC/WebP), PDFs (up to 10 pages), or text. Output: the lines with
  original text, language, quantity, unit, brand/variant if written, and
  confidence.
- **Recognition engine: Claude vision**, the engine already proven on
  handwritten Hindi/Marathi bills. It covers English, Marathi, Hindi, Gujarati
  and other Indian scripts, and regional numerals. Bills and invoices are
  recognised as such: the system takes product names only and never treats the
  bill total as a quantity. Tesseract (English-only, printed) is not good enough
  for handwriting. It stays only as a fallback for typed or printed English if
  AI is off. The engine is chosen by rule `listReading.provider`
  (`claude` | `off`), so it is modular.
- **Pre-processing:** EXIF orientation fix and resize/normalise with `sharp`
  (already used by the photo pipeline). Crop and rotate happen in the browser
  before upload.
- **Privacy:** images are kept in `blob-store` for `listReading.retentionDays`
  (default 30), then deleted. They are never used for marketing. Sending the
  images to the AI provider is decision D-04.
- **Confirmation screen** `/wishlist/scan/<id>`: the original image beside the
  recognised lines. Each line is editable (product, qty, unit). Uncertain lines
  are highlighted with candidates; lines can be removed or added. Only "Confirm
  list" writes wishlist items.
- **Voice:**
  - Website and app: the browser's speech recognition (Web Speech API, which
    supports hi-IN, mr-IN and gu-IN on Chrome/Android) turns speech into typed
    text and sends it to the same engine. No new provider is needed.
  - WhatsApp voice notes need a speech-to-text provider (D-05).

### 2.5 Basket comparison and shop selection (GS-012 … GS-017)

- **Service** `src/server/services/basket-compare.ts`, input: confirmed wishlist
  + location.
  1. Find candidate shops: serviceable, open or accepting orders, within the
     rule radius. Cap them (for example 15, nearest first).
  2. Build the matrix product × shop: price after offers (via `priceLines`),
     pack size, stock (`online_stock`, untracked = available), distance,
     delivery and pickup availability, delivery fee and free-above threshold,
     and stock last updated.
  3. Recommendations:
     - **A, lowest total:** cheapest total including per-shop delivery fees and
       free-above thresholds. This is an exact search over shop subsets (≤ 15
       shops, pruned) because "cheapest per item" ≠ "cheapest order".
     - **B, fewest shops:** a set cover, with ties broken on total.
     - **C, preferred shop:** the customer picks one shop.
     Each recommendation carries its reason in plain words ("Saves ₹42 vs one
     shop; 2 deliveries").
  4. **Single-shop view:** every shop with "covers 8 of 10", which items are
     missing or short, and its total. The customer picks one. Then, for each
     missing item, they choose: remove it, ask the shop (a price/stock request;
     `price-requests` exists), or cancel. **Nothing is moved to another shop
     silently.**
  5. **Per-product choice and quantity split:** the customer can choose a shop
     per line, or split a quantity (2 L from A + 3 L from B) as explicit
     allocation rows.
- **Allocation → cart:** the approved allocation writes ordinary cart lines (the
  cart is already multi-shop). The final review shows per-shop subtotal,
  delivery, taxes, discounts, total, number of shops and fulfilment. Checkout
  then works as today: one order per shop under one `order_groups` master, with
  the `parentOrders` rule switched on.
- **Pickup at checkout:** add `fulfilment_preference` (DELIVERY | PICKUP) per
  shop group in the cart. Pickup is offered only where the shop allows it
  (`delivery_choice`). For a multi-shop pickup, the order page shows each shop's
  address and pickup code. Pay-at-shop is the existing COD path with
  `fulfilment = PICKUP` (only if decision D-06 says yes).

### 2.6 WhatsApp (GS-009, GS-010, GS-023, GS-025 … GS-031, GS-034)

- **Adapter** `src/server/notifications/providers/whatsapp-<provider>.ts`,
  implementing the existing `WhatsAppProvider` interface. New
  `WHATSAPP_PROVIDER` values (`meta` and/or a BSP and/or `vocestry` once B-04 is
  cleared). Credentials come only from environment variables.
- **Inbound:** `POST /api/webhooks/whatsapp/[provider]` with the provider's
  signature check (Meta: `X-Hub-Signature-256` HMAC of the raw body). It is
  idempotent on the message id (`whatsapp_webhook_events` unique) and answers
  200 at once. The work happens in a background job: the existing jobs and outbox
  pattern, with retries.
- **Who is writing:**
  - Sender number → verified shop contact? Shop-owner conversation.
  - Otherwise → customer conversation: find or create a guest user keyed by the
    WhatsApp number. The number is verified by Meta, so it can count as
    phone-verified for that guest.
- **Customer conversation** (`whatsapp_sessions` state machine): list text,
  image or PDF → `list-reader` → matched list → clarification (reply buttons or
  lists, up to 10 rows) → location (WhatsApp location message or PIN) → the
  three recommendations → choice → a payment link (Cashfree, existing intents)
  or COD → confirmation. Anything WhatsApp can't do well (a large comparison
  table) gets a one-time signed link to the same page on the website.
- **Shop owner:**
  - Shops **verify** their WhatsApp number from the dashboard: GoKesari sends a
    code by WhatsApp and the owner enters it. Extra contacts become `shop_staff`
    with a new `ORDERS` scope, approved by the owner.
  - New-order message: a template with Accept / Reject / Details buttons.
  - Commands ACCEPT, REJECT, DETAILS, PREPARING, READY, DISPATCHED, OUT FOR
    DELIVERY, DELIVERED, CANCEL and SHOW PENDING ORDERS call the **same**
    `acceptOrder` / `rejectOrder` / `updateOrderStatus` functions as the
    dashboard. The state machine, history and events stay the single source of
    truth.
  - Every command checks that the sender is authorised for that order's shop.
    When more than one order is open, an order number is required.
- **Natural language:** Claude turns free text ("only 1 litre milk available")
  into a proposed action with a confidence score. Low confidence → the system
  asks. Cancellation, quantity reduction, price change and refund → always a
  confirm button. A stock shortage on a confirmed order is turned into a
  **customer approval request**, never applied directly.
- **Customer updates:** the existing `order.status_changed` event gains WhatsApp
  and e-mail recipients for the customer, by preference. A dashboard update
  therefore reaches WhatsApp, and a WhatsApp update reaches the dashboard,
  through the same event.
- **24-hour window:** messages outside the customer-service window use
  Meta-approved templates. The template list is in the integration document
  (needs approval, B-03).

### 2.7 Inventory reservation (GS-032, GS-033)

This mostly exists already:

- Stock is taken atomically when the order is created.
- An unpaid online order holds it until the payment intent expires
  (`onlinePayments.intentExpiryMinutes`). An expired or failed payment releases
  it; cancellation restocks.
- Per-shop orders reserve per shop.

What remains:

- Partial fulfilment from a shop shortage (customer approval, partial refund).
  The existing `substitute` and `remove` fulfilment actions are reused.
- A "stock as of" timestamp in the comparison.
- A re-check at checkout that reports what changed since the comparison.

### 2.8 Admin configuration (GS-035)

| Mechanism | New entries |
|---|---|
| Feature flags (per district) | `GUEST_SHOPPING`, `LIST_SCANNING`, `WHATSAPP_SHOPPING`, `WHATSAPP_SHOP_ORDERS` |
| Rules (`/admin/settings`) | `guestShopping` (session days, verify-phone rules, guest COD limit); `listReading` (provider, model, languages, max images/pages/MB, confidence threshold, retention days); `basketCompare` (radius, max shops, weights); `whatsapp` (templates, reply windows, number); `orderReservation` (reuses the intent expiry) |
| Monitoring pages | WhatsApp messages and webhook failures, recognition history and failures, failed payments (exists), integration log |

### 2.9 Phases

| Phase | Contents | External dependency | Can start |
|---|---|---|---|
| **P1** | Guest identity, guest cart, lists, checkout (online + e-mail OTP), guest tracking, brand/GTIN search, new homepage | None (OTP by e-mail until B-02) | Immediately after decisions D-01…D-03 |
| **P2** | Smart Wishlist on master products, unit normaliser, matcher, basket comparison A/B/C, single shop, split, pickup at checkout, `GK-…-A` numbering | None | After P1 |
| **P3** | List reading (scan, multi-image, PDF, typed, browser voice), confirmation screen | Anthropic API (key exists) | After P2 matcher; needs D-04 |
| **P4** | WhatsApp: provider adapter, webhook, customer conversation, shop verification, commands, natural language, notifications, templates | WhatsApp Business account + provider (B-01, B-03, B-04) | Code can be written against the `mock` provider; live only after B-01/B-03 |
| **P5** | Voice notes on WhatsApp, admin monitoring pages, retention jobs, completion report | STT provider (D-05) | After P4 |

Each phase is one or more PRs into `staging` through the staging queue, and goes
to production in the 23.00 IST release window, as CLAUDE.md requires. (The
brief's "merge into main" is done by the release step, not by merging directly.)

**On testing:** the brief says testing is handled separately through ChatGPT.
GoKesari's own rules still apply: each PR carries its unit and integration tests,
and the staging queue runs CI, guest QA and the post-deploy check before
anything moves on. A PR without its tests would be refused by the queue.

---

## 3. Database changes (planned migrations)

**Reused as they are:** `users`, `addresses`, `carts`, `cart_items`, `orders`,
`order_groups`, `order_items`, `order_status_history`, `domain_events`,
`notification_deliveries`, `notification_preferences`, `user_consents`,
`payment_intents` and related tables, `shop_staff`, `product_local_names`,
`platform_settings`, `feature_flags`.

| Migration | Change |
|---|---|
| guest identity | `users.kind` (REGISTERED, GUEST, MERGED) + `merged_into_user_id`; table `guest_sessions` (id hash, user id, location, created, last seen, expires); `guest_order_access` (OTP grants for tracking) |
| wishlist | `purchase_lists.kind += WISHLIST`; `purchase_list_items`: `product_id`, `shop_product_id` nullable, `requested_qty`, `requested_unit`, `source_text`, `source_lang`, `match_confidence`, `scan_line_id` |
| recognition | `list_scans` (shopper, channel WEB/APP/WHATSAPP, status, provider, model, pages, blob ids, language, error, cost tokens, expires); `list_scan_lines` (scan, line no, raw text, lang, qty, unit, brand, confidence, chosen product, candidates jsonb, status) |
| comparison | `basket_comparisons` (wishlist snapshot hash, location, result jsonb, expires) and `basket_allocations` (comparison, item, shop product, qty, mode): these keep the customer-approved allocation as evidence |
| cart | `cart_items.allocation_id` (optional); cart shop-group `fulfilment_preference` |
| orders | `orders.group_suffix` (A, B …) for `GK-…-A` display (if D-07) |
| WhatsApp | `whatsapp_contacts` (number, user id or shop id, role, verified at, opt-in, opt-out); `whatsapp_sessions` (contact, state, context jsonb, expires); `whatsapp_messages` (direction, provider id unique, type, body ref, status, error); `whatsapp_webhook_events` (raw, signature ok, processed); `shop_owner_commands` (contact, shop, order, parsed action, confidence, confirmed, result) |
| shop staff | `shop_staff_scope += ORDERS` |
| integrations | `external_api_logs` (provider, operation, status, latency, error; no personal data in bodies) |
| consent | `consent_type += WHATSAPP_TRANSACTIONAL`, plus a separate WhatsApp marketing opt-in (never assumed) |

Seller and customer tables still get **no foreign keys between them**, as
CLAUDE.md requires; the service checks those links. External calls (AI,
WhatsApp, payment, e-mail) never run inside `db.transaction`. They run after
commit or through the outbox.

---

## 4. API outline (full document written as each phase lands)

| Route | Phase |
|---|---|
| `POST /api/guest/session` (create or refresh), `GET /api/me` (works for guests) | P1 |
| `api/cart/*`, `api/purchase-lists/*`, `api/checkout`, `api/cod/eligibility`: guest allowed via `requireShopper()` | P1 |
| `POST /api/track/request-otp`, `POST /api/track/verify`, `GET /api/track/[token]` | P1 |
| `GET /api/search?q=` (+ brand, GTIN) | P1 |
| `GET/POST /api/wishlist`, `PATCH/DELETE /api/wishlist/items/[id]`, `GET /api/wishlist/match?text=` | P2 |
| `POST /api/wishlist/compare` → matrix + A/B/C; `POST /api/wishlist/allocate` → cart | P2 |
| `POST /api/list-scans` (multipart, up to 10 files), `GET /api/list-scans/[id]`, `PATCH /api/list-scans/[id]/lines/[n]`, `POST /api/list-scans/[id]/confirm` | P3 |
| `POST /api/list-scans/text` (typed or voice text) | P3 |
| `GET/POST /api/webhooks/whatsapp/[provider]` (verify challenge + events) | P4 |
| `POST /api/shop/whatsapp/verify`, `POST /api/shop/whatsapp/contacts` | P4 |
| Admin: `api/admin/whatsapp/*`, `api/admin/list-scans/*` | P5 |

---

## 5. Pending business decisions

| # | Decision | Recommended default |
|---|---|---|
| D-01 | Guest shopping on in production for all districts at once, or district by district? | Staging first, then district by district through the feature flag |
| D-02 | Must a guest verify their mobile before an **online-paid** order? | No (payment proves intent). Yes for COD. |
| D-03 | Guest **COD** before an SMS or WhatsApp sender exists (B-02)? | Off until the phone can be verified; allowed if a verified e-mail is given |
| D-04 | Sending customers' list photos and voice to Anthropic (Claude) for recognition, keeping them 30 days | Yes, with a notice on the scan screen; images deleted after 30 days; never used for marketing |
| D-05 | Speech-to-text provider for WhatsApp voice notes (Google STT, Sarvam AI, Bhashini) | Defer to P5; Sarvam or Bhashini for Indian languages; owner to pick on cost |
| D-06 | Pay-at-shop for pickup orders | Yes, where the shop has COD on |
| D-07 | Order numbers: keep `DB-…` per shop + `GK-…` master, or show `GK-…-A/-B` | Show `GK-YYYYMMDD-XXXXXX-A` to customers and shops; keep `DB-…` internally for invoices already issued |
| D-08 | Multi-shop settlement: keep "platform collects, pays shops in payout cycles" (no gateway split) | Keep it; it already works for multi-shop orders |
| D-09 | WhatsApp provider: Meta Cloud API direct, or a BSP (Gupshup / Interakt / AiSensy / 360dialog), or Vocestry | Meta Cloud API direct (lowest cost, no lock-in); Vocestry only if B-04 shows a real API |
| D-10 | Comparison radius and maximum shops per comparison | 5 km, 15 shops (admin-editable) |
| D-11 | Can a shop owner change a price by WhatsApp on an existing order? | No: price changes only from the dashboard; WhatsApp can report shortages |
| D-12 | Shop non-response on WhatsApp | Reuse the acceptance SLA rule (reminder, then auto-cancel and refund) |

## 6. Blockers

| # | Blocker | Blocks | Who |
|---|---|---|---|
| B-01 | No WhatsApp Business account, number or provider credentials (`WHATSAPP_PROVIDER` is only none/mock) | Live GS-009/010/023/025–031 (code can be built and tested on mock) | Owner: Meta Business verification + number |
| B-02 | No SMS or WhatsApp sender for OTP (codes go by e-mail only) | Phone verification for guest COD and guest tracking by mobile | Owner: choose an SMS provider (MSG91 is named in the code) or clear B-01 |
| B-03 | WhatsApp message templates must be approved by Meta (new order, status updates, OTP, payment link) | Messages outside the 24-hour window | Owner submits; template text drafted in P4 |
| B-04 | Vocestry.com: no public API documentation found (22-Nov-2026 search); capabilities can't be verified | GS-010 | Owner: send Vocestry's API docs or a contact |
| B-05 | An Anthropic API key with enough budget for customer scans on staging and production (the key exists for bill reading) | P3 live use | Owner: confirm budget / monthly cap |
