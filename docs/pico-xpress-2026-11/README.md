# Pico Xpress — the gokesari.com delivery partner

Owner brief: 27-Nov-2026 18.04 IST. Built 27-Nov-2026. All times in this folder are IST (UTC+5:30); the
database stores UTC.

Partner documentation (read in full on 27-Nov-2026 18.10 IST):
<https://docs.superhuman.com/d/Integration-Steps_dLqIhtlNdUu/Integration-Steps_suGz7_Uq> — pages 1
Pre-requisites, 2 AWB Generation, 3 Serviceability, 4 Order Manifestation, 5 Tracking Pull, 6 Tracking
Webhook, 7 Location Webhook, 8 Cancel Order. (Pages 9–11, reverse pickup, are not part of this build.)

## What it does

When a shop marks a delivery order ready, the delivery chooser offers **"gokesari.com delivery partner (Pico
Xpress)"** next to pickup, the shop's own delivery and the GoKesari rider — only when the flag is on, the
site has Pico keys, the shop has a GSTIN and map pin, the order has GST on its goods, and Pico says the
pickup and delivery points are serviceable. Otherwise the choice is greyed out with the reason.

Choosing it:

1. saves the plan as the existing `GOKESARI_PARTNER` option with `external_partner = 'PICO'` — the
   GoKesari rider search never starts for it (`fulfilment-guards.ts holdsRiderDispatch`);
2. runs Pico's serviceability check (mandatory) and books the order straight away: AWB(s) from the pool,
   a 6-digit pickup code for the shop and the customer's 6-digit delivery code (consigneeOtp — the order
   completes only when Pico's rider enters it), AGTCI as bill-to, the order's invoice;
3. tells the shop (pickup code) and the customer (delivery code by e-mail and on My Orders).

Pico's tracking webhook then moves the order: DP_ASSIGNED → order ASSIGNED (rider name and phone to shop
and customer), ARRIVED_AT_PICKUP → shop told to hand over against the pickup code, PICKED → PICKED_UP
(cancel no longer possible), OUT_FOR_DELIVERY / ARRIVED_AT_LOCATION → OUT_FOR_DELIVERY (ETA in IST and the
tracking link to the customer), DELIVERED → DELIVERED (COD, finance, shop wallet charge, invoice and
commission exactly as for every delivery), ATTEMPTED_UNDELIVERED → both told with the reason, RTO /
RTO_DELIVERED → order FAILED / RETURNED (refund per the existing failed-delivery policy), LOST / DAMAGED →
order FAILED + a HIGH support ticket + shop, customer and operations told, CANCELLED → synced.

## Design: Pico is an HDMS provider

The repository already had a delivery-provider layer (docs/hdms-2026-11). A Pico shipment is an HDMS
booking (`delivery_bookings`, provider `PICO`, `external_ref` = parent AWB), so the order sync, the
customer's map (`/api/tracking/[orderId]`), the shop wallet's partner delivery charge (at delivery), the
admin booking lists and "cancel the live booking when the order is cancelled" work unchanged. Pico's own
data lives in new tables:

| Table | What |
|---|---|
| `delivery_awb_pool` | AWBs fetched in bulk (≤ 1,000 per call), per environment; AVAILABLE → ALLOCATED → USED / CANCELLED; never reused |
| `delivery_shipments` | the manifest sent (Pico order id, AWB + child AWBs, COD / PREPAID, boxes, weight, pickup type, e-way bill, code nonce) and Pico's state, rider, ETAs, last position |
| `delivery_shipment_events` | every status once (unique AWB + status + time), webhook and pull, payload masked |
| `delivery_location_pings` | live rider positions (paid add-on) |
| `delivery_partner_api_logs` | every call to Pico with keys, phones, OTPs, names and street lines masked |

The brief named the shipment and event tables `delivery_shipments` / `delivery_shipment_events`; they are
those, keyed to the HDMS booking rather than duplicating it.

