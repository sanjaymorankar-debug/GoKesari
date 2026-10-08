# Test checklist — event layer (test.gokesari.com)

Run on the **test site only**. Before starting: migration 0058 applied,
`test-settings.sql` run, cron in **Phase A** (`crontab.test.txt`).

**Accounts you need:** a customer with wallet money, a shop owner (approved
shop with delivery on, verified location), two riders (approved, online, near
the shop), an operator, an administrator. "Support" = every operator and
administrator. "Support lead" = administrators only.

**How to check a notification:** the bell / notifications page of that user
(in-app is instant). Email follows within seconds where the column says so and
SMTP is configured. **How to check the event log:**

```sql
select created_at, type, from_status, to_status, notified
from domain_events where order_id = '<order id>' order by created_at;
```

Every row below should show the event in `domain_events` **within the same
second as the click** — nothing should wait for a cron run.

Legend: ✉ = also emailed by default · 🔕 = in-app only.

## 1. Shop acceptance

| # | Do | Status after | Who is notified (type) | Pass? |
|---|---|---|---|---|
| 1.1 | Customer places an order | Order `CONFIRMED`; `accept_by_at` = now + 30 min | Customer: Order placed ✉ · Shop: New order ✉ | |
| 1.2 | Shop presses **Accept** | `ACCEPTED` | Customer: Order accepted ✉ (`order.accepted`) | |
| 1.3 | Shop presses **Accept** again (double click / second tab) | unchanged | Nobody — the second click gets "Cannot change status from Accepted…" | |
| 1.4 | New order; shop presses **Reject** with a reason | `CANCELLED` → `REFUNDED` | Customer: Order cancelled ✉ with the shop's reason. Wallet back up by the **full total incl. delivery fee**; stock restored | |
| 1.5 | New order; shop does nothing for 15 min | `CONFIRMED` | Shop: "Accept the new order" ✉ (reminder, once) | |
| 1.6 | …and nothing for 30 min (next timeout-sweep run) | `CANCELLED` → `REFUNDED` | Customer: Order cancelled ✉ (reason: not accepted in time) · Shop: "Order cancelled — not accepted in time" ✉ | |
| 1.7 | Set `shopAcceptance.onTimeout` = `ESCALATE`; repeat 1.6 | stays `CONFIRMED`; `accept_escalated_at` set | Support: "Shop has not accepted an order" ✉ · Shop: "Order waiting — support will call" ✉ — **once**, not every minute | |

## 2. Delivery

| # | Do | Status after (order / delivery) | Who is notified | Pass? |
|---|---|---|---|---|
| 2.1 | Shop: Start picking → **Mark ready** | `READY` / `OFFERED` to the nearest rider **immediately** | Customer: Order packed 🔕 + "Finding a rider" 🔕 · Shop: "Finding a rider" 🔕 · Rider A: New delivery offer 🔕 (rider app) | |
| 2.2 | Rider A **declines** | `READY` / `OFFERED` to rider B at once | Shop: "Rider declined — asking the next one" 🔕 · Rider B: New delivery offer 🔕. (Customer is not told about a decline — they hear when a rider accepts.) Customer/shop do **not** get a second "Finding a rider" | |
| 2.3 | Rider B ignores the offer for 2 min | next timeout-sweep: `REJECTED` → offered to the next rider (or search keeps retrying) | Shop: "Rider declined — … did not answer in time" 🔕 | |
| 2.4 | Rider **accepts** | `ASSIGNED` / `ACCEPTED`; pickup code issued | Customer: Rider assigned ✉ · Shop: "Rider on the way to you" ✉ (names the rider) | |
| 2.5 | Rider enters the pickup code | `PICKED_UP` / `PICKED_UP` | Customer: Order picked up ✉ · Shop: Order picked up 🔕 | |
| 2.6 | Rider presses **Start delivery** | `OUT_FOR_DELIVERY`; delivery OTP issued | Customer: "Your order is on the way" ✉ · Shop: Order on the way 🔕 | |
| 2.7 | Rider enters the customer's OTP | `DELIVERED` / `DELIVERED`; earnings credited | Customer: Order delivered ✉ + rate-your-order · Shop: Order delivered ✉ | |
| 2.8 | (new order) After pickup, rider presses **Delivery failed** with a reason | `FAILED` / `FAILED` | Customer: Delivery attempt failed ✉ (with reason) · Shop: Delivery failed ✉ (with reason) | |
| 2.9 | (new order) After a rider accepts, operator cancels the order | `CANCELLED` → `REFUNDED` / `CANCELLED` | Customer: Order cancelled ✉ · Shop: Order cancelled by support ✉ · Rider: Delivery cancelled ✉ | |
| 2.10 | (new order) Mark ready with **no rider online**; wait 30 min | `READY`; search retries on its own | Shop: "Looking for a rider" 🔕 (after attempt 1), "Rider assignment failed" ✉ when the search stops · Support: "No rider for an order" ✉ **once**, at 30 min | |
| 2.11 | Admin reassigns an accepted order | `READY` again, offered to another rider | First rider: Delivery cancelled ✉ · Customer: no "packed" repeat | |

