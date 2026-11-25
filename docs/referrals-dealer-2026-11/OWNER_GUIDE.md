# Referrals, dealer commission, payouts and TDS — owner guide

03-Nov-2026 · Briefs of 02-Nov-2026 (21.21 IST and 21.33 IST) · Gap report: [GAP_REPORT.md](GAP_REPORT.md)
Other guides: [ADMIN_GUIDE.md](ADMIN_GUIDE.md) · [CA_GUIDE.md](CA_GUIDE.md) · [DEALER_AGENT_GUIDE.md](DEALER_AGENT_GUIDE.md) · [TIERED_COMMISSION.md](../dealer-programme/TIERED_COMMISSION.md)

> **Current rules (24-Nov-2026):** the 3-level (TIERED) rates are **20% / 4% / 3%**, all earned when the shop pays
> its fee and is approved (no trading wait), no per-shop cap; the main dealer gets **4%** when the signer reports to
> him directly and **3%** two levels up (since 21-Nov-2026). Renewals **10% / 2% / 1%** for 3 years from activation;
> promotion to team lead at **50 activated shops and 3 ready agents**; a monthly target of **50 shops** for every role
> pays **10%** of that month's commission (owner, 05-Nov-2026 and 20/21-Nov-2026). Details:
> [TIERED_COMMISSION.md](../dealer-programme/TIERED_COMMISSION.md). Since 23-Nov-2026 new dealers start on the
> scheme platform's Free Dealership v2 unless an admin moves them to TIERED
> ([dealer-platform](../dealer-platform/README.md)).

**Everything new is switched off** (as built on 03-Nov-2026). On gokesari.com nothing changes for dealers, shops or customers
until an admin switches a rule on. Existing dealers stay on the 40% (BASE_PERCENT) model; nothing
already earned is recalculated.

## What you get

| Part | In plain words | Switch (default) |
|---|---|---|
| 0 | Customer referrals (₹50 each) fixed: a reversal never takes the customer's own money; risk flags after a reversal; the cap can't be overrun; the "same address" check is stronger | `customerReferrals` (off on production unless switched on) |
| A | 3-level dealer network (main dealer → team lead → agent), ~~20 / 5 / 3% on paid shop fees, part paid when the shop is trading~~ 20 / 4 / 3% earned at activation (see the note above), renewals, promotions, target bonuses, team mapping table with history and CSV | `dealerTieredCommission` (off) + each dealer moved by an admin |
| B | Shops refer shops: own code and link, 10% off for the new shop, ₹200 credit (or 1 month) for the referrer | `shopReferrals` (off) |
| C | Monthly payout to every earner, **one payout per PAN**; held (and reminded) without PAN / bank / agreement; minimum payout; automatic bank transfer; payout reports | `dealerPayouts` (checks for dealers off, minimum ₹0), `dealerAutoPayout` (off) |
| D | TDS on commission by dated rows the CA confirms; certificates; challans; 26Q; Form 16A; a CA login | `dealerPayoutTds` (off) |

## Decisions still waiting for you

| # | Decision | What is built meanwhile |
|---|---|---|
| 1 | Per-shop cap: ₹999 is below 28% of the ₹4,999 / ₹9,999 fees | *Decided 05-Nov-2026: no per-shop cap on TIERED (DT-15)* |
| 2 | Move Module 3 distributor commissions (`referral_commissions`) into the dealer ledger | **Not done** — waiting for your OK (risk of double pay) |
| 3 | Team members paid directly by GoKesari (each by PAN) — confirm | Built that way |
| 4 | Development bonus when the promoted agent had no former lead | Nobody gets it |
| 5 | With the TIERED rule off, TIERED dealers earn the standard model | Built that way |
| 6 | Minimum payout amount (₹100 suggested) and switching payee checks on for dealers | ₹0 and off (today's behaviour) |
| 7 | Target bonus amounts | *Decided 05-Nov-2026: 50 shops a month, 10% of the month's commission, every role (DT-19)* |
| 8 | Agent agreement text — legal review | Draft in the code |
| 9 | Customer-referral fixes P0-1…P0-5 were made after you said "restart development" — tell us if any should be undone | Fixed and tested |

## Waiting for the CA

TDS section (old 194H) under the Income-tax Act 2025; rate (2% starting value) and no-PAN rate
(20%); ₹20,000 threshold; CATCH_UP or EXCESS_ONLY; treatment of a reversal crossing a financial
year; GST on commission (self-invoice / RCM for unregistered dealers). The seeded TDS rows are
**not confirmed**; while TDS is on, an unconfirmed row blocks paying unless an admin overrides.

## Waiting for your accounts

Expo account (EAS) for the Android / iPhone store builds of app 1.7.0; a production sign-in or your
own check of the `customerReferrals` rule on gokesari.com.
