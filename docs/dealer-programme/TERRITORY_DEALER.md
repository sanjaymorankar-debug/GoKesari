# Territory dealers

Owner, 20-Nov-2026. Built 20-Nov-2026 on branch `feat/territory-dealer`. Decisions: [docs/decision-log.md](../decision-log.md),
section "Territory dealers" (DT-24 … DT-27). Migration `drizzle/0151_territory_dealers.sql`, rollback `scripts/rollback-0151.sql`.
**Off by default**: nothing changes until an admin switches rule `territoryDealer` on and gives a dealer a territory.

---

## Part 1 — Owner guide (plain words)

GoKesari now has two kinds of dealer. Both have the same three-level team and the same registration commission.

| | Plain dealer | Territory dealer |
|---|---|---|
| Team | main dealer → team lead → agent | the same |
| Registration commission (on each shop's fee) | 20% to whoever signs it, 4% to his team lead, 3% to the main dealer | the same |
| Pays GoKesari | nothing | a yearly fee for an **exclusive territory** (a set of pincodes) |
| Order income | none | **20% of GoKesari's commission on every order** delivered by a shop in his territory, up to **25%** with his rating |

**The territory.** A set of pincodes. Only one territory dealer can hold a pincode at a time — the website and the database
both refuse a second. Every approved shop in those pincodes counts, including shops that registered before he took the
territory and shops another dealer signed (that dealer keeps the registration commission).

**The fee.** Set by an admin per territory, GST included. The dealer pays it on his dealer page (online), or an admin records a
bank transfer or cheque. Each fee covers 12 months; a renewal can be paid from 30 days before the paid-up date and runs on from
that date. If it is not renewed, he earns nothing on orders from the day it lapses; the pincodes stay his for 30 more days,
then they are released for another dealer.

**Order income.** For each order delivered by a shop in his territory while his fee is paid up:
GoKesari's commission on the order (2% today), minus the commission on any goods refunded, × his share that day.

| ₹1,000 order, 2% commission = ₹20 | Rating 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|
| His share | 20% | 21% | 22% | 23% | 24% | 25% |
| He earns | ₹4.00 | ₹4.20 | ₹4.40 | ₹4.60 | ₹4.80 | ₹5.00 |

A month with ₹10 lakh of orders in his territory: GoKesari's commission ₹20,000 → ₹4,000 (rating 5) to ₹5,000 (rating 10).

**The rating** (worked out every morning, from 5 to 10):

* up to **2.5 points for shop onboarding** — his own dealer rating (set by the number of shops his network got approved, as
  today) above 5, halved. Rating 9 → 2 points.
* up to **2.5 points for product-upload support** — the share of approved shops in his territory with at least 10 products
  live. 3 of 4 shops → 1.9 points.

Example: dealer rating 9, 3 of 4 shops live → 5 + 2 + 1.9 = 8.9 → 23.9% of GoKesari's commission.

**When he is paid.** The month's order income is worked out when the month closes and paid with his other commission on the
5th of the next month (one line, "Territory order income", on his statement). A refund recorded later is taken from a later
payout. On his dealer page he sees this month's orders and income so far, his rating and share, and the Pay button.

**Still to confirm** (defaults in use): the rating formula and the 10-product mark (DT-26); the 12-month term, 30-day renewal
window and 30-day grace (DT-27); a GST tax invoice for the territory fee (with the CA); whether order income should be shared
with his team.

---

## Part 2 — Admin guide

### Switching it on (test.gokesari.com first)

1. Admin → Settings → `territoryDealer`: set `enabled` to true and check the values (`baseShareBp` 2000, `stepBp` 100,
   `maxShareBp` 2500, `productWeightBp` 5000, `liveMinProducts` 10, `termMonths` 12, `graceDays` 30). A reason is asked
   and logged.
2. The dealer must be on the TIERED model (Admin → Dealers → Commission → TIERED model) — a territory dealer keeps the TIERED
   team and its commission.
3. Admin → Dealers → **Territory dealers** (`/admin/dealers/territories`) → *Give a dealer a territory*: the dealer, a name,
   the pincodes (comma or line separated) and the yearly fee in rupees. A pincode another territory holds is refused with its
   holder's name.
4. The dealer pays on his dealer page, or you record a payment with its reference (*Record payment*).

### Day to day

* **Change pincodes** (add / release, with a reason): an added pincode counts from that moment; a released one stops counting.
* **Change fee**: applies to the next payment. A fee already being paid online is cancelled and a new one made.
* **Cancel territory**: ends it now and releases the pincodes; income already worked out is still paid.
* **Rate now**: works today's rating out again (the daily job `dealer-territory-daily` does it every morning at 05:00 IST).
* The month close (`dealer-monthly-payout`, on the payout day) writes one `TERRITORY` ledger entry per territory and month, and
  a `REVERSAL` for refunds recorded after an earlier close. They are approved and paid like every other entry.

### Where the data is

| Table | What |
|---|---|
| `dealer_exclusive_territories` | the territory: dealer, name, status, yearly fee, paid-up date, latest rating and share |
| `dealer_territory_pincodes` | its pincodes (`released_at` null = held now; one holder per pincode, unique index) |
| `dealer_territory_fees` | each fee: amount, ONLINE (payment intent `TERRITORY_FEE`) or OFFLINE (reference), the 12 months it covers |
| `dealer_territory_ratings` | one row per territory and day: onboarding rating, shops, live shops, points, rating, share |
| `dealer_territory_order_shares` | one row per order counted: commission, refunded commission, share, amount, the ledger entry |
| `dealer_commission_ledger` (`entry_type` `TERRITORY`) | the month's order income, and later refund corrections |

### API

[API.md](../../API.md) → "Territory dealers".

### Rollback

Switch rule `territoryDealer` off first (nothing is worked out any more). Then, if the tables must go,
`scripts/rollback-0151.sql` — it refuses while TERRITORY ledger entries or TERRITORY_FEE payments exist (real money:
export them first).