## 3. Live tracking (5-second polling)

| # | Do | Expect | Pass? |
|---|---|---|---|
| 3.1 | Customer, order `ASSIGNED`: **Track delivery** on /orders | Panel opens: "location appears once they set off"; no map yet | |
| 3.2 | Rider picks up (not started) | Panel: "collected your order… as soon as they set off"; no location | |
| 3.3 | Rider presses Start delivery; keeps the app open | Rider's phone posts to `/api/delivery-orders/{id}/location` every ~5 s (browser dev tools → Network). The customer's map shows the rider and moves within ~5–10 s | |
| 3.4 | Shop owner and an operator open tracking for the same order (/admin/orders → Track) | Same live position | |
| 3.5 | Another customer calls `GET /api/tracking/{orderId}` | `403` | |
| 3.6 | Another rider posts to `/api/delivery-orders/{id}/location` | `403` | |
| 3.7 | Rider delivers | Map panel shows "Tracking has ended"; polling stops; the rider's phone gets `sharing: false` and stops posting for that order; nothing more is stored for it | |
| 3.8 | Same as 3.7 for an order cancelled mid-drop | Same | |

## 4. Notifications & retry (N = 4)

| # | Do | Expect | Pass? |
|---|---|---|---|
| 4.1 | Any event above with SMTP working | `notification_deliveries` row `SENT` within seconds (not "next minute") | |
| 4.2 | Break SMTP (wrong password in env) and trigger an emailed event | Row `FAILED`, `attempts` 1; retried at +1 min, +5 min, +30 min by notification-retry | |
| 4.3 | …after the 4th failure | Row `DEAD`; every operator and admin gets "Notifications could not be sent" 🔕 **once per run** | |
| 4.4 | Fix SMTP; admin re-queues the dead row (`POST /api/admin/notifications`) | Row `SENT` | |

```sql
select status, attempts, type, last_error, next_attempt_at
from notification_deliveries order by created_at desc limit 20;
```

## 5. Seller verification (on submission)

| # | Do | Status after | Who is notified | Pass? |
|---|---|---|---|---|
| 5.1 | Seller submits a valid PAN | Document `VERIFIED` in the same request | Seller: "PAN verified" ✉ | |
| 5.2 | Seller submits a number that needs a person (e.g. a Maharashtra Shop Act number) | `MANUAL_REVIEW` | Seller: "… is being reviewed" ✉ · Support: "Seller document to review" ✉ with link to /admin/seller-verification | |
| 5.3 | Operator: **Ask for more info** with a note | `FAILED` (more_info_requested) | Seller: "More information needed for …" ✉ with the note · Other support: "Seller document decided" 🔕 (not the operator who did it) | |
| 5.4 | Operator: **Reject** with a reason | `FAILED` | Seller: "… needs your attention" ✉ with the reason · other support 🔕 | |
| 5.5 | Operator: **Approve** | `VERIFIED` | Seller: "… verified" ✉ · other support 🔕 | |
| 5.6 | Pending shop, fee paid, last mandatory document verified (auto-approve on) | Shop `APPROVED` at once, classification GREEN unless already set | Seller: "Your shop is approved" ✉ · Support: "Shop approved automatically" 🔕 | |
| 5.7 | Same, but fee **not** paid; then record the payment | Stays pending; approved the moment the payment makes the fee PAID | as 5.6 | |
| 5.8 | Leave a document in manual review > 24 h; run seller-verification job | Support: "Seller documents waiting for review" ✉, **once that day** | |

