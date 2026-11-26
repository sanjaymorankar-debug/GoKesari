# Flow spec v3 — wave 1 (F1, F14, F17)

Built 27-Nov-2026 on `feat/flows-v3-wave1` (from `origin/staging` 3775b2bf). Every new behaviour sits behind a
new feature flag; with the flag off the site behaves exactly as before.

| Flag | Area | Seeded by |
|---|---|---|
| `flow_f1` | F1 sign-up and verification | migration **0221** — ON on the staging database (`gokesari_test`), OFF everywhere else |
| `flow_f14` | F14 shop wallet | same |
| `flow_f17` | F17 support and admin review | same |

Switch them in Admin → Feature flags (a reason is required; every change is logged).

## Migration 0221 (`drizzle/0221_flows_v3_wave1.sql`)

Additive only, safe to re-run:

- new table `support_routing_rules` (category, district code — nullable = every area, user, active) with a unique
  index on (category, district, user);
- `support_tickets`: new nullable columns `source`, `source_ref`, `cc_dealer_user_id`; partial unique index on
  (`source`, `source_ref`) where `source` is set; index on `cc_dealer_user_id`;
- the three flag rows (`ON CONFLICT DO NOTHING`).

No drops, renames, type changes or data changes. Seller and customer tables still have no foreign keys between
them; the new columns follow that rule.

## F17 — support and admin review (`flow_f17`)

| # | What it does | Where |
|---|---|---|
| 1 | **Auto-assign.** A new ticket (customer / shop owner, staff-raised, grievance-linked or system) goes to a person named in Admin → Support → Routing (`/admin/support/routing`, API `/api/admin/support-routing`) for its category and the district of the ticket's shop (from the shop's PIN code). Exact district beats state, which beats "every area"; among the people of the best match the one with the fewest live tickets gets it. Only people who can still work tickets are picked. No match: the manual queue, as before. Auto-assignment is not counted as the first response. | `src/server/aftercare/ticket-routing.ts`, `support-tickets.ts` (`afterTicketOpened`), `rbac-support/desk.ts` |
| 2 | **Area dealer copied.** A ticket about a shop is copied to the dealer the shop is attributed to (`shop_attributions`, ACTIVE): the dealer can read it (access `DEALER`, no reply / files / status changes), sees it under their tickets and gets a notice. | `ticket-routing.ts`, `support-tickets.ts` (`ticketAccess`, `listMyTickets`) |
| 3 | **System tickets.** `openSystemTicket(kind, sourceRef)` opens one ticket per event (idempotent on `source` + `source_ref`): GST / PAN check failed or sent to review (`GST_PAN_CHECK`), other shop document checks (`SHOP_DOCUMENT_CHECK`), identity check sent to review (`IDENTITY_REVIEW`), payment not reconciled with the gateway (`PAYMENT_MISMATCH`), order dispute opened (`DISPUTE_OPENED`), delivery code locked (`DELIVERY_CODE_LOCKOUT`). Called after the original flow has saved its work; it never throws, so that flow is unaffected. | `system-tickets.ts`, `system-ticket-hook.ts`; call sites in `seller-verification.ts`, `identity-verification.ts`, `payments/settlement.ts`, `disputes.ts`, `delivery-otp.ts` |
| 4 | **Shop-owner topics.** The shop owner's ticket form adds General, Product upload and Price update. The service accepts them only from a shop owner and only while the flag is on (no database constraint lists categories). | `lib/support-ticket-states.ts`, `app/shop/support/page.tsx`, `api/support/tickets` |
| 5 | **First response in working hours.** The acknowledge-by deadline is `firstResponseWorkingHours` working hours after receipt (India time, working days and hours from the rule), never later than the statutory help-desk deadline. A miss is escalated by the existing hourly help-desk job. | `lib/working-hours.ts`, `support-tickets.ts` (`slaDeadlines`, `runHelpdeskSlaSweep`) |
| 6 | **Reopen.** The requester may reopen a resolved **or closed** ticket within `reopenWithinDays` of its resolution. Off: resolved tickets only, rule `helpdesk.reopenWithinDays` (unchanged). | `support-tickets.ts` (`reopenWindow`, `moveTicket`) |
| 7 | **Society applications** open an operator review ticket (`SOCIETY_REVIEW`). | `services/societies.ts` |
| 8 | **Account recovery.** Public form `/account/recover` (API `POST /api/account/recover`, multipart) for people who lost both mobile and e-mail: name, contact e-mail / phone, the account's old mobile or e-mail, what happened and an identity document (photo or PDF, same file checks as ticket files). Opens an ACCOUNT ticket (`ACCOUNT_RECOVERY`) with the document as a staff-only file; support checks it and makes any change through the existing admin screens. Limited per address per hour. 404 while the flag is off. | `aftercare/account-recovery.ts`, `app/account/recover`, `api/account/recover` |

