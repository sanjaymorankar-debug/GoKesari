# Feature 3 — new orders on the shop owner's WhatsApp

Owner brief 22-Nov-2026. Written 22-Nov-2026, 19.00 IST. Branch
`feat/whatsapp-shop-orders-2026-11-22`, migration `0169_whatsapp_shop_orders`.

Each new order reaches the shop's verified WhatsApp numbers at once, with
**Accept** and **Reject** buttons. A tap does exactly what the app does
(`acceptOrder` / `rejectOrder`), the first answer wins, and everyone later is
told who answered first and when. The shop also hears on WhatsApp when the
customer cancels, when a delivery partner is assigned and when the order is
delivered. If WhatsApp fails, the owner gets the alert in the app, by SMS (when
an SMS provider is set up) and by e-mail.

Everything is behind the feature flag **`whatsapp_shop_orders_enabled`**
(Admin → Feature flags; per district). With the flag on but the Meta keys
missing, the feature stays dormant, logs why once
(`[whatsapp-shop-orders] … stays dormant: Missing META_WA_ACCESS_TOKEN.`) and
shows the reason on the log page. The rest of the site is unaffected.

## 1. How it works

| Step | Where |
|---|---|
| Owner opens **My Shop → Orders on WhatsApp** (`/shop/settings/whatsapp`), switches it on, keeps or changes their number (prefilled with the shop's WhatsApp number), ticks the consent box and adds up to 3 staff numbers (rule `whatsappShopOrders.maxStaffNumbers`). Only the shop's owner can do this. | `src/app/shop/settings/whatsapp/page.tsx`, `src/components/shop-whatsapp-settings-form.tsx`, `PUT /api/shops/[id]/whatsapp` |
| Each new number gets the **number check** template. The page shows "Checking — WhatsApp accepted the test message" once Meta accepts it, then **Active on WhatsApp** when Meta reports it delivered or read, or **Not on WhatsApp** when it fails ("Check again" resends). Only active, opted-in numbers get orders. | `src/server/whatsapp/shop-orders/contacts.ts` |
| An order is placed (`order.placed`, wallet / COD at checkout, online after payment). In the same transaction, `emitEvent` writes one `QUEUED` row per active number in `whatsapp_messages` (the outbox). Nothing is sent inside the transaction. | `src/server/events/emit.ts` → `queue.ts` |
| After commit the queue is sent (a timer 1 s and 5 s later; the every-minute cron job `notification-retry` catches anything left). Rows are claimed with `SKIP LOCKED`; one row per (event, number) by a unique key, so nothing is sent twice. | `dispatch.ts` |
| The shop taps **Accept** or **Reject**. Meta posts the tap to the webhook; the signature is checked, the message id is recorded once, and the sender must be a verified number of **that order's shop**. The tap runs `acceptOrder` / `rejectOrder` as the shop's owner, so the customer is told by the existing order events exactly as from the app. | `webhook.ts`, `src/app/api/webhooks/whatsapp/route.ts` |
| Follow-ups: `order.cancelled` by the customer, `order.assigned` (delivery partner), `order.delivered` (the rider's OTP flow says "confirmed with their delivery code (OTP)"). | `queue.ts` (`whatsAppPlanFor`) |
| Admin and operators read the log and the daily figures at **WhatsApp messages** (`/admin/whatsapp-messages`; Settings → More for admins, Order support → More for operators; permission `order:view:any`). | `src/app/admin/whatsapp-messages/page.tsx`, `log.ts` |

### First action wins

- **Accept** goes through `acceptOrder` → `updateOrderStatus`, which locks the
  order row (`SELECT … FOR UPDATE`) and allows `CONFIRMED → ACCEPTED` only once
  (order state machine). A second Accept, from WhatsApp or the app, fails the
  state check.
- **Reject** goes through `rejectOrder(…, { onlyIfStatus: "CONFIRMED" })`
  (new optional argument): `cancelOrder` checks the status under the same row
  lock, so a Reject can never cancel an order someone already accepted.
- The loser gets: *"GoKesari: order DB-… was already accepted by Ramesh Patil on
  WhatsApp (+91 98765 00001) at 22-Nov-2026, 18.53 IST. Nothing was changed."*
  — or *"… by Ramesh Patil in the GoKesari app at …"* when the app was first.
  The decision time comes from `order_status_history`; the WhatsApp tap that
  made it from `whatsapp_order_actions`.
- **Reject reason (decision):** a Reject from WhatsApp uses the fixed reason
  **"Rejected on WhatsApp"** (stored as "Rejected by shop: Rejected on
  WhatsApp"). No follow-up question is asked: a second step would leave the
  order undecided while the shop types, and the customer is refunded in full
  either way. The shop can still reject from the app with its own reason.
- A repeated webhook (same Meta message id) is ignored; a real second tap gets
  the "already …" answer.

### Fallback and log

- A send that Meta refuses (API error), or a later `failed` status from the
  webhook, marks the message `FAILED` with Meta's code and text, logs a warning
  and — rule `whatsappShopOrders.fallbackOnFailure`, on by default — sends the
  owner `shop.whatsapp_failed` through the notification service: in-app, SMS
  and e-mail, **once per order alert** (not once per number).
- Network errors, Meta 5xx and rate limits are retried up to 3 attempts by the
  next run; everything else fails at once (an order alert should not wait).
- A message stuck in `SENDING` for 10 minutes (the process died) is marked
  failed and not resent, so a shop never gets the same alert twice.
- If the flag is switched off (or the keys disappear) while messages are
  queued, they are marked `SKIPPED`, never sent later by surprise.

### Test site

On test.gokesari.com set `WHATSAPP_TEST_RECIPIENT=+919175193009`: **every**
WhatsApp message (number checks, order alerts, replies) goes to that number,
and the log shows the number it was meant for (mirrors `EMAIL_REDIRECT_TO`). A
tap on the test phone counts as the number whose message was tapped (matched
by Meta's `context.id`). gokesari.com **refuses to send any WhatsApp** while
`WHATSAPP_TEST_RECIPIENT` is set (`whatsappMetaConfigProblem`), so a staging
setting copied to production can never send every shop's orders to one phone.

### General notifications

`WHATSAPP_PROVIDER=meta` is used only by this feature. The general
notification channel `WHATSAPP` (prescriptions etc.) stays skipped in this mode:
each of those messages would need its own approved template.

## 2. Environment variables

Keys come from the environment only (`src/lib/env.ts`, checked by
`whatsappMetaConfigProblem`; a wrong value switches WhatsApp off, it never
stops the site).

| Variable | Test site | Production | Notes |
|---|---|---|---|
| `WHATSAPP_PROVIDER` | `meta` | `meta` | `none` (default) / `mock` / `meta` |
| `META_WA_ACCESS_TOKEN` | System User token | System User token | Permanent token (see §5). Never the 24-hour token in production |
| `META_WA_PHONE_NUMBER_ID` | from API setup | from API setup | The numeric **Phone number ID**, not the phone number |
| `META_WA_APP_SECRET` | App secret | App secret | Meta app → App settings → Basic → App secret; signs the webhook |
| `META_WA_VERIFY_TOKEN` | any long random string | another long random string | Typed again in Meta when registering the webhook |
| `META_WA_API_VERSION` | `v23.0` (default) | `v23.0` | Graph API version |
| `WHATSAPP_TEST_RECIPIENT` | `+919175193009` | **must be unset** | Production refuses to send while it is set |

Rule **`whatsappShopOrders`** (Admin → Settings → Rules): template names
(`gk_new_order`, `gk_order_update`, `gk_number_check`), template language
(`en`), `maxStaffNumbers` (3), `fallbackOnFailure` (on). The names must match
the templates approved in Meta exactly.

## 3. Webhook URLs to register in Meta

Meta → the app → WhatsApp → Configuration → Webhook → Edit:

| Site | Callback URL | Verify token |
|---|---|---|
| Test | `https://test.gokesari.com/api/webhooks/whatsapp` | the test site's `META_WA_VERIFY_TOKEN` |
| Production | `https://gokesari.com/api/webhooks/whatsapp` | production's `META_WA_VERIFY_TOKEN` |

Then **Webhook fields → `messages` → Subscribe** (carries both status updates
and button taps). Meta signs each POST with the app secret
(`X-Hub-Signature-256`); a wrong or missing signature is answered 401. A Meta
app has one callback URL (unless a per-number override is set up through the
API), so the simplest set-up is **two Meta apps**, one per site, each with its
own number, secret and verify token.

## 4. Template texts to submit for approval

Submit in WhatsApp Manager → Message templates → Create template. Category
**Utility**, language **English (en)**. Variables are positional; Meta needs a
sample for each. Template variables cannot contain new lines, so the item list
arrives on one line ("Cow Milk 2 L × ₹52.00 = ₹104.00; …").

### 4.1 `gk_new_order` — new order with Accept / Reject

- Category: Utility. Language: English.
- Header (text): `New order on GoKesari`
- Body:

```
New order {{1}} for your shop.

Placed: {{2}}
Customer: {{3}}
Items: {{4}}
Total: {{5}}
Payment: {{6}}
Fulfilment: {{7}}
Delivery area: {{8}}

Open the order: {{9}}

Tap Accept or Reject below. The first answer from your shop counts.
```

- Footer: `GoKesari order alerts`
- Buttons: **Quick reply** `Accept`, **Quick reply** `Reject` (in this order:
  the server sends the Accept payload for button 0 and Reject for button 1).
- Samples: {{1}} `DB-20261122-ABC123` · {{2}} `22-Nov-2026, 18.53 IST` · {{3}}
  `Asha Kulkarni` · {{4}} `Cow Milk 2 L × ₹52.00 = ₹104.00; Curd 1 kg × ₹80.00 = ₹80.00` ·
  {{5}} `₹184.00` · {{6}} `Prepaid (GoKesari wallet)` · {{7}} `Delivery in 30 min` ·
  {{8}} `Kothrud, Pune, 411038 (about 1.8 km from the shop)` · {{9}}
  `https://gokesari.com/shop/orders/0b0d6f6e-1111-4c4c-9a9a-123456789abc`

### 4.2 `gk_order_update` — status update

- Category: Utility. Language: English. No header, no buttons.
- Body:

```
Update on order {{1}}: {{2}}

Open the order: {{3}}

GoKesari order alerts
```

- Samples: {{1}} `DB-20261122-ABC123` · {{2}} `Delivery partner assigned: Vijay. Keep the order ready for pickup.` ·
  {{3}} `https://gokesari.com/shop/orders/0b0d6f6e-1111-4c4c-9a9a-123456789abc`
- The texts the server puts in {{2}}: "Cancelled by the customer: <reason>. Put
  the items back on the shelf." · "Delivery partner assigned: <name>. Keep the
  order ready for pickup." · "Delivered — the customer confirmed with their
  delivery code (OTP)." · "Delivered to the customer."

### 4.3 `gk_number_check` — number check

- Category: Utility. Language: English. No header, no buttons.
- Body:

```
Hello from GoKesari. This WhatsApp number will now receive new orders of {{1}}, with Accept and Reject buttons. No reply is needed.
```

- Sample: {{1}} `Kesari Dairy`

If Meta renames a template on approval, or a different language is approved,
change rule `whatsappShopOrders` to match — no code change.

## 5. Pending on Meta's side (owner action)

None of this can be done from the code; until it is, the feature stays dormant.

1. **Meta Business verification** of GoKesari's business portfolio (Business
   Settings → Security Centre → Start verification): legal name, address,
   GST / incorporation document, a phone or domain check. Unverified accounts
   are limited to 250 business-initiated conversations a day and cannot raise
   that tier.
2. **The phone number**: a number not in use on the WhatsApp or WhatsApp
   Business app (or deleted from it first), added to the WhatsApp Business
   Account, verified by SMS / call code and registered with a two-step PIN; its
   **display name** ("GoKesari") approved by Meta. Its **Phone number ID** goes
   into `META_WA_PHONE_NUMBER_ID`. A second number (or the free test number) for
   the test site.
3. **Template approval** of `gk_new_order`, `gk_order_update` and
   `gk_number_check` (§4), for each WhatsApp Business Account used.
4. **Permanent access token**: Business Settings → Users → System users → add
   an admin system user, assign it the Meta app and the WhatsApp Business
   Account (full control), generate a token with **no expiry** and the
   permissions `whatsapp_business_messaging` and
   `whatsapp_business_management` → `META_WA_ACCESS_TOKEN`.
5. **The Meta app** (type Business) with the WhatsApp product, switched to
   **Live** mode; its **App secret** → `META_WA_APP_SECRET`; the webhook
   registered and subscribed to `messages` (§3).
6. **A payment method** on the WhatsApp Business Account (utility template
   messages are charged per message by Meta).
7. **Test site only, while the app is in development mode**: add
   +91 91751 93009 as an allowed recipient in WhatsApp → API setup (otherwise
   Meta answers error 131030 and every message falls back to in-app / SMS /
   e-mail).

## 6. Data (migration 0169)

`drizzle/0169_whatsapp_shop_orders.sql` (journal idx 169), rollback
`scripts/rollback-0169.sql` (drops only these tables). Schema in
`src/server/db/whatsapp-shop-orders-schema.ts`, re-exported by `schema.ts`.

| Table | Holds |
|---|---|
| `shop_whatsapp_settings` | the shop's on/off (FK shops, cascade) |
| `shop_whatsapp_contacts` | owner and staff numbers, consent, check status (UNCHECKED / CHECKING / ACTIVE / NOT_ON_WHATSAPP) |
| `whatsapp_messages` | outbox and log: kind (NEW_ORDER / STATUS_UPDATE / NUMBER_CHECK / REPLY), template and parameters, intended and actual number, status (QUEUED / SENDING / SENT / DELIVERED / READ / FAILED / SKIPPED), Meta id (unique), error code and text, sent / delivered / read / failed / fallback times |
| `whatsapp_webhook_events` | each webhook item once (`msg:<id>`, `status:<id>:<status>`) |
| `whatsapp_order_actions` | every Accept / Reject tap and its outcome (DONE / ALREADY / REFUSED / ERROR) |

Orders and users are not referenced by foreign key (seller / customer rule);
the services check those links.

## 7. Tests

`tests/integration/whatsapp-shop-orders.test.ts` and
`tests/integration/whatsapp-test-redirect.test.ts` (fetch mocked; Meta is never
called): send on order placed, staff / opt-in / shop switch, flag off, verify
challenge, good and bad signatures, Accept (customer notified), Reject, double
tap and redelivered webhook, two numbers accepting at once, app first,
unverified and other-shop numbers refused, status webhooks, API failure and
webhook failure fallbacks, follow-ups, owner-only settings and the staff limit,
the test-site redirect to +919175193009, production refusal with a test
recipient, and dormancy without keys.

## 8. Not done / limits

- Staff numbers act with the **owner's identity** (the audit shows the owner;
  `whatsapp_order_actions` records which number tapped). `shop_staff` has only
  a CATALOGUE scope today.
- No WhatsApp reminder before the acceptance deadline; the existing in-app
  reminder and auto-cancel (rule `shopAcceptance`) are unchanged.
- No inbound free text or other commands; only the two buttons are handled.
- Delivery to Meta happens a second or so after the order commits (timer); if
  the server restarts in between, the every-minute cron sends it.
