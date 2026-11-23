# Prompt: one subscription module for every kind of shop

Drafted 23-Nov-2026 from the owner's request. Builds on the newspaper work of
20-Nov ([../newspaper-subscriptions-2026-11/](../newspaper-subscriptions-2026-11/PROMPT.md)).
[DESIGN.md](DESIGN.md) records how it was built, [TEST_RESULTS.md](TEST_RESULTS.md) what was tested.

---

## The prompt

> Make GoKesari's subscription module generic, so any shop or business that
> sells on repeat can use it: a tiffin service with daily breakfast, lunch or
> dinner, a newspaper vendor, a dairy, a bakery, a flower seller, a water-can
> supplier — anything.
>
> **Today.** A customer can subscribe only to a catalogue product that staff
> marked "subscribable" (milk, curd, bread, the newspaper titles). The shop
> cannot decide what it offers on subscription, at what price, on which days or
> at what time; a tiffin kitchen has no way in.
>
> **Build:**
>
> 1. **Subscription plans, made by the shop.** In Seller Central the owner
>    creates a plan from one of their own products ("Veg lunch thali",
>    "Morning milk 1 L", "Times of India"): what kind it is (meal, newspaper,
>    milk and dairy, bakery, flowers and puja, water, fruit and vegetables,
>    other), the delivery slot (breakfast, lunch, snacks, dinner, early
>    morning, morning, evening or any time, with the shop's own time window),
>    the days it delivers (e.g. Monday to Saturday), which frequencies a
>    customer may choose (every day, chosen weekdays, chosen days of the month),
>    an optional subscriber price per unit, optional fixed terms (7 / 15 / 30
>    days), how many days ahead a subscription may start, and on / off.
>    Any product the shop lists can become a plan — it need not be marked
>    subscribable in the catalogue, nor be on sale for one-off orders
>    ("subscription only").
> 2. **Customers find and subscribe.** The shop's public page lists its
>    plans; a "Subscribe to a plan" page lists plans near the customer by kind
>    and slot. Subscribing shows the slot, the delivery days, the price and a
>    30-day estimate, and offers only what the plan allows.
> 3. **The engine stays.** A plan subscription is an ordinary subscription
>    (one order per delivery day, paid from the wallet, pause / skip /
>    renew / cancel) charged at the plan's price.
> 4. **The shop tracks it.** The shop is told of every new subscriber (as
>    since 20-Nov); the Subscribers page shows each plan and slot and a
>    "next 7 days" sheet — how many of each plan to prepare each day.
>
> **Test:** unit tests for the plan rules, integration tests against real
> PostgreSQL (plans, subscribing within the plan's rules, the plan price on
> generated orders, the 7-day sheet), a browser walk-through for a tiffin shop,
> then test.gokesari.com through the staging queue.

---

## Decisions taken (owner can change any of these)

| # | Question | Default used |
|---|---|---|
| 1 | Who creates plans? | The shop owner (and anyone with the shop-products permission for that shop). No staff approval: a plan uses a product the shop already lists. |
| 2 | Price | Optional subscriber price per unit on the plan; without it the listing's online price. Charged per delivery from the wallet, at the price on the day, as for every subscription. |
| 3 | Subscription-only products | Allowed: with a plan, the listing need not be on sale for one-off orders, but it must be active and available. |
| 4 | Kinds | Meal, Newspaper, Milk & dairy, Bakery, Flowers & puja, Water, Fruit & vegetables, Other — a label for finding plans; the engine treats all alike. |
| 5 | Slot | Breakfast, Lunch, Snacks, Dinner, Early morning, Morning, Evening, Any time; the shop may type its own window ("12:30–14:00"). Shown to the customer and on the shop's lists; it does not change order timing. |
| 6 | Delivery days | The shop sets the days it serves (default every day). "Every day" on a Monday–Saturday plan means Monday–Saturday; chosen weekdays must be serving days. |
| 7 | Terms | Optional fixed lengths (7 / 15 / 30 …). If the shop sets any, the customer picks one and the end date follows; otherwise open-ended or own end date. |
| 8 | Start | Earliest start = today + the plan's lead days (default 1: tomorrow), so a kitchen can plan. |
| 9 | Accept step | None (as for milk and newspapers): the shop is told at once. |
| 10 | Old subscriptions | Milk / newspaper subscriptions without a plan work exactly as before; the catalogue "subscribable" products still subscribe the old way. |
| 11 | Turning a plan off | Stops new subscriptions; running subscribers keep their deliveries until they cancel (the shop can contact them). |

## Later (not in this build)

- A per-plan cut-off hour for changing tomorrow's meal (today one rule for all).
- Menus that change by day (Monday rajma, Tuesday chole) shown on the plan.
- Package prices paid up front (30 lunches for ₹2,400) instead of per delivery.
- One combined daily order per household for several plans from one shop.
