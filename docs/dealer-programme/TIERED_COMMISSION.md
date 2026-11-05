# TIERED dealer commission and shop-refers-shop

Owner brief of 02-Nov-2026 (21.21 IST). Built 02-Nov-2026 on branch `feat/dealer-tiered-commission`.
Decisions: [docs/decision-log.md](../decision-log.md), section "TIERED dealer commission and
shop-refers-shop" (DT-01 … DT-17). Everything is **off by default** and changes nothing for existing
dealers, shops or customers until an admin switches it on.

| Switch | Where | Default |
|---|---|---|
| Rule `dealerTieredCommission` | Admin → Settings | off (`enabled: false`) |
| Rule `dealerPayoutTds` | Admin → Settings | off — waiting for the CA |
| Rule `shopReferrals` | Admin → Settings | off |
| A dealer's model (`dealers.commission_model`) | Admin → Dealers → Commission → TIERED | `STANDARD` for every dealer |
| Feature flag `dealer_programme_enabled` (existing) | Admin → Feature flags | as today |

Migrations: `drizzle/0136_dealer_tiered_commission.sql` (seller database), `drizzle/0137_shop_referrals.sql`
(seller database). Rollback: `scripts/rollback-0136.sql`, `scripts/rollback-0137.sql`.

---

## Part 1 — Owner guide (plain words)

### A. The dealer network (TIERED)

A dealer you move to TIERED can build a team of **at most three levels**:

```
Main dealer (level 1)
 ├─ Team lead (level 2)
 │    └─ Agent (level 3)
 └─ Agent (level 2, reporting straight to the main dealer)
```

A fourth level is impossible — the website refuses it and so does the database.

**What is paid on each shop** (percent of the registration fee the shop actually paid, before GST,
after any coupon):

| Who | Default | When |
|---|---|---|
| Whoever signed the shop (agent, lead or main dealer) — "direct" | 20% | when the shop pays its fee and is approved |
| The agent's team lead — "lead override" | 4% | at the same time |
| The main dealer, on every shop his team signs (leads' and agents') — "main override" | 2% | at the same time |

*Owner's structure, 5 Nov 2026 (decisions DT-13 to DT-16).* Everything is earned when the shop pays
and is registered; there is no wait for orders, and **no per-shop cap** — the fee the shop owner paid
earns its full commission at every level. All of a month's commission (shops registered up to the
last day of the month) is paid on the **5th of the next month**.

* A missing level is not paid: an agent who reports straight to the main dealer has no lead
  override; a shop the main dealer signs himself earns only the direct 20%; a team lead's own shop
  earns him the direct 20% (not the 4% as well). Nobody is paid twice on one shop. The most a shop
  can cost is 26% (27% with a development bonus).
* The dealer's rating still moves the **direct** part only, as today.
* A TRADING condition (part of the direct share and the overrides only after N delivered orders
  within D days) still exists in the rule (`tradingOrders` above 0) but is **off**: `tradingOrders` 0.

Worked examples (fee before GST):

| Shop signed by | ₹4,999 shop | ₹9,999 shop |
|---|---|---|
| An agent under a team lead | agent ₹999.80 · lead ₹199.96 · main dealer ₹99.98 (26%) | agent ₹1,999.80 · lead ₹399.96 · main dealer ₹199.98 |
| A team lead himself | lead ₹999.80 · main dealer ₹99.98 (22%) | lead ₹1,999.80 · main dealer ₹199.98 |
| The main dealer himself | main dealer ₹999.80 (20%) | main dealer ₹1,999.80 |

**Renewals.** When a shop that is still active pays its membership renewal, whoever signed it
earns 10% of the renewal (before GST). Can be switched off.

**Promotion.** An admin can promote an agent to team lead once he has 10 activated shops (or
earlier, with an override and a reason). He then reports to the main dealer and takes the agents
he brought in with him. His former lead earns a **1% development bonus** on that team's shops (the
new lead's own and his agents') for 6 months — but **only for a calendar month in which the new team
registers at least 100 shops**. A month below 100 pays no development bonus (the ledger says so:
"the team activated 80 shops — monthly minimum 100 not reached"); the next month is checked afresh.
It is settled when the month closes and paid on the 5th with everything else.