Code: `src/server/delivery/pico/` (config, client, errors, payload, status, awb-pool, codes, service,
webhooks, webhook-auth, views, admin), `src/server/delivery/providers/pico.ts` (HDMS adapter), migration
`drizzle/0228_pico_xpress.sql` (rollback `scripts/rollback-0228-pico-xpress.sql`).

## Switches and settings

| What | Where | Default |
|---|---|---|
| `delivery_partner_picoxpress_enabled` | Admin → Feature flags | ON on test.gokesari.com, OFF on gokesari.com until the production test |
| `pico_live_location_enabled` | Admin → Feature flags | OFF on both (Pico charges per push) |
| Rule `picoXpress` | Admin → Business rules | AWB refill threshold 200, batch 500; bill-to = AGTCI (legal name, GSTIN 27ABCCA8318D1ZV, Kharadi address); pickup type RETAIL_STORE, per shop type map; default box weight 1,000 g, per shop type map; up to 10 boxes; e-way bill above ₹50,000; PAN-only shops HIDE_OPTION; cancel reasons; webhook IP allowlist (staging 4.187.148.44, production 4.188.191.141, set per site) |

`nonGstShops = USE_AGTCI_GSTIN` sends AGTCI's GSTIN for PAN-only shops. **Switch it only after Pico
confirms in writing** (question 1 below).

## Secrets (environment only — never in code, logs or the database)

| Variable | test.gokesari.com | gokesari.com |
|---|---|---|
| `PICO_BASE_URL` | `https://dev-api.picoxpress.com` | `https://api.picoxpress.com` |
| `PICO_CLIENT_KEY` | Pico staging client key | Pico production client key |
| `PICO_API_KEY` | Pico staging client secret | Pico production client secret |
| `PICO_WEBHOOK_TOKEN` | a random secret we give Pico | a different random secret |

The code refuses Pico production anywhere but gokesari.com and Pico staging on gokesari.com
(`config.ts checkPicoConfig`). Set them on the server (values are typed hidden, never shown):

```bash
ssh -i ~/.ssh/gokesari_db_admin gkadmin@10.66.0.1
sudo gk-site env set gokesari-staging PICO_BASE_URL     # https://dev-api.picoxpress.com
sudo gk-site env set gokesari-staging PICO_CLIENT_KEY
sudo gk-site env set gokesari-staging PICO_API_KEY
sudo gk-site env set gokesari-staging PICO_WEBHOOK_TOKEN   # paste a value made on your Mac with `openssl rand -hex 32`; keep it in your password manager and give it to Pico
sudo gk-deploy restart gokesari-staging
```

(and the same for `gokesari-prod` with `https://api.picoxpress.com` and the production keys).

## Webhooks to register with Pico

| Kind | test.gokesari.com | gokesari.com |
|---|---|---|
| Shipment status (doc page 6) | `https://test.gokesari.com/api/webhooks/picoxpress/shipment-status` | `https://gokesari.com/api/webhooks/picoxpress/shipment-status` |
| Live location (doc page 7, paid) | `https://test.gokesari.com/api/webhooks/picoxpress/location` | `https://gokesari.com/api/webhooks/picoxpress/location` |

Pico's dashboard (Developer → Webhooks) takes only a URL, no header, so the token goes in the URL:
`…/shipment-status?token=<PICO_WEBHOOK_TOKEN>` (and `…/location?token=…`). The code also accepts
`Authorization: Bearer <token>` or `X-GoKesari-Webhook-Token: <token>`. Pico sends from **4.187.148.44**
(sandbox, for test.gokesari.com) and **4.188.191.141** (production, for gokesari.com) — set them in rule
`picoXpress.webhookIpAllowlist` on each site. Token checked in constant time; wrong / missing → 401; other
address → 403; flag off → 404; body over 64 KB → 413; bad JSON → 400; rate limit 600 / minute per IP. The answer is sent at once and the payload is
processed straight after it (not by a cron). A missed webhook is recovered by "Refresh status" (operations)
and by a safety-net pull of live shipments silent for 5+ minutes (every-minute cron, flag on only).

## Rules the code follows

