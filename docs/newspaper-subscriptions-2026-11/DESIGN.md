# Newspaper and periodical subscriptions — how it is built

Built 20-Nov-2026 from [PROMPT.md](PROMPT.md). Tests: [TEST_RESULTS.md](TEST_RESULTS.md).

## The model

```
products ──1:1── periodical_titles          what the title is, when it comes out
   │                (kind, language, publisher, publication, issue day(s))
   │
shop_products  (the vendor's listing: price per copy, online sale on)
   │
subscriptions  (one per title per customer — the existing engine)
   + frequency MONTHLY  with month_days [1..28]
   + bundle_id          titles submitted together
   │
subscription_orders / orders / wallet deductions   (unchanged, one per title per delivery day)
```

- **Shop type** `NEWSPAPER_VENDOR` — "Newspaper & Magazine Vendor"
  (`src/lib/shop-types.ts`). Code only: the column is text.
- **Catalogue** (migration `0152`): categories *Newspapers* and
  *Magazines & Periodicals* (department `NEWSPAPER_VENDOR`) and 51 titles —
  35 dailies in English, Hindi, Marathi, Gujarati, Malayalam, Telugu,
  Tamil, Kannada and Bengali; 16 weekly / fortnightly / monthly magazines.
  Sold by the copy (`unit = piece`, one copy = one unit), `subscribable`,
  no MRP — each vendor sets their own price. A vendor's starter shelf
  offers these categories because they match the shop type.
- **A title** is any live, approved, subscribable product with a
  `periodical_titles` row **or** in a category of the newspaper vendor
  department, so a title added later through "add product" also appears
  (newspaper → daily, magazine/periodical category → monthly by default).
- **Schedules**: `DAILY`, `WEEKLY` (weekdays) as before, plus `MONTHLY`
  (`month_days`, 1–28). Fortnightly = `MONTHLY [1, 15]`. The title's
  publication only pre-fills the form (`defaultScheduleFor`,
  `src/lib/periodicals.ts`); the subscription's own schedule is what
  `resolveDelivery` follows.

## Customer flow — `/subscriptions/newspapers`

1. Tick titles (filters: newspapers / magazines, language, search).
2. Choose a saved address → **Find vendors**:
   `GET /api/subscriptions/newspapers/vendors?addressId&productIds`
   (`findNewspaperVendors`). Vendors are the shops `listServiceableShops`
   says deliver to that address (radius, delivery PIN codes, society
   partner — the same rule as checkout) that list at least one chosen
   title online. Order: most chosen titles carried, society partner,
   nearest. Any shop type counts (paper agent, bookstore, kirana).
3. Pick a vendor → copies (1–10) and schedule per title → start/end date →
   30-day estimate → **Subscribe**:
   `POST /api/subscriptions/newspapers` (`subscribeToNewspapers` →
   `createSubscriptionGroup`). All or nothing: every item is checked first
   (vendor's own listing, a title, subscribable and on sale, valid
   schedule, vendor delivers to the address), then all rows are written in
   one transaction with one `bundle_id`.

Entry points: *Newspapers & magazines* button on My Subscriptions, and
*Newspapers* under Subscriptions on the customer board / account menu.

## Vendor side

- **Notice** (`subscription-notices.ts`, type `shop.new_subscription`): sent
  to the shop owner after every new subscription — the grouped newspaper
  submission (one notice listing every title), a single subscription (milk,
  bread) and a draft being started. In-app, plus e-mail/push per the
  owner's settings. Example:
  *"Asha Patil subscribed to India Today (1 copy, Sun); The Times of India
  (1 copy, every day); Tinkle (1 copy, 1st of the month), starting 21 Nov
  2026. Deliver to: Shivajinagar, Pune, 411005."*
- **Subscribers** page `/shop/manage/subscribers` (Orders → Subscribers):
  totals per item, then every running or paused subscription with customer,
  address, item, copies, schedule, dates and status; new ones (3 days)
  marked. Today's work links to it.
- The vendor lists titles the normal way (Set up your shop's products →
  categories → pick titles → set price and turn online sale on).

## What did not change

Daily order generation, wallet deduction, stock, skip, pause, override,
renewal, cancellation and the customer's subscription pages work as before;
milk subscriptions behave exactly as they did (the only addition for them
is the vendor notice). Each title is its own daily order (see
[PROMPT.md](PROMPT.md) "Later").

## Files

| Area | Files |
|---|---|
| Migration | `drizzle/0152_newspaper_subscriptions.sql`, rollback `scripts/rollback-0152.sql` |
| Rules (client-safe) | `src/lib/periodicals.ts`, `src/lib/shop-types.ts` |
| Engine | `src/server/services/subscriptions.ts` (MONTHLY, `normaliseSchedule`, `createSubscriptionGroup`, vendor notice), `subscription-notices.ts`, `tomorrow-delivery.ts` |
| Newspaper service | `src/server/services/newspaper-subscriptions.ts` |
| API | `src/app/api/subscriptions/newspapers/route.ts`, `.../vendors/route.ts`; `MONTHLY` accepted by `/api/subscriptions` and `/api/subscriptions/[id]` |
| Pages | `src/app/subscriptions/newspapers/page.tsx`, `src/components/newspaper-subscribe.tsx`, `src/components/shop-subscribers.tsx`, `src/app/shop/manage/[section]/page.tsx` (subscribers) |
| Menus | `src/lib/board/menus.ts`, `src/components/board/icons.tsx` (newspaper icon) |
| Tests | `tests/unit/periodicals.test.ts`, `tests/integration/newspaper-subscriptions.test.ts`, `tests/unit/tile-board.test.ts` (menu counts) |
