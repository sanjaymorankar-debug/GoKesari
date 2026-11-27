# Flow spec v3 — wave 4 (F7, F21, F8, F10, F9, F22, F12)

Built 27-Nov-2026 on `feat/flows-v3-wave4` (from `origin/staging`). Every new behaviour sits behind a new feature
flag; with the flag off the site behaves exactly as before.

| Flag | Area | Seeded by |
|---|---|---|
| `flow_f7` | F7 franchise | migration **0224** — ON on the staging database (`gokesari_test`), OFF everywhere else |
| `flow_f8` | F8 team lead / agent | same |
| `flow_f9` | F9 recurring commission | same |
| `flow_f10` | F10 franchise renewal and tail | same |
| `flow_f12` | F12 referral codes | same |
| `flow_f21` | F21 zone booking hold | same |
| `flow_f22` | F22 commission hold, GST, clawback | same |

Switch them in Admin → Feature flags (a reason is required; every change is logged).

Owner policy kept as is: free dealer 20% one-time on the shop fee (Free v3, 12 months, no monthly, no team share);
20/4/3 only on the TIERED model; paid franchise 25% own shop, 20/4/3 team, recurring 20% of GoKesari's order
commission + bonus up to 5%; launch fee per zone for the first 25; payouts on the 5th; no commission on shop
renewals; settlement hold 3 days. No existing rule default and no existing dealer's frozen rate is changed.

## Migration 0224 (`drizzle/0224_flows_v3_wave4.sql`)

Additive only, safe to re-run:

- `dealer_payout_batches`: new columns `gst_paise` (default 0), `gst_rate_bp` (default 0), `gst_invoice_id`
  (nullable) — every existing payout reads as before;
- new table `dealer_commission_invoices` (one per payout: unique `batch_id`, unique `invoice_number`);
- new table `dealer_commission_invoice_counters` (gapless number per prefix and financial year);
- the seven flag rows (`ON CONFLICT DO NOTHING`).

Rollback: `scripts/rollback-0224-flows-v3-wave4.sql`. If the staging queue renumbers the migration, the content
stays the same.

## Rule `franchiseFlowsV3` (Admin → Rules; each value used only while its flag is on)

| Value | Default | Used by |
|---|---|---|
| `holdGraceMinutes` | 2 — DEFAULT, confirm | F21: a slot held for a payment is released this long after the 15-minute hold |
| `tailCapYears` | 3 (owner) | F10: commission after a lapse stops this long after the first start |
| `commissionHoldDays` | 3 (owner: return window + 1 day) | F22: an entry becomes payable this long after it is earned |
| `commissionGstRateBp` | 1800 — DEFAULT, confirm with the CA | F22: GST on a GST-registered dealer's commission |
| `commissionSac` | 996111 — DEFAULT, confirm with the CA | F22: service code on the commission invoice |
| `commissionInvoicePrefix` | GKC — DEFAULT, confirm | F22: invoice numbers `GKC/2627/000001` |

The reservation hold itself stays the franchise setting `reservationHoldMinutes` (15).

## F7 — franchise (`flow_f7`)

| # | What it does | Where |
|---|---|---|
| 1 | **No shop, no franchise.** Every paid booking needs a live registered shop of the buyer — with or without a subscription plan — at reserve and again at payment (`SHOP_REQUIRED`, the shop registration path). Admin test-zone bookings are exempt. Off: only plan bookings are checked. | `franchise/booking.ts` (`reserveZones`, `startBookingPayment`) |
| 2 | **Renewal without PAN.** A franchise bought on a plan (onboarding v2) renews without a PAN; PAN and a verified bank are still needed before the first payout (existing payee checks). The renewal runs for the plan's own term (snapshotted on the booking). Off: PAN asked; the configured validity. | `booking.ts` (`startRenewal`, `startBookingPayment`, capture `RENEWAL`) |