## 6. Disputes

| # | Do | Status after | Who is notified | Pass? |
|---|---|---|---|---|
| 6.1 | Customer, delivered order: **Raise a dispute** with reason, text and 2 photos | Case `OPEN` (or `ESCALATED`/L2 if ≥ ₹2,000) with a `DSP-` number shown at once; photos on the case | Customer: "We are looking into your order — Dispute DSP-…" ✉ · Shop: "Dispute opened on an order" ✉ · Support (or administrators if L2): "New dispute DSP-…" ✉ | |
| 6.2 | Shop opens /shop/disputes → the case → replies with a photo | Comment posted; response clock stops | Customer: "New reply on dispute" ✉ · Support ✉ | |
| 6.3 | Customer replies | Clock starts again | Shop ✉ · Support ✉ | |
| 6.4 | Press **Send** twice quickly | One comment, one set of notifications | |
| 6.5 | Operator leaves an **internal note** | Visible to support only (amber); customer and shop do not see it and are not notified | Other support ✉ | |
| 6.6 | Operator moves the case to Triaged (/admin/disputes) | `TRIAGED` | Customer ✉ · Shop ✉ · other support 🔕 | |
| 6.7 | Shop: **Propose a resolution** | `RESOLUTION_PROPOSED` | Customer: "We have proposed a resolution" ✉ with the text · Support 🔕 | |
| 6.8 | Operator resolves with a refund | `RESOLVED`; wallet credited | Customer: "Dispute resolved" ✉ · Shop ✉ · other support 🔕 | |
| 6.9 | New case; nobody replies for 24 h; dispute-escalation job runs | `ESCALATED`, L2, trigger SLA | Administrators: "Dispute … escalated to you" ✉ · Customer and shop: "…with a senior reviewer" ✉ (no internal note) — **once** | |
| 6.10 | A stranger opens `/disputes/{id}` or a dispute photo URL | 404 | |

## 7. Risk rules

| # | Do | Expect | Pass? |
|---|---|---|---|
| 7.1 | New customer places one order ≥ ₹10,000 | A `HIGH_VALUE_OUTLIER` flag on /admin/risk **straight away**; support: "Risk flag raised" 🔕 | |
| 7.2 | A customer fails 5 wallet top-ups within 24 h | `TOPUP_FAILURES` flag on the 5th failure, not the next hour; support 🔕 once | |
| 7.3 | risk-rules job runs (:17) | Cross-order rules still raise/refresh flags; one summary alert if anything new | |

## 8. Cron safety net (after switching to Phase B)

```bash
for job in timeout-sweep notification-retry; do
  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://test.gokesari.com/api/cron/$job; echo
done   # {"status":"ready"} each
tail -n 5 $HOME/gokesari-cron/logs/timeout-sweep.log   # "errors":[] on every line
```

| # | Check | Pass? |
|---|---|---|
| 8.1 | Re-run 1.6, 2.3, 2.10, 4.2–4.3 with only Phase B installed | |
| 8.2 | `timeout-sweep` log shows `"errors":[]` for an hour | |
| 8.3 | Daily-orders, seller-verification and finance-weekly still run at their times | |

**Sign-off:** all rows pass → switch cron to Phase B (`crontab.test.txt`).
Any failure → note the row and see ROLLBACK.md §1.
