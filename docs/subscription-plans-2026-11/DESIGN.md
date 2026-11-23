# Subscription plans — how it is built

Built 23-Nov-2026 from [PROMPT.md](PROMPT.md). Tests: [TEST_RESULTS.md](TEST_RESULTS.md).
Builds on the subscription engine and the newspaper work ([../newspaper-subscriptions-2026-11/DESIGN.md](../newspaper-subscriptions-2026-11/DESIGN.md)).

## The model

```
shops ── shop_products (the shop's listing: product, online price, on/off)
   │            │
   └── subscription_plans  (migration 0182)
          name, description, kind, slot (+ shop's own window),
          service_days, allowed_frequencies, price_paise (subscriber price),
          term_days, lead_days, is_active, deleted_at
                │
subscriptions.plan_id  (nullable, no FK — seller/customer link checked in the service)
                │
subscription_orders / orders / wallet   (unchanged: one order per delivery day)
```

- **Kinds**: Meals & tiffin, Newspapers & magazines, Milk & dairy, Bakery,
  Flowers & puja, Water, Fruit & vegetables, Other — for finding plans.
- **Slots**: Early morning, Breakfast, Morning, Lunch, Evening snacks,
  Evening, Dinner, Any time; the shop may type its own window.
- **Rules** (`src/lib/subscription-plans.ts`, used by the pages and the
  server): `planRulesProblem` (the shop's settings), `fitScheduleToPlan`
  (the customer's choice — "every delivery day" on a Mon–Sat plan becomes
  Mon–Sat; weekdays must be serving days; only allowed frequencies),
  `termEndDate`, labels.

## Engine changes (`src/server/services/subscriptions.ts`)

- `createSubscription({ …, planId, termDays })`: loads the live plan, fits the
  schedule, enforces lead days and fixed terms (end date = start + term − 1),
  stores `plan_id`.
- `assertSubscribable(…, plan)`: with a plan, any listing of that shop
  qualifies (the catalogue "subscribable" flag is not needed) and a
  subscription-only listing (not on sale online) is purchasable at the plan
  price. Without a plan: exactly as before.
- `subscriptionUnitPrice(plan, listing)` = plan price, else the online price —
  used by order generation, the cost preview, the customer's lists and the
  renewal check (`subscription-renewal.ts`).
- `updateSubscription`: a plan subscription's schedule changes stay within
  the plan; its product cannot be switched.
- Draft activation re-checks the plan is live.
- The shop's new-subscriber notice names the plan and slot
  ("Veg lunch thali (1 piece, Mon–Sat, Lunch (12:30–2 pm))").
- Weekly schedules of 3+ consecutive days read as a range ("Mon–Sat").

## Plans service (`src/server/services/subscription-plans.ts`)

| Function | What |
|---|---|
| `listShopPlans` | the shop's plans with product, prices and running subscribers |
| `createPlan` / `updatePlan` / `setPlanActive` / `removePlan` | own listing only; unique name per shop; a price must exist; product cannot change while it has subscribers; removal is soft and running subscribers keep delivering |
| `getPublicPlan` / `listPublicPlansForShop` | plans customers can take: on, shop live, listing active and available, a price |
| `findPlansNear(location, { kind, slot })` | plans of shops that deliver to the location (`listServiceableShops`: radius, PIN codes, society partners) — partners, then nearest |
| `subscribeToPlan` | the shop must deliver to the chosen address; the rest is the engine's |
| `planPrepSheet(shopId, { from, days })` | per plan (or product without a plan) and per day: deliveries and total quantity, from `resolveDelivery` with overrides — serving days, skips and pauses included |

## API

| Route | Who | What |
|---|---|---|
| `GET/POST /api/shops/[id]/subscription-plans` | shop owner (or staff with `shop-product:manage:any`) | list / create |
| `PUT/PATCH/DELETE /api/shops/[id]/subscription-plans/[planId]` | same | replace / switch on-off / remove |
| `GET /api/subscription-plans?kind&slot&addressId` | anyone (a saved address needs sign-in) | plans near the address, chosen location or default address; `[]` without a location |
| `GET /api/subscription-plans/[planId]` | anyone | a plan customers can take, else 404 |
| `POST /api/subscription-plans/[planId]/subscribe` | signed-in customer | take the plan |

## Screens

- **Seller Central → Product categories → Subscription plans**
  (`/shop/manage/subscription-plans`): create, edit, switch off, remove;
  subscriber count per plan.
- **Orders → Subscribers** (`/shop/manage/subscribers`): "Next 7 days — what
  to prepare" table, then every subscriber with plan and slot.
- **Customer**: *Subscription plans* (`/subscriptions/plans`, also under
  Subscriptions on the board and on My Subscriptions) — by address, kind and
  slot; the shop's page lists its plans; `/subscribe/plan/[planId]` offers only
  what the plan allows, with a 30-day estimate; My Subscriptions and the
  subscription page show the plan and slot.

## Unchanged

Milk, bread and newspaper subscriptions taken the old way (catalogue
"subscribable" products, the newspaper flow) work exactly as before; order
generation, wallet deduction, pause, skip, renewal and cancellation are the
same for plan subscriptions. No feature flag: plans appear only once a shop
creates one.

## Files

| Area | Files |
|---|---|
| Migration | `drizzle/0182_subscription_plans.sql`, rollback `scripts/rollback-0182.sql` |
| Rules | `src/lib/subscription-plans.ts`, `src/lib/periodicals.ts` (weekday range label) |
| Engine | `src/server/services/subscriptions.ts`, `subscription-renewal.ts`, `subscription-notices.ts`, `newspaper-subscriptions.ts` (subscriber list shows the plan), `audit.ts` |
| Plans service | `src/server/services/subscription-plans.ts`, `src/server/api/subscription-plan-schema.ts` |
| API | `src/app/api/shops/[id]/subscription-plans/**`, `src/app/api/subscription-plans/**` |
| Pages | `src/app/subscriptions/plans/page.tsx`, `src/app/subscribe/plan/[planId]/page.tsx`, `src/app/shop/manage/[section]/page.tsx`, `src/app/shops/[slug]/page.tsx`, `src/app/subscriptions/page.tsx`, `src/app/subscriptions/[id]/page.tsx` |
| Components | `plan-cards.tsx`, `plan-subscribe-form.tsx`, `shop-plans-manager.tsx`, `shop-subscribers.tsx` (prep sheet) |
| Menus | `src/lib/board/menus.ts` (customer Subscriptions → Plans; shop Product categories → Subscription plans) |
| Tests | `tests/unit/subscription-plans.test.ts`, `tests/integration/subscription-plans.test.ts`, `tests/qa/guest/subscription-plans.spec.ts`, `tests/qa/signed-in/subscriptions-plans.spec.ts`; cases TC-SUB-028…035 |
