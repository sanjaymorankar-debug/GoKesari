# Help desk, refunds and cancellation after packing (batch 2026-10, WS-C)

## Legal basis for the help desk timelines

**Consumer Protection (E-Commerce) Rules, 2020, Rule 4** (duties of e-commerce
entities) requires an e-commerce entity to appoint a **Grievance Officer**, to
**acknowledge** a consumer complaint **within forty-eight hours** of receipt,
and to **redress** it **within one month** from the date of receipt. The rule
text was checked by the lead for this batch.

What the code does with it:

| Requirement | Where |
|---|---|
| Grievance Officer name and contact, displayed on the site and in the app | Rule `grievanceOfficer` (Admin → Settings); shown on `/legal/grievance-redressal`, `/contact`, `/support`; checked on the compliance dashboard. Empty fields fall back to `LEGAL_ENTITY.grievanceOfficer` in `src/lib/legal-docs.ts`. |
| Acknowledge within 48 hours | Rule `helpdesk.acknowledgeWithinHours` (default 48, cannot be set above 48). Each ticket gets an `acknowledge_by` time when received. |
| Redress within one month | Rule `helpdesk.resolveWithinDays` (default 30, cannot be set above 30). Each ticket gets a `resolve_by` time when received. |
| Breach handling | The hourly job `POST /api/cron/aftercare` stamps each breach once and, with `helpdesk.escalateOnBreach` (default on), escalates the ticket and alerts administrators. |

The SLA clock is **not paused** while a ticket waits for the customer or the
shop: the statutory period runs from receipt.

The Grievance Redressal page keeps its earlier statement (acknowledge within
24 hours and resolve within 15 days, IT Rules 2021 Rule 3(2)) and adds the
Rule 4 commitment. The help desk's default deadlines (48 hours / 30 days) are
the E-Commerce Rules maximums. If the business wants the help desk to enforce
the stricter 24-hour / 15-day guidance, set `acknowledgeWithinHours` to 24 and
`resolveWithinDays` to 15 in Admin → Settings.

**The owner should have counsel confirm** this reading of Rule 4, the IT Rules
interaction and the published wording before relying on it.

## How the pieces fit

- **Tickets** (`support_tickets` and related tables, customer database):
  `OPEN → ACKNOWLEDGED → IN_PROGRESS → AWAITING_CUSTOMER / AWAITING_SHOP →
  RESOLVED → CLOSED`, plus `ESCALATED` and `REOPENED`
  (`src/lib/support-ticket-states.ts`, registered in `src/lib/state-machines.ts`).
- **Raising:** customers at `/support` (or "Get help with this order" on My
  Orders and the order page `/orders/[id]`); shop owners at `/shop/support`.
- **Working:** operators and admins at `/admin/support` (queues, assignment,
  internal notes, canned replies, SLA timers, escalation); admins keep the
  canned replies at `/admin/support/canned-replies`.
- **Shops:** a shop owner sees a ticket about their shop's order only while it
  is `AWAITING_SHOP`, and can reply.
- **Grievances:** the statutory grievance form still issues `GRV-` numbers and
  the grievance register is unchanged; each new grievance also opens a linked
  ticket (rule `helpdesk.ticketForGrievances`) whose status is copied back to
  the grievance.
- **Disputes** keep their own flow (shop + support). A ticket raised on an order
  with a live dispute links to it.

## Refunds and cancellation after packing

- Rule `afterPackingCancellation` (off by default): customers may cancel a
  packed order (Ready / rider assigned) for a fee that the admin sets as default
  and limits, and that a shop may set for itself within those limits
  (`/shop/settings/cancellation-fee`). The fee is shown before the customer
  confirms (`GET /api/orders/[id]/cancellation-quote`) and written to
  `order_charges` and the finance ledger.
- Rule `refundChoice`: the wallet is always available and instant; a refund to
  the original payment method (gateway) is offered for online-paid orders only
  when `originalMethodEnabled` is on (keep it off until a live gateway is
  configured). Every refund is recorded in `order_refunds` with a timeline
  (`order_refund_events`) shown on the order page, and the customer is told of
  each status by email and push.