Verified, unchanged: free dealer live at once with no approval (onboarding v2); paid franchise live on payment
for plan bookings; max 2 franchises a zone (`maxOwnersPerZone`, unique slot indexes).

## F21 — zone booking hold (`flow_f21`)

| # | What it does | Where |
|---|---|---|
| 1 | **One hold per dealer.** A dealer with a new booking held or being paid (until its hold + grace) cannot reserve another; serialised by the existing launch lock. Message names the hold's end. | `reserveZones` |
| 2 | **Hold really 15 minutes.** The gateway order is opened to end with the hold (the gateway's own minimum applies — Cashfree 16 minutes); the hold is no longer moved to the gateway order's time. A slot whose payment is still open is released at hold + `holdGraceMinutes` (franchise job, and under the lock whenever someone reserves the zone); the booking stays open for a payment that is already on its way. | `startBookingPayment`, `releaseHeldPaymentSlots`, `franchise/jobs.ts` |
| 3 | **Countdown and "on hold".** The waiting-for-payment card on `/franchise/my` and `/franchise/start` shows a live countdown; zone cards show "N on hold" and a held, full zone says "On hold" instead of "Sold out". `ZoneView.held` is a new field. | `components/franchise/hold-countdown.tsx`, `zone-booking.tsx`, `franchise/zones.ts` |
| 4 | **Late payment, slot still free → confirmed.** If its own slot number was taken, the zone's other slot is taken when free (max 2 a zone). | capture (`onFranchiseFeeCaptured`, `retakeAnyFreeSlot`) |
| 5 | **Late payment, slot taken → automatic refund.** The refund is recorded through the payments refund path (`refundPaymentIntent`, one per booking) in the capture transaction and sent to the gateway after the commit (the payments reconciliation job retries it). All zones lost: full amount, booking `REFUNDED`, coupon released. Some lost: per lost zone (its fee less its coupon share, plus GST), the rest goes live. The admins get a `payment.attention` alert; the buyer is told. A renewal paid after the franchise ended is refunded in full the same way. Off: the booking is marked "refund due" for an admin, as before. | capture, `refundLostSlots`, `lostSlotsRefundPaise` |

## F10 — renewal and tail (`flow_f10`)

| # | What it does | Where |
|---|---|---|
| 1 | **3-year cap.** The tail (commission on the owner's shops after a lapse) ends at most `tailCapYears` after the franchise first started — a renewal does not start a new 3 years. The tail never ends before the paid term (a franchise still paid up keeps earning). Applied at purchase and at each renewal. Off: 2 years after the last expiry. | `flows/wave4.ts` (`cappedTailEnd`), capture |

Verified, unchanged: free dealer one-time commission stops 12 months after the dealer's scheme start
(`schemeExpired`, Free v3 `validityMonths: 12`); no tail for free dealers; reminders 30 / 15 days then daily.

## F9 — recurring commission (`flow_f9`)

One earner per shop and moment, whole share (no 50/50 split):

1. a shop of a franchise's team (`franchise_shop_attributions`, referral-move periods): that franchise, while
   active or in its tail (unchanged);
2. the owner's **own** shop in **any** area — registered with his codes once his franchise was live: his franchise
   in the shop's zone, else his earliest franchise;
3. any other shop of a zone: the zone's **first** franchise (earliest live) among those active. A second buyer
   inherits nobody's shops, later free-dealer shops included. DEFAULT – confirm: when the first franchise lapses,
   the next-earliest active franchise of the zone takes those shops over.

When a second franchise is bought in a zone that already has a live one, the buyer's earlier free-dealer shops are
not attached to him (they stay with the first). Franchises sold after the first 25 get the same recurring rate as
the launch offer: the recurring base is `recurringBaseBp` for every franchise (`postLaunchRecurringBp` is not used).
Where: `franchise/commission.ts` (`f9Context`, `f9EarnerAt`, `calculateAllocationMonth`), `booking.ts`
(`attachUpgradeShops`).

## F22 — commission hold, tax and clawback (`flow_f22`)

| # | What it does | Where |
|---|---|---|
| 1 | **Held 3 days.** At the month close an entry earned less than `commissionHoldDays` ago is neither auto-approved nor paid; it goes into the next month's payout. Reversals (clawbacks) are always netted. | `dealers/monthly-payout.ts`, `flows/f22-commission.ts` |
| 2 | **Clawback on a gateway refund.** A registration fee (or onboarding v2 draft fee) refunded in full through the payment gateway reverses the commission of everyone in the chain, as a refund recorded by hand does. A part refund keeps the commission (DEFAULT – confirm). | `payments/intents.ts` (`settleRefund`), `clawBackShopFeeRefund` |
| 3 | **GST and invoice.** A dealer with a valid GSTIN gets GST added to his own monthly payout (CGST + SGST in GoKesari's state, else IGST; rate from the rule, to be confirmed by the CA) and a commission invoice issued for it (GoKesari as recipient, numbered per financial year). Team members and payouts grouped across roles by one PAN get no GST. TDS is unchanged (on the commission, rates admin-configured). Net = gross + GST − TDS everywhere the transfer amount is used (auto payout, mark paid, reports). | `monthly-payout.ts`, `f22-commission.ts`, `auto-payout.ts`, `commission.ts`, `payout-reports.ts` |
| 4 | **Statement.** The CSV adds "gross before reversals", "reversals (clawback)" and "GST added"; the e-mail names the GST. | `monthStatementCsv`, `sendMonthStatements` |

Verified, unchanged: payouts on the 5th stay drafts for an admin (`dealerAutoPayout` off; when on, a second admin
approves); recovery of reversals from the next payout and negative balances carried forward; TDS rule
`dealerPayoutTds` stays off until the CA confirms.

## F8 — team lead / agent (`flow_f8`)

| # | What it does | Where |
|---|---|---|
| 1 | **Downgrade moves the agents.** Changing a team lead to an agent moves his active agents in the same step to the team lead given (`agentsTo` on `POST /api/team`, action `downgrade`) or to the dealer, each with its mapping history, role history, audit and notice. Off: refused until they are moved by hand. | `onboarding-v2/team.ts` (`downgradeToAgent`), `app/api/team/route.ts` |

Verified, unchanged: 20/4/3 for TIERED teams (`accrueTieredActivation`; rule `dealerTieredCommission`); invite link
for a customer not yet in the team (`/team/join/<token>`).

## F12 — referral codes (`flow_f12`)

| # | What it does | Where |
|---|---|---|
| 1 | **A code for every account.** Listing an account's codes (Refer and share pages) makes its customer code and a code for each of its live shops (while shop referrals are on) when missing. Dealer, team and franchise codes are made at approval, as before. Sharing by WhatsApp / SMS / e-mail is unchanged. | `services/referral-links.ts` (`myReferralCodes`, `ensureOwnCodes`) |

Referral link to sign-up is wave 1 (F1).

## Not built (and why)

- One-time 25% for a franchisee's own shops outside his paid zone — not in the owner's wave-4 decisions (Model B
  stays zone-based).
- GST input-credit journal posting for commission invoices — the accounting posting carries gross and TDS only;
  the invoice table holds the GST for the CA.
- GST for team members — no GSTIN is kept for them.
- Manual payout drafts (admin "create payout") — no hold and no GST; the monthly close is the path on the 5th.
- Form 16A generation and switching TDS on — waits for the CA (rates stay admin-configured).
- Reusing the shop's payout bank for the dealer row — not in the owner's decisions.

## Tests

`tests/integration/flows-v3-wave4.test.ts` — each item with its flag on and off, on the in-process sandbox gateway
(hold expiry, late payment with free / other / lost slot, full and pro-rata refunds, tail cap after renewal, F9
attribution, downgrade, codes, commission hold, GST and invoice, clawback).
