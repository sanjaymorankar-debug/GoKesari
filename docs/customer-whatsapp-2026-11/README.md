# Customer WhatsApp (module 2, owner brief 23-Nov-2026)

Customers get their order updates on WhatsApp (only if they agree), and can shop by chatting:
search, pick, quantity, cart, and a secure link that puts the chat cart into their GoKesari cart.

Everything is behind the feature flag **`whatsapp_customer_enabled` (OFF)**. With it off the site
behaves exactly as before. Meta keys and approved templates do not exist yet, so the whole module
runs end to end in **mock mode** on the test site and is **blocked only on the keys and templates**.

## What existed (reused, not duplicated)

| Piece | Where |
|---|---|
| Meta Cloud API sender | `src/server/notifications/providers/whatsapp-meta.ts` |
| Signed, idempotent webhook | `src/app/api/webhooks/whatsapp/route.ts` → `src/server/whatsapp/shop-orders/webhook.ts` (`whatsapp_webhook_events`) |
| Outbox + log + retries (3 attempts) | `whatsapp_messages` (0169), `shop-orders/queue.ts`, `shop-orders/dispatch.ts` |
| Admin log | `/admin/whatsapp-messages` |
| Mock outbox | `outbound_test_messages` (`WHATSAPP_PROVIDER=mock`), Admin → Test messages |
| Consent record | `user_consents` (append-only), `services/consents.ts` |

Before this module, WhatsApp served only shops (new-order alerts); customer notifications skipped WhatsApp
under `meta`, and non-button inbound messages were logged and dropped.

## Gaps closed

1. **Consent** — new consent type `WHATSAPP_NOTIFICATIONS`. Opt-in/out on *My Profile → Notifications*
   (source `PROFILE`, needs a verified mobile), or by sending **STOP / START** on WhatsApp (source
   `WHATSAPP_KEYWORD`; Hindi/Marathi variants too). Every change is a new row with time + source and is
   audited (`consent.recorded`). Admin → Consents shows the new type.
2. **Customer updates by template** — `notify()` hands each notification to
   `whatsapp/customer/notify-hook.ts`. Mapped types:

   | Update (rule key) | Notifications |
   |---|---|
   | ORDER_PLACED | order.confirmed, order.queued_shop_closed |
   | ORDER_CONFIRMED | order.accepted |
   | PAYMENT_RECEIVED | order.payment_captured |
   | ORDER_STATUS | order.ready, order.assigned, order.picked_up, order.delivery_failed, order.returned_to_shop |
   | OUT_FOR_DELIVERY | order.out_for_delivery |
   | DELIVERED | order.delivered |
   | CANCELLED | order.cancelled |
   | REFUND_ISSUED | order.payment_refunded, order.refund_updated, return.refund_completed, wallet.bank_refund_paid |
   | SUBSCRIPTION_RENEWAL | subscription.renewal_due |

   A row (kind `CUSTOMER_NOTIFICATION`) is queued in the caller's transaction only when: flag on, rule
   `whatsappCustomer.enabled`, a template for that update, a provider (meta or mock), a customer-side link
   (the shop's / rider's copy of a shared notification is never sent), a verified mobile, consent, and the
   customer has not switched WhatsApp off for that category. It is sent after commit by the **shared**
   dispatcher (same retries, log, SKIP LOCKED claiming). Consent is checked again at send time, so a STOP
   after queueing wins. When the template copy is queued, the plain WhatsApp text copy is dropped (no double).
   Shop new-order alerts are unchanged.
3. **Shopping by chat** — `whatsapp/customer/conversation.ts` (pure state machine) +
   `sessions.ts` (table `whatsapp_customer_sessions`: phone, state, context, cart jsonb, PIN, expiry,
   rate-limit window). Commands: product name / `search …` → top results (price, availability, shop) from
   the normal catalogue search limited to shops that deliver to the PIN (saved address PIN for a known
   customer, else asked); number → pick; number → quantity; `cart`; `checkout`; `clear`; `pin 411001`;
   `help`. Meta interactive **list** (results) and **buttons** (quantity 1/2/3) when the provider is Meta;
   plain numbered text otherwise (mock). Rate limit per phone (rule, default 20/min; one "slow down"
   reply, then silence). After STOP nothing is answered except START.
4. **Checkout link** — `checkout` stores the cart in `whatsapp_cart_links` and sends
   `/wa/cart?t=<id>.<expiry>.<HMAC>` (AUTH_SECRET, default 30 minutes, single use). The page shows the
   lines without sign-in; **Add to my cart** (signed in) merges them into the server cart through the
   normal `addToCart` checks (live price, stock, online sale); lines that fail are listed. A link made
   from a known customer's number works only for that account. Guest checkout (#504, not on staging yet)
   can later reuse `loadCartLink()` to fill the guest cart — no change to the link format needed.
