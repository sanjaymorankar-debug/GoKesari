# GoKesari Health — changelog

Times IST.

## 22-Nov-2026 (afternoon) — Doctors scope in the document rules (owner)

- Admin → Shops → Document rules has a **Doctors** scope (a shop in any Health doctor category). Migration
  0165 sets the medical registration for it on the owner's promise, so doctors are asked for it with rule
  `legalDocuments` off too; shops already live get 90 days (H-52). Rollback: `scripts/rollback-0165.sql`.

## 22-Nov-2026 — Medical registration for every doctor category (owner)

- Rule `legalDocuments`: a shop in any shop category of a Health doctor group (General & family, Specialists,
  Women & child, Dental, Eye & ENT, Mind, AYUSH, Animal care) needs a medical registration, not only
  Doctor / Clinic. Therapy and Diagnostics are not included. Acts while the rule is on (H-51).

## 21-Nov-2026 — Health specialties (owner)

Owner, 21-Nov-2026 ~23.30 IST: "all various medical practitioners should come under Shops → Health → all types of
doctor specialists", with subcategories for better search.

- **One grouped list** (`src/lib/health/specialties.ts`): General & family, Specialists, Women & child, Dental,
  Eye & ENT, Mind, Therapy, AYUSH, Diagnostics, Animal care.
- **Migration 0161** (`drizzle/0161_health_specialties.sql`, rollback `scripts/rollback-0161.sql`): the built-in
  medical shop categories and consultant categories move into those groups (only while they still carry their seeded
  group), and the missing specialties are added to both: cardiologist, neurologist, diabetologist, gastroenterologist,
  pulmonologist, nephrologist, urologist, oncologist, general surgeon, orthodontist, psychiatrist, speech therapist,
  dietitian, Unani, Siddha, naturopathy, diagnostic lab, scan centre. Nothing renamed or removed; Home care untouched.
- **Find a doctor**: group chips, then the specialties of that group with plain words ("Cardiologist · Heart");
  `?group=` filter; words typed in the search box ("heart", "kidney stone", "anxiety") also find the specialists;
  more symptom chips.
- **Admin Health → Specialties** tab (admins and operators): each group with its bookable specialties and its
  registration categories; the Health card on Shop categories opens it.

## 20-Nov-2026 — first release (branch `feat/gokesari-health`, on top of consultant appointments #425)

Owner brief received 10.51. Built 11.00 – 12.40.

### Added
- **Database** (migration 0156, schema `health`, 36 tables): patients and family, consents, access log, doctor /
  care-provider / pharmacy / equipment-store profiles, clinic settings, letterheads, drug master (70 starter
  medicines with telemedicine lists) and ICD-10 (96 starter codes), appointment links, consultations, versioned
  prescriptions and items (dispensed quantities), suggestions, documents, timeline, event outbox, share links,
  templates, medicine orders, care visits and packages, equipment master (20) / listings / rentals, Prime plans
  (5 seeded, admin-priced) / subscriptions / coupons, virtual numbers, call logs, profile stats, data requests,
  counters. Five home-care consult categories. Payment purposes HEALTH_RX_ORDER, HEALTH_RENTAL, HEALTH_PRIME.
  Consult services may last up to 12 hours.
- **Rule `health`** (off by default) with every setting admin-editable; permissions `health:manage`,
  `health:break_glass`; notification category HEALTH (push on by default) with 25 event types; 16 audit actions;
  document e-mail type HEALTH_PRESCRIPTION (PDF attached).
- **Live updates**: event outbox + server-sent events stream `/api/health/stream`; consult booking changes push
  through it.
- **Patient**: My Health hub (tile), notice and consent, profile, family with adult one-time code, Find a doctor
  (nearby, filters, symptom → specialty, Prime label), doctor profile and booking for a family member (record-
  sharing choice), appointment page with check-in QR, calendar, live queue, video join; records — timeline, by
  provider, medicines, reports — uploads, share links, full-record PDF; prescriptions with Book-now suggestions,
  PDF, print view, share; medicine orders to stores; home care; equipment; privacy (consents, access log, export /
  delete); refer a friend (existing referral programme).
- **Doctor / reception**: live Today with sound, queue (call, reorder, no-show), QR / code check-in, walk-ins;
  consultation pad (vitals + BMI, ICD-10, drug master, auto quantity, Hindi / Marathi lines, telemedicine blocks,
  allergy / duplicate warnings, templates, repeat last, patient summary with consent-gated earlier records,
  ask-the-patient), preview on letterhead, issue (number, QR, PDF, e-mail, notices, print, booking completion),
  amend; doctor registration details, signature / stamp; clinic settings (tokens, follow-up window, HFR id);
  letterhead modes (digital / pre-printed / standard) with mm calibration sheet, sections, auto-print.
- **Medical store**: pharmacy profile, live prescription inbox, quotes with substitutes, pickup / delivery codes,
  bill with batch / expiry, dispensed quantities, 2% settlement.
- **Home care**: provider profile and ID card, search, booking (single, hourly, shift, packages), on the way, OTP
  check-in / out, visit notes and vitals into the record, SOS, ratings, agency reassignment.
- **Equipment**: store profile, listings (sale via catalogue product / rent), rentals with deposit, delivery code,
  due reminders, extension, return pickup, damages, deposit refund, settlement.
- **Prime**: plans, quote, purchase (GST 18%, invoice PDF), renewal stacking, renewal reminder, grace, downgrade,
  Free-listing booking requests vs Prime instant booking, mock telephony with webhook, call log, missed-call alert,
  analytics, pay-per-booking option.
- **Admin / operator**: verification queues, drug master + CSV, lists, Prime admin, settings view, reports, access
  and audit logs, break-glass, data requests, support links.
- **Tiles**: customer Profile → My Health and Shops → Doctors (board stays 6 tiles, one screen at 360×800); shop Orders → Health hub; admin / operator Shops → Health.
- **Mobile**: app 1.10.0 (Android versionCode 11, iOS build 11), `/health` and `/rx` app links.
- **Docs**: README, DECISIONS (H-01 … H-44), DATA_MODEL, DOCTOR_GUIDE, STORE_PROVIDER_GUIDE, ADMIN_GUIDE,
  TESTING_REPORT, feature tracker, screenshots; demo seed `scripts/health/demo-seed.ts`.
- **Tests**: 6 integration suites (core, rx-orders, care, rentals, prime, admin), guest QA checks TC-HLT-001…005,
  signed-in journeys TC-HLT-010…032.

### Launch mode (13.32 IST)
- Rule `health.primeForAll` (default on, owner decision): every verified provider gets the Prime features; Prime plans are not sold; no paid boost or label in search; standard registration fee (₹999 slab) and 2% commission apply.

### Changed (additive edits to existing files)
- `consult/bookings.ts` addEvent: live push of every booking change. `consult/setup.ts`: service duration up to
  720 minutes. `payments/*`: the three purposes. `scheduled-notices.ts`: `HEALTH_*` kinds. `documents/email.ts`:
  prescription PDF type. Notification types / templates, rules, permissions, audit actions, env
  (`HEALTH_TELEPHONY_WEBHOOK_SECRET`), board menus and their tests, QA routes and catalogue.