- Every call: HTTPS, 10 s timeout, up to 3 attempts with exponential backoff only for network errors and HTTP
  5xx — never for a `PX_` answer. Success = `responseCode "PX_200"`, whatever the HTTP status.
- Errors are classified by message text as well as code (Pico's own sample answers PX_401 for "not
  serviceable" and PX_402 for "orderId cannot be empty"). Auth and AWB errors alert operations.
- AWBs go back to the pool only when Pico confirms the order was not created; AWBs Pico rejected (PX_406 /
  407) are retired. A timeout keeps the AWB and the booking "not confirmed"; "Book again" re-sends the same
  order id and AWB, and "already exists" counts as booked. Re-booking after a cancel uses `<order>-2`, `-3`.
- Webhooks: tolerant of both field-name sets (`orderStatus` / `shipmentState`, `createdTimestamp` /
  `shipmentCreatedTime`), epoch ms; unknown statuses stored and logged, never rejected; idempotent (AWB +
  status + time); out-of-order safe (never backwards); `statusHistory` replayed to fill missed steps.
- Cancel only while Pico has the shipment as DRAFT or CREATED (checked first; Pico's answer is final). After
  pickup: "Order already picked up — cannot cancel; raise a return or a dispute".
- Money: the shop's share of the delivery (pricing rule) is debited from the shop wallet at delivery, as for
  every partner delivery (`finance.ts walletCollectionFor → partnerDeliveryShopCharge`); nothing is debited at
  booking, so a cancel before pickup has nothing to reverse. The customer's cancellation refund follows the
  existing policy (full refund including the delivery fee before packing).
- DPDP: the rider's number is kept only while the delivery is live; logs and stored payloads have phones
  (last 2 digits), OTPs, keys, names and street lines masked; the two codes are never stored (HMAC of a nonce).

## Mobile apps (Android and iPhone)

The apps are the website in a WebView (mobile/AGENTS.md: "Website features belong in the website … the app
picks them up automatically"). The shop's chooser, pickup code, status and cancel, and the customer's
timeline, rider, delivery code, ETA in IST and map are web pages, so both apps show them with no new build.
Push notifications go through the existing Expo push channel for every `notify()` (rule `push`). The
"Track" link to Pico's page opens in the phone's browser (bridge-script.ts sends taps on outside links
there). No native change was needed, so no store release was made; silent updates are unchanged.

## Questions for Pico Xpress

1. The pickup GSTIN is mandatory. How do we book for shops registered with PAN only? May we send AGTCI's
   GSTIN (27ABCCA8318D1ZV) as the pickup GSTIN for them?
2. What is the webhook retry policy when we do not answer 200? (Answered 27-Nov-2026 by the dashboard: no
   header field, so the token goes in the URL; IPs 4.187.148.44 sandbox, 4.188.191.141 production.)
3. AWBs per bulk call: page 2 says 10,000; is 1,000 a safer limit? (We ask for ≤ 1,000.)
4. Which webhook field names are final — `orderStatus` or `shipmentState`, `createdTimestamp` or
   `shipmentCreatedTime`? The webhook table on page 6 also omits OUT_FOR_DELIVERY and ARRIVED_AT_LOCATION
   (page 5 lists them) — are they sent?
5. Which Pune PIN codes are serviceable in production, and what is the go-live date?
6. Pricing of the live-location webhook (per push / per shipment, frequency).
7. (Found while building) `goodsTaxAmountPaise` must be > 0. Many grocery items (milk, vegetables, grains
   loose) are GST-exempt, so the tax is 0. Will you accept 0 tax for exempt goods? Until then such orders
   cannot use Pico.
8. (Found while building) The e-way bill key: the sample says `ewayBillNo`, the table `ewaybillNo` — which?
   (We send `ewayBillNo`.)
9. (Found while building) Is `pickupSla` needed for instant orders? (We omit it.)

## Rollback

Switch `delivery_partner_picoxpress_enabled` off (the choice disappears; webhooks answer 404; live shipments
stay readable). To remove it completely: cancel live shipments with Pico, deploy the previous release, run
`scripts/rollback-0228-pico-xpress.sql`.