5. **Admin** — rule `whatsappCustomer` in Admin → Settings (JSON editor); `/admin/whatsapp-messages` now
   lists customer kinds (filter by kind/status as before), shows the customer switch state, has a
   **Retry** button on failed template messages (`order:update-status:any`, audited
   `whatsapp_message.retried`) and, on the test site only, **Simulate a customer message**
   (`system:config`, audited `whatsapp_inbound.simulated`).
6. **Mock mode** — `WHATSAPP_PROVIDER=mock` (test site): updates and chat replies go to
   `outbound_test_messages` (Admin → Test messages) and the WhatsApp log; templates show as
   `[template <name>] title / text / link`.

## Files

New: `drizzle/0193_customer_whatsapp.sql`, `scripts/rollback-0193.sql`,
`src/server/db/whatsapp-customer-schema.ts`, `src/server/whatsapp/customer/{config,consent,notify-hook,send,conversation,sessions,cart-link,admin}.ts`,
`src/app/api/consents/whatsapp/route.ts`, `src/app/api/whatsapp/cart-link/route.ts`, `src/app/wa/cart/page.tsx`,
`src/components/whatsapp-consent-toggle.tsx`, `tests/unit/whatsapp-customer-logic.test.ts`,
`tests/integration/whatsapp-customer.test.ts`.

Changed: `schema.ts` (consent enum, `user_consents.source`, flag key, re-export),
`whatsapp-shop-orders-schema.ts` (kinds, `user_id`), `config/rules.ts` (rule), `services/feature-flags.ts`,
`components/feature-flags-panel.tsx`, `services/audit.ts`, `services/consents.ts` (source),
`services/notifications.ts` (hook), `providers/whatsapp-meta.ts` (interactive), `shop-orders/dispatch.ts`
(per-kind switches, customer send, `RETRYABLE_KINDS`), `shop-orders/webhook.ts` (customer text routing),
`admin/whatsapp-messages/page.tsx`, `admin/consents/page.tsx`, `profile/page.tsx`,
`tests/integration/consents.test.ts` (new consent type listed), `drizzle/meta/_journal.json`.

## Migration 0193 (additive, re-runnable)

`consent_type` + `WHATSAPP_NOTIFICATIONS`; `user_consents.source`; `whatsapp_messages.user_id` + index and
kind check widened (`CUSTOMER_NOTIFICATION`, `CUSTOMER_REPLY`); tables `whatsapp_customer_sessions`,
`whatsapp_cart_links`; flag row `whatsapp_customer_enabled` OFF. Rollback: `scripts/rollback-0193.sql`
(enum value stays, inert).

## Switches

- Flag `whatsapp_customer_enabled` (OFF): consent switch on profile, chat, updates.
- Rule `whatsappCustomer`: `enabled` (false) for the template updates; `templateLanguage`;
  `templates.<UPDATE>` (empty = not sent); `rateLimitPerMinute` 20; `sessionTtlMinutes` 60;
  `checkoutLinkTtlMinutes` 30; `maxResults` 5; `maxQuantity` 20.
- Env: `WHATSAPP_PROVIDER=meta` + `META_WA_*` for real sends; `mock` on the test site.

## API

- `GET/PUT /api/consents/whatsapp` `{ granted }` — the customer's own choice (404 while flag off).
- `POST /api/whatsapp/cart-link` `{ token }` → `{ added, skipped }` (signed in; 404 while flag off).
- `GET /wa/cart?t=…` — the link page.
- Webhook `POST /api/webhooks/whatsapp` — now also routes customer text / list / button replies.

## Templates to get approved in Meta (all "Utility", 3 body parameters: {{1}} title, {{2}} message, {{3}} link)

`gk_cust_order_placed`, `gk_cust_order_confirmed`, `gk_cust_payment_received`, `gk_cust_order_status`,
`gk_cust_out_for_delivery`, `gk_cust_delivered`, `gk_cust_order_cancelled`, `gk_cust_refund_issued`,
`gk_cust_subscription_renewal`.

## Tests

- `tests/unit/whatsapp-customer-logic.test.ts` — consent gating, template map, chat state machine,
  link signing/expiry, rate-limit window, interactive payload limits.
- `tests/integration/whatsapp-customer.test.ts` — flag OFF, consent gating (profile, rule off, STOP wins at
  send time, START), update through the shared outbox in mock mode, full chat to a used link, link refused
  for another account and on reuse, webhook idempotency, rate limit, admin retry (permissions, audit, kinds),
  simulate.

## Still blocked / open

- **Meta keys and the 9 approved templates** (owner / Meta Business Manager). Until then: mock mode only.
- Webhook URL must also be subscribed in Meta (same URL as the shop alerts — nothing new).
- Guest checkout from the link waits for #504 (guest cart); today the link asks the customer to sign in.
- Hindi/Marathi chat replies are English for now (the profile switch and the link page are in three languages).
- Two messages from one phone at the same instant: the later save wins (no row lock on the session).