Example (₹4,999 shops): month 1 the new team registers 120 shops → the former lead gets 120 × ₹49.99;
month 2, 80 shops → nothing; month 3, 100 shops → 100 × ₹49.99. After 6 months it stops.

**Sub-agents.** Agents cannot appoint anyone. They ask from their dealer page; an admin approves.

**Monthly target bonuses** (off by default): a fixed ₹ amount per role when a target is reached in a
month (default examples: agent ₹1,000 at 10 shops, team lead ₹2,500 at 30, main dealer ₹5,000 at 100).

**Reversals.** A refund, a waived fee, fraud or a duplicate takes back **every level** on that shop
(direct, overrides, development). Money already paid is taken from the person's next payout.

**Payouts.** Monthly on the 5th, as today — now **one payout per person** (main dealer, each lead,
each agent), each to their own verified bank account under their own PAN. The statement has one line
per type (direct part 1, direct part 2, overrides, renewal, development, bonus) and shows **gross, TDS
and net**. TDS (2% above ₹20,000 a year) stays **off until the CA confirms**.

**Compliance.** No joining fee, nothing paid for recruiting; only a paid registration or renewal
creates commission. Every member accepts the agent agreement (versioned, time-stamped) before being
paid — what they earn before that waits on hold and is released when they accept.

**Existing dealers** stay on the standard 40% model until an admin moves each one. Commission
already earned is never recalculated.

### B. Shop-refers-shop

* Every approved shop gets its own code (`SHOP` + 5 letters/digits, e.g. `SHOPK7Q2M`) and link
  (`https://gokesari.com/r/SHOPK7Q2M`) on **My Shop → Registration and fee**, with WhatsApp / Share /
  Copy buttons.
* A new shop enters **one** code when registering — a dealer's code **or** a shop's code, never both.
  The first code entered is kept.
* **The new shop** gets 10% off its registration fee (or, if you prefer, a ₹100 welcome credit in its
  shop wallet).
* **The referring shop** gets ₹200 of promotional credit in its shop wallet (or 1 month more
  membership) — once the new shop is approved **and** has delivered its first order.
* Promotional credit pays GoKesari commission and delivery charges only. It is never paid out to a bank.
* No reward when the two shops share a PAN, GSTIN, mobile, bank account or owner, or the new shop looks
  like a branch or a duplicate. At most 20 rewards per referring shop in 12 months.
* An admin can take a reward back (Admin → Shop referrals → Reverse reward).

### What still needs your decision

See "Open items for the owner" at the end of this file.

---

## Part 2 — Admin guide

### Switching TIERED on (test.gokesari.com first)

1. Admin → Settings → `dealerTieredCommission`: set `enabled` to true; check the values
   (directBp 2000 = 20%, leadOverrideBp 400 = 4%, mainOverrideBp 200 = 2%, firstPartBp 10000 = all at
   activation, tradingOrders 0 = no trading condition, renewalEnabled / renewalBp 1000,
   promotionMinShops 10, developmentBp 100 / developmentMonths 6 / developmentMinShopsPerMonth 100,
   targetBonusesEnabled + targets). A reason is asked and logged. If the rule was saved before
   5 Nov 2026, the saved values win over the new defaults: set them to these.
2. Admin → Dealers → Commission → **TIERED model** (`/admin/dealers/commission/tiered`): choose the
   dealer → **Move this dealer to TIERED** (reason). Optionally set the dealer's own %s.
4. Build the team: **Add a member** (role, and who they report to), or let the main dealer add them
   from his dealer page. For each member: **Link account** (the email of their GoKesari account, so
   they can sign in to `/dealer`), their PAN and bank (they can enter it themselves), then **Mark bank
   verified** after the bank check or the cancelled cheque.
5. Each person accepts the agent agreement on their `/dealer` page.

### Day to day

