# Purchase lists — weekly & monthly shopping and medicine lists

*Requested 24 Oct 2026. Customer feature, GoKesari (gokesari.com, test.gokesari.com).*

Customers keep their own **named lists** of what they buy again and again — a
shopping list ("Monthly groceries", "Weekly dairy") or a **medicines** list
("Papa's BP medicines"). Each week or month they only update the quantities,
tap **Check list** to see today's total, and **confirm** — the list goes to
the cart and they pay at checkout as usual.

## What the customer sees

| Where | What |
|---|---|
| **My lists** (`/lists`) — header, account menu, Orders tile → "My lists" | Shopping lists and medicine lists, each with how often (weekly / monthly), products, last ordered, **next due / Due now**. A form to create a list: type (🛒 Shopping / 💊 Medicines), name, weekly or monthly, reminder on/off. |
| **A list** (`/lists/<id>`) | Each product with its shop, today's price, a quantity stepper and a note (e.g. "1 after breakfast — for Papa"). **0 = skip this time** — the product stays on the list. Remove a product; edit the name, type, frequency, reminder; delete the list. An estimate of the items total. |
| **Check list** | A confirmation step priced exactly as the cart prices it: per shop, each line at today's price and offers, delivery charges, **total to pay**. Products that cannot be ordered now (out of stock, only N left, shop closed for orders) are shown and left out. If the cart already has items: **add this list to them** or **replace my cart**. |
| **Confirm order** | The list's products go to the cart, the list is marked ordered (its next due date moves on), and the customer goes to checkout for address, delivery time and payment. Nothing is charged before checkout. |
| **Product cards** | **📝 Add to list** (signed-in customers): pick a list or create one in place. A product already on the list is left as it is. |
| **Cart** | **📝 Save as a list**: the cart becomes a new list, or goes into an existing one (products already on it take the cart's quantity). |
| **Reminder** | Daily at 05:00 IST: a "Time to reorder: <list>" notification for each list that is due again (a week / a month after it was last ordered, or created), once per due date. In-app (and push for app users who have it on); no e-mail by default. |

Medicine lists are ordinary lists of products from pharmacies (shop type
`PHARMACY`); an empty medicine list links to "Find a pharmacy". Prescription
checks are unchanged: the shop's own rules apply at order time.

## Rules and limits

- Up to **20 lists** per customer, **100 products** per list, quantity **0–99** (the cart's cap).
- List names are unique per customer (any case), 1–60 characters; notes up to 120.
- Prices are **never stored** on a list: the list page shows today's price; the check and the cart price live (offers, delivery fee), and checkout re-prices server-side as always.
- A product the shop has removed stays on the list as "No longer sold" until the customer removes it; it is never ordered.
- Only the list's owner can see or change it (another customer's list id answers 404).

## Design

| Piece | File |
|---|---|
| Tables `purchase_lists`, `purchase_list_items` | `src/server/db/schema.ts`, migration `drizzle/0088_purchase_lists.sql` (`-- split: core`) |
| Service | `src/server/services/purchase-lists.ts` |
| Live pricing shared with the cart | `priceLines()` in `src/server/services/cart.ts` (the cart's own totals now go through it too) |
| API | `src/app/api/purchase-lists/**` |
| Pages and components | `src/app/lists/**`, `src/components/purchase-lists/**`, product card, cart page |
| Reminder job | `purchase-list-reminders` in the daily cron (`src/server/cron/schedule.ts`) |
| Tests | `tests/integration/purchase-lists.test.ts`, `tests/integration/purchase-lists-api.test.ts` |

### API

| Method & path | Does |
|---|---|
| `GET /api/purchase-lists` | The customer's lists (summaries) |
| `POST /api/purchase-lists` | Create `{ name, kind?: SHOPPING\|MEDICINE, frequency?: WEEKLY\|MONTHLY, remind? }` |
| `GET / PATCH / DELETE /api/purchase-lists/:id` | Read (items with today's prices) / change / delete |
| `POST /api/purchase-lists/:id/items` | Add `{ shopProductId, quantity?=1, note? }` (201; 200 with `alreadyOnList` when it was there) |
| `PATCH / DELETE /api/purchase-lists/:id/items/:itemId` | Quantity (0–99) or note / remove |
| `GET /api/purchase-lists/:id/check` | The list priced as the cart would price it; writes nothing |
| `POST /api/purchase-lists/:id/order` | `{ mode: ADD\|REPLACE }` — to the cart; returns what was added and what was left out (and why) |
| `POST /api/purchase-lists/from-cart` | `{ listId }` or `{ name, kind?, frequency? }` — save the cart as a list |

### Seller / customer split

Both tables are **customer** tables (core database, next to `carts`;
`src/server/db/split/ownership.ts`). `purchase_list_items.shop_product_id`
points at the seller database, so it has **no foreign key**: the service
checks the product exists before adding it, and reads lists with left joins
so a removed product shows as "No longer sold". Sending a list to the cart is
one core transaction (READ COMMITTED); its in-memory results are built inside
the transaction and returned from it, so a re-run on the split layout starts
clean. No seller table is written. Tested on both layouts (CI `test` and
`test-split`).

## Deploy

Migration `0088_purchase_lists` is additive (two new tables). It is applied by
`MIGRATE_ON_BUILD` on the sites, or by hand with `npm run db:migrate`. No new
environment variables, no new rule.
