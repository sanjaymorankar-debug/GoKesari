# Seller undertaking: fresh, safe and compliant goods (24-Nov-2026)

> **Wording needs lawyer review before production.** The clauses in
> `src/lib/legal/seller-undertaking.ts` are a plain-language draft.

## What it is

Every shop owner promises:

> I promise never to send expired, stale or non-compliant goods, to always supply fresh goods
> and to always share the expiry / best-before date.

…backed by nine numbered clauses (fresh goods only; never expired / past best-before; expiry /
best-before date on listing and pack; FSSAI / Legal Metrology / Drugs & Cosmetics and other law;
storage and handling; recalls and complaints → replace or refund; GoKesari's remedies — removal of
listings, suspension, chargeback; record keeping; changes need re-acceptance).

The text, version and effective date live in **`src/lib/legal/seller-undertaking.ts`**. It is shown:

- on the **Seller Terms** page (`/legal/seller-terms#seller-undertaking`), with version and effective date;
- on the onboarding wizard's **Payment** step (two unticked boxes: Seller Terms + undertaking; "Create my
  shop and pay" stays disabled until both are ticked; the server refuses the submit otherwise);
- on the old Module 3 join form (`/api/shop-registrations` now also requires `acceptUndertaking: true`);
- as a **full-page acknowledgement** instead of Seller Central (`/shop/…`) while the gate flag is on and the
  owner has not accepted the current versions.

## Records

Acceptance is stored in `user_consents` (append-only):

| consent_type | version |
|---|---|
| `SELLER_GOODS_UNDERTAKING` | `SELLER_UNDERTAKING_VERSION` |
| `SELLER_TERMS` | `SELLER_TERMS_VERSION` |

with `ip_address`, `user_agent` and `shop_id` (migration `0209`). One row per type **per shop the owner
owns** (the evidence names each business it covers); an owner with no shop gets one row per type without a
shop. `created_at` is a `timestamptz` (an absolute UTC instant); every screen shows it in IST. The admin
consent record (`/admin/consents`) lists both types, each counted against its own current version.

An owner "has accepted" when the **latest** row of each type is a grant for the current version
(`hasAcceptedCurrentSellerUndertaking`, `src/server/services/seller-undertaking.ts`).

## Flag: `seller_undertaking_gate_enabled` (seeded OFF)

Admin → Feature flags. May be limited to districts (by the shop's PIN).

- **On:** an owner without the current versions sees the acknowledgement on every Seller Central page
  (registration pages `/shop/register`, `/shop/join` excepted), and their shops **cannot accept new orders**
  (CONFIRMED → ACCEPTED / PREPARING, in `updateOrderStatus` — so the app, the API and WhatsApp's Accept
  button are all covered). The refusal is a 409 that says to open Seller Central (`/shop`) and accept.
  Orders already accepted carry on: picking, ready, dispatch and delivery are not checked. Checkout is not
  blocked: a customer can still order; the order waits for the shop (and the usual not-accepted-in-time
  rule applies).
- **Off:** nobody is asked and nothing is refused. New registrations still record both consents.

API: `GET /api/seller/undertaking` (status) and `POST /api/seller/undertaking` with
`{ "acceptUndertaking": true, "acceptTerms": true }` — both must be the literal `true`; 401 for a guest,
403 for a user who owns no shop, 422 without both ticks.

## Changing the wording (bump the version)

1. Edit the clauses in `src/lib/legal/seller-undertaking.ts`.
2. Set `SELLER_UNDERTAKING_VERSION` (and `SELLER_UNDERTAKING_EFFECTIVE_DATE`) to the new date. For a change
   to the Seller Terms page, bump `SELLER_TERMS_VERSION` too.
3. Deploy. With the flag on, every owner is asked again on their next Seller Central visit and their shops
   accept no new orders until they do. No migration is needed.

A typo fix that should not ask anyone again: leave the version alone.

## Interplay with the policy re-consent gate (PR #530)

PR #530 (`policy_reconsent_enabled`) adds a general re-consent gate for the Terms, Privacy Policy and
Seller Terms for every signed-in user, using its own tables (`policy_versions`, `policy_acceptances`). This
feature is separate: its own flag, its own consent types in `user_consents`, and it also blocks order
acceptance. Both PRs started at migration number 0187; this one is now **0209** — renumbered each time another migration lands first (file
name, journal `idx`/`tag`, `when` after the other). If both flags are on, an owner may be asked to accept the
Seller Terms twice (once per gate) until the two are joined.

## Rollback

`scripts/rollback-0209.sql` (drops the two columns, the index and the flag row; enum values stay, inert).