* **TRADING** is checked on every delivered order, and once a day for shops past their window
  (cron job `dealer-tiered-daily`).
* **Promote**: TIERED screen → the agent → *Promote to team lead* (or *Promote anyway (override)*
  below the shop count). A reason is required.
* **Move an agent** to another lead: *Move to…* (reason). A lead with agents cannot become an agent.
* **Sub-agent requests**: TIERED screen → *Sub-agent requests* → Approve / Decline.
* **Ledger, approvals, payouts**: Admin → Dealers → Commission → Ledger & payouts, as today.
  A payout is per person; **Paid** is refused until the person has a PAN and a verified bank account.
  `createPayout` takes the member when paying a member by hand.
* **Month close** (5th): one draft payout per person, with TDS when `dealerPayoutTds` is on; target
  bonuses are added first.
* **Reversal**: a refund recorded on the shop (Finance) or *Reverse* on an entry. Every level goes.

### Shop referrals

* Admin → Settings → `shopReferrals`: `enabled`, `referredMode` DISCOUNT (`referredDiscountBp` 1000) or
  WALLET_CREDIT (`referredCreditPaise` 10000); `referrerMode` WALLET_CREDIT (`referrerCreditPaise` 20000)
  or MEMBERSHIP_EXTENSION (`referrerExtensionMonths` 1); `maxRewardsPerYear` 20.
* Admin → **Shop referrals** (`/admin/shop-referrals`): every referral with its outcome (pending,
  rewarded, rejected with the reason, reversed) and *Reverse reward*.

### Where the data is

| Table (seller database) | What |
|---|---|
| `dealer_salespeople` (+ `team_role`, `depth`, `parent_*`, `recruited_by_id`, PAN, bank, agreement) | the team |
| `dealer_tier_shop_plans` | per shop: who earns what (frozen at approval) and TRADING progress |
| `dealer_team_developments` | development bonus windows after a promotion |
| `dealer_team_requests` | sub-agent requests |
| `dealer_commission_ledger` (+ `entry_type`, `payee_member_id`, `level`, `accrual_key`) | every entry |
| `dealer_payout_batches` (+ `member_id`, `tds_paise`, `tds_rate_bp`) | payouts, one per person |
| `shop_referral_codes`, `shop_referrals` | shop codes and referrals |
| `shop_wallets.promo_balance_paise` | the promotional part of a shop wallet |

### API

See [API.md](../../API.md) → "TIERED dealer commission and shop referrals".

### Rollback

Switch the three rules off first. Then, if the tables must go: `scripts/rollback-0137.sql` and
`scripts/rollback-0136.sql` (read the checks at the top of each — paid TIERED entries are real
payments; export them first).

---

## Open items for the owner

| # | Item | Default chosen | Status |
|---|---|---|---|
| O-1 | Team members are paid **directly by GoKesari** (own PAN, bank, agreement), not through the main dealer (DT-01) | direct | Needs your confirmation |
| O-2 | Per-shop cap (DT-03) | **removed** (owner, 5 Nov 2026; DT-15) | Done |
| O-3 | TDS section, rate (2%) and ₹20,000 threshold (DT-09) | off | **Blocked on CA** |
| O-4 | GST invoices / self-invoicing for commission paid to dealers and members (RCM if unregistered) | not built | **Blocked on CA** |
| O-5 | If the TIERED rule is switched off, TIERED dealers earn the standard model for new shops (DT-02) | standard | Per-dealer model: assumed confirmed with the 5 Nov structure (DT-13) |
| O-6 | Development bonus when the promoted agent reported straight to the main dealer: nobody (DT-05) | nobody | Needs your confirmation |
| O-9 | The 100-shop monthly minimum counts shops the new team **registered (paid and approved) in that calendar month** (DT-16) | registered in the month | Assumed from your message of 5 Nov 2026 |
| O-7 | Target bonus amounts (examples only) | off | Needs your amounts |
| O-8 | Agent agreement text (src/lib/dealer-tiers.ts) — legal review | draft | Needs legal review |
