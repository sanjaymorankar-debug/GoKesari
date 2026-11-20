# Consultant appointments — Phase 0 code review and gap report

**Date:** 20-Nov-2026, 10.11 IST · **Brief:** owner prompt of 20-Nov-2026, 09.37 IST · **Code reviewed:** `origin/staging` at `f1fb3c7a` (PR #422)

## 1. What the brief assumed, checked against the code

| Brief says | Code says | Source |
|---|---|---|
| Postgres (Neon / local) | PostgreSQL 18, one database per site (`DATABASE_URL`); production DB now on our own VPS (gk-db-1), not Neon | `src/server/db/index.ts`, CLAUDE.md, memory 16/17-Nov |
| "The seller and customer databases are separate" | **Not true any more.** The split was removed on 02-Nov (test) and 04-Nov (prod). One database, no postgres_fdw. Seller ↔ customer tables still have no foreign keys between them. | CLAUDE.md "One database", `docs/db-fdw-removal-2026-11/` |
| Registration, fee, referral toggle, GST/PAN auto-verification, payment-based auto-approval | Yes: onboarding wizard (identity first), turnover-slab fee, referral code, Sandbox.co.in KYC, `onShopRegistrationFeeCaptured` → auto-approval | `src/server/registration`, `src/server/services/operator-limited.ts`, `src/lib/registration-fee.ts` |
| KYC / legal documents by type | Yes, by **shop type**: FSSAI (food), drug licence (pharmacy), medical registration (doctor / clinic), professional registration (CA/CS/advocate office) with grace period | `src/lib/shop-licences.ts`, `src/lib/legal-documents.ts`, rule `legalDocuments` |
| Wallets | Customer wallet + **shop wallet** (prepaid; commission and delivery charges debited) | `src/server/services/shop-wallet.ts` |
| Flat 2% per-order commission | `commission_rates` (DEFAULT / SHOP_TYPE / SHOP, basis points); settlement through weekly **payout cycles** (`payout_cycle_lines`, `financial_adjustments`) | `src/server/services/finance.ts`, `src/server/payouts/cycle.ts` |
| Google Maps "Nearby" with distance | Yes: Haversine in SQL from shop lat/long (no PostGIS, no Google call), radii 1/3/5/10 km, directions link | `src/server/services/nearby-shops.ts`, `src/lib/geo/nearby.ts` |
| Real-time notifications | `notify()` writes in-app + e-mail + push (Expo) **at the moment of the event**. There is **no live in-app stream** (no SSE / websocket): the bell refreshes on navigation; push is the live channel on phones. SMS / WhatsApp providers are stubs. | `src/server/services/notifications.ts`, `src/server/notifications/*` |
| 4 role screens, Theme 1 Tile Board | Yes: `src/lib/board/menus.ts` (Customer, Shop, Admin, Operator), tile limits enforced by `tests/unit/tile-board.test.ts`; the shop board is **already at its 16-tile maximum** | `docs/tile-board-2026-10/README.md` |
| Android and iOS apps with auto-update | Expo **WebView shell** around the website (production / preview builds); push via Expo tokens; native update check against `/api/app/version`. **No OTA.** Any new website page appears in the apps immediately. | `mobile/AGENTS.md`, `mobile/app.config.ts` |

## 2. Consultant / professional firm types today

- Shop types already include professional practices: `PROFESSIONAL_OFFICE`, `CONSULTANT`, `DOCTOR_CLINIC`, `SUPER_SPECIALITY_CLINIC` (`isProfessionalShopType`: no delivery, "practice" wording). Added 26-Oct-2026.
- Shop **categories** for professionals were seeded in 0098 (CA, CS, CMA, tax/GST, advocate, notary, 16 medical specialities, management / IT / HR consultants, architect, interior designer, coaching …).
- **No appointment, slot, calendar or booking logic exists anywhere** (no table, service, route or screen). Delivery slots (`delivery_slot_capacities`) are for goods delivery only.

## 3. Need by consultant type

| Type | In person | Video | Phone | Home visit | Team / firm | Group | Prepaid fee usual | Registration to check |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| Doctor (GP, specialist) | ✔ | ✔ | – | rare | clinic with several doctors | – | often pay at visit; advance for video | Medical Council |
| Dentist | ✔ | – | – | – | multi-chair clinic | – | advance for procedures | Dental Council |
| Psychologist / counsellor | ✔ | ✔ | ✔ | – | ✔ | family sessions | prepaid | RCI / Medical Council |
| Physiotherapist | ✔ | – | – | ✔ | ✔ | classes | prepaid / at visit | State council |
| Advocate / lawyer | ✔ | ✔ | ✔ | – | law firm (partner + associate together) | – | prepaid consultation | Bar Council |
| CA / tax / GST consultant | ✔ | ✔ | ✔ | – | CA firm | – | prepaid or free first call | ICAI |
| Company secretary | ✔ | ✔ | ✔ | – | ✔ | – | prepaid | ICSI |
| IT consultant | – | ✔ | ✔ | ✔ (on-site) | agency team | workshops | prepaid / advance | – |
| Architect / interior designer | ✔ | ✔ | – | ✔ (site visit) | ✔ | – | advance | Council of Architecture (architects) |
| Tutor / coach | ✔ | ✔ | – | ✔ | – | ✔ batches | prepaid | – |
| Salon / spa / wellness | ✔ | – | – | ✔ | several stylists | – | at visit; advance for packages | – |
| Repair / home-service expert | – | – | ✔ | ✔ | team visit (2 technicians) | – | visit charge in advance or at visit | – |
| Fitness / yoga trainer | ✔ | ✔ | – | ✔ | – | ✔ classes | prepaid | – |

Conclusion: every type needs individual appointments; firms need "any available member" and multi-member slots; classes, workshops and family consultations need group capacity; fees need all of free, fixed, advance + balance, and pay at visit.

## 4. Reuse, extend, new

| Area | Reused as is | Extended (additive) | New |
|---|---|---|---|
| Onboarding | Shop registration (fee, referral, GST/PAN, auto-approval, seller documents), operator-limited on-behalf onboarding with owner consent | New built-in shop type **Consultant / Professional Firm** | Booking profile, team members, member registration certificates |
| Categories | – | – | Admin-managed `consult_categories` (seeded 28: doctors, legal/finance, business/IT, home & design, learning & wellness, home services) with required registration, SAC code, commission % |
| Calendar | – | – | Weekly hours (several sessions/day), slot length, buffer, people per slot, booking window, notice, leave / holidays / blocks / extra hours |
| Double booking | Row locking pattern | – | Postgres **exclusion constraint** (`btree_gist`) on member + time range, plus member row locks and a 10-minute payment hold |
| Payments | Payment intents, gateways (UPI/cards/net banking), webhooks, reconciliation, refunds API, sandbox page | New purpose `CONSULT_BOOKING` (capture + failure handlers) | Advance/balance logic, late-capture refund, policy refunds |
| Commission / settlement | `financial_adjustments` → weekly payout cycle | – | Per-category commission (default 2%), incremental settlement per booking |
| Invoices | – | – | Receipt / GST tax-invoice series per firm and financial year (fees GST-inclusive) |
| Notifications | `notify()` (in-app, e-mail, push), scheduled-notices sweep | New category **Appointments**, CONSULT_REMINDER branch | Event messages for both sides; 24 h / 1 h reminders |
| Disputes | Help-desk tickets | Ticket category `BOOKING` | Booking ↔ ticket link |
| Completion | Delivery-OTP pattern | – | 4-digit completion code (HMAC, never stored) |
| Files | AES-GCM `encryptBytes`, document-type sniffing | – | Encrypted booking files and certificates, 5-minute signed links, access log |
| Nearby | Haversine SQL, directions link, customer location cookie | – | Consultant search (category, service, name, language, mode, fee, date) |
| UI | Tile board, PageHeader, SellerShell | Tiles in customer, shop (sub-item), admin and operator menus | Find a Consultant, profile + booking, My appointments, consultant calendar + setup, admin console, operator setup |
| Mobile | WebView shell, push, deep links | `/consult` added to Android App Links path list | – |

## 5. Gaps found that the brief did not mention

1. The shop board is at the 16-tile maximum (test-enforced): the seller entry goes under an existing tile.
2. No live in-app stream exists: "real time" is met by sending at the event (push + in-app + e-mail); polling was not added (brief says no cron polling).
3. SMS / WhatsApp are not integrated (stubs): booking messages use in-app, e-mail and push; SMS / WhatsApp follow each user's own opt-in once a vendor exists.
4. `consent_type` is a Postgres enum with two values; booking consent is recorded on the booking (version + time) instead of altering the enum.
5. Android App Links need `/consult` in `mobile/app.config.ts` and a new native build for links tapped outside the app; inside the app nothing native changes.