### Rule `supportFlows` (Admin → Rules; used only while `flow_f17` is on)

| Setting | Default |
|---|---|
| `autoAssign` | true |
| `ccAreaDealer` | true |
| `firstResponseWorkingHours` | 4 — **DEFAULT – confirm with Sanjay** |
| `workingDays` | Mon–Sat (`[1,2,3,4,5,6]`) — **DEFAULT – confirm with Sanjay** |
| `workdayStartHour` / `workdayEndHour` | 10 / 19 (IST) — **DEFAULT – confirm with Sanjay** |
| `reopenWithinDays` | 7 — **DEFAULT – confirm with Sanjay** |
| `recoveryPerIpPerHour` | 3 — **DEFAULT – confirm with Sanjay** |

Other choices to confirm (**DEFAULT – confirm with Sanjay**): the category each system ticket is filed under
(GST/PAN and documents → Shop verification, identity and recovery → Account, payment → Refund or payment, dispute
→ Order, delivery code → Delivery, society → Something else); public holidays are not part of the working
calendar; a dealer copied on a ticket only reads it.

No existing rule default was changed.

## F14 — shop wallet (`flow_f14`)

| # | What it does | Where |
|---|---|---|
| 9 | A shop registered through onboarding v2 gets its prepaid shop wallet at once (zero balance, idempotent). Off: created on first use, as before. | `onboarding-v2/shop-flow.ts` (`afterV2ShopCreated`) |
| 10 | `/shop/wallet` shows "Download this month (CSV)": `GET /api/shops/<id>/wallet/statement?period=YYYY-MM`, the same wallet statement as Accounts → Statements, without needing `billing_v2`. Owner or finance staff. 404 while the flag is off. | `api/shops/[id]/wallet/statement`, `app/shop/wallet/page.tsx` |

## F1 — sign-up and verification (`flow_f1`)

| # | What it does | Where |
|---|---|---|
| 11 | Rider application (`POST /api/delivery-partner`) and every `/delivery-partner` page need a verified mobile AND e-mail (`dual_auth` must also be in force). A one-factor account gets 403 `NEEDS_SECOND_FACTOR` (action `RIDER`) or is sent to `/account/verify` and back. | `dual-auth/policy.ts` (`assertRiderDualVerified`, `riderDualVerifyRedirect`), `app/delivery-partner/layout.tsx` |
| 12 | Google and e-mail-link sign-ups: the sign-in buttons submit the Terms tick; the server keeps it in the signed onboarding-v2 terms cookie and, when the account is created, writes it as the consent record (`user_consents` source `SIGNIN_PAGE` + `policy_acceptances` for terms and privacy policy, with channel, time and version). A sign-up finished on another device (link opened elsewhere) is recorded the usual way. | `server/flows/signup-terms.ts`, `server/auth.ts`, `app/signin/page.tsx`, `app/shop/register/sign-in-card.tsx`, `components/signin-consent.tsx` |
| 13 | A referral link (`/r/<code>`) opened by a signed-out visitor goes to `/signin?ref=<code>` (code also kept in the cookie) instead of the onboarding-v2 home page. Shop-owner codes and signed-in visitors are unchanged. | `app/r/[code]/route.ts` |

APIs stay backward compatible: only new endpoints and new optional fields (`ticket.source`, `sourceRef`,
`ccDealerUserId`; the sign-in buttons' `acceptedTerms` form value).

## Tests

`tests/integration/flows-v3-wave1.test.ts` — 21 tests, each item with its flag ON and OFF. Existing suites run
alongside (help desk, staff support desk, dual auth, societies, referrals, delivery partners, shop wallet and
delivery code, wallets, onboarding v2, disputes, support services, feature flags, grievances, identity and seller
verification, payment settlement, cron schedule).

## Not in wave 1

Gateway fee per payment, next-working-day settlement, rider COD handed to the shop, low-balance default (₹500),
the "no one-factor account" question and the commission-rate data check stay for later waves or owner decisions
(audit build list items 7, 8, 9, 11, 13, 18).
