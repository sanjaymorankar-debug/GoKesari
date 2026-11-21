# GoKesari Health

Owner brief: 20-Nov-2026 10.51 IST. Decisions: [DECISIONS.md](DECISIONS.md) · Changes: [CHANGELOG.md](CHANGELOG.md) ·
Data model: [DATA_MODEL.md](DATA_MODEL.md) · Guides: [doctor](DOCTOR_GUIDE.md), [stores and providers](STORE_PROVIDER_GUIDE.md),
[admin](ADMIN_GUIDE.md) · Tests: [TESTING_REPORT.md](TESTING_REPORT.md).

GoKesari Health links patients (and their families), doctors and clinic reception, medical stores, home-care
providers, medical equipment stores and GoKesari staff. It is built **on the consultant-appointments engine**
(docs/consult-booking-2026-11): a doctor or care provider is a consult member of a practice (a shop) and every
appointment is a consult booking. Health adds the clinical record, consent, e-prescriptions, medicine orders,
home-care visits, rentals and Prime listing plans.

## Switching it on

1. Admin → Settings → `consultBooking.enabled` = on (appointments engine).
2. Admin → Settings → `health.enabled` = on. Off: every Health page says "coming soon"; issued prescriptions still
   open and verify.
3. Recommended consult setting for clinics: `consultBooking.reminderHours` = [24, 2] (brief: reminders 24 h and 2 h).
4. Review the starter drug master (Admin → Health → Drug master) with a pharmacist / doctor (DECISIONS H-19).

Settings in rule `health`: store response time (15 min), prescription validity (30 days), commissions on medicine
orders / rentals / care (2%), rental due reminder (2 days), Prime GST (18%), grace days (7), term discounts,
pay-per-booking toggle and fee, document size, share-link hours (72), video / telephony / print providers,
break-glass on/off, free-listing manual approval, care OTP attempts, family code minutes.

## Who does what

| Role | Where | What |
|---|---|---|
| Patient (customer) | `/health` (Profile → **My Health**; Shops → **Doctors**) | Notice and consent; profile; family (dependents, adults by OTP); find and book doctors (`/health/doctors`); appointments, check-in QR, live queue; records: timeline, by provider, medicines, reports (`/health/records`); prescriptions with Book-now suggestions, PDF, print, share (`/health/prescriptions`); medicine orders (`/health/medicines`); home care (`/health/care`); equipment (`/health/equipment`); privacy, access log, data requests (`/health/privacy`); refer a friend (`/refer`) |
| Doctor | `/shop/health` (Seller Central → Orders → Health) | Live Today, queue, check-in, walk-ins; consultation pad (`/shop/health/consult/<id>`); registration details, signature, letterhead, calibration, templates (`/shop/health/settings`); Prime (`/shop/health/prime`) |
| Clinic reception | `/shop/health` | Today, check-in (QR / code), queue, walk-ins, payments (consult) — no clinical notes (they cannot open the pad unless they are a doctor) |
| Medical store | `/shop/health/prescriptions`, `/shop/health/pharmacy` | Live prescription inbox, verify, quote, substitutes, pack, pickup / delivery with codes, bill with batch / expiry |
| Home-care provider | `/shop/health/care` | Visit inbox, accept, on my way, OTP check-in / check-out, notes and vitals, packages, ID card |
| Equipment store | `/shop/health/equipment` | Listings (sale / rent), rentals: dispatch, delivery code, returns, condition, deposit refund |
| Admin / operator | `/admin/health` (admin Categories → Health; operator Catalogue → Health) | Verification queues, drug master, lists, Prime plans and coupons, reports, access and audit logs, break-glass (admin), data requests |

## Access and consent (enforced in `src/server/health/access.ts` and each service)

| Who | Sees |
|---|---|
| Patient / account holder | Own record and the family records they manage (adult links only after the adult's code) |
| Doctor | Own consultations with the patient always; other providers' records and uploads only while the patient's consent for that doctor is active (ALWAYS, or THIS_BOOKING for the visit); every look logged |
| Referred doctor | The referral note when the patient books; records only if the patient shared them |
| Care provider | Booking details, address, instructions; records the patient shared for that booking; own notes |
| Clinic staff | Appointments, check-in, payments |
| Medical / equipment store | Only the prescription or suggestion attached to their order |
| Admin / operator | Metadata only; break-glass with a reason (admin), logged and shown to the patient |

## Events and real time

Every change calls `publishHealthEvent()` (`src/server/health/events.ts`): a row in `health.events` (ids and
statuses only) and an immediate push over `/api/health/stream` (server-sent events) to the people concerned and to
everyone working at the practice / store. Consult booking changes push through the same bus. Screens use
`useHealthLive()` / `<LiveRefresh/>` (`src/components/health/live.tsx`). Timed work (store timeouts, rental due
reminders, Prime renewal / expiry) is `scheduled_notices` kinds `HEALTH_*` run by the every-minute job.

Event names: `appointment.booked|rescheduled|cancelled|checked_in|completed|no_show|changed`, `queue.updated`,
`consultation.started`, `prescription.issued|amended`, `suggestion.created|booked`, `referral.created|accepted`,
`consent.granted|revoked`, `record.accessed|added`, `rx.forwarded|quoted|declined|expired|approved|cancelled`,
`order.ready_for_pickup|out_for_delivery|completed`, `care_booking.created|accepted|declined|provider_on_the_way|checked_in|checked_out|completed|sos`,
`rental.started|due_soon|extended|return_scheduled|returned|deposit_refunded|changed`, `prime.subscribed|renewal_due|expired`,
`call.missed`, `provider.verification_pending|verified|rejected`.

## API (core; module APIs are listed in their guides)

| Method | Path | |
|---|---|---|
| GET | `/api/health/stream` | live events (SSE) |
| GET / POST | `/api/health/me` | notice state and people / accept the notice |
| GET / POST | `/api/health/patients/<id>` | profile |
| GET | `/api/health/patients/<id>/records?view=timeline\|providers\|medicines\|documents\|prescriptions\|suggestions&kind&q` | record views |
| POST | `/api/health/patients/<id>/documents` | upload a report (multipart) |
| GET / DELETE | `/api/health/documents/<id>` | open / remove own upload |
| POST / DELETE | `/api/health/patients/<id>/share` | expiring share link / revoke all |
| GET | `/api/health/share/<token>` | open a share link (no sign-in, logged) |
| GET | `/api/health/patients/<id>/export` | full record PDF |
| GET / POST | `/api/health/patients/<id>/consents` · DELETE `/api/health/consents/<id>` | consent |
| GET | `/api/health/patients/<id>/access-log` | access log |
| POST | `/api/health/family` · `/api/health/family/<id>` {confirm, resend, remove} | family |
| POST | `/api/health/privacy` {EXPORT, DELETE} | DPDP requests |
| POST | `/api/health/bookings` | book for a family member |
| GET | `/api/health/bookings/<id>/qr` · `/queue` | check-in QR · live queue |
| POST | `/api/health/suggestions/<id>` {share, dismiss} | suggestion |
| GET / POST | `/api/health/prescriptions/<id>` {amend} · GET `/pdf` (`?print=1`, `?download=1`) | prescription |
| GET | `/api/health/doctor/seats` · GET / POST `/api/health/doctor/<memberId>` {profile, template, delete-template} · POST `/image` | doctor |
| GET / POST | `/api/health/clinic/<shopId>` {call, reorder, walkin, checkin, find-qr, settings, request-access} | the clinic's day |
| POST | `/api/health/consultations` · GET / POST `/api/health/consultations/<id>` {draft, check, preview, issue, repeat} | the pad |
| GET | `/api/health/drugs?q=` (`&icd=1`) | drug master / ICD-10 search |
| GET / POST | `/api/health/letterhead/<shopId>` (`?calibration=1`) · POST `/image` | letterhead |

Pages: `/rx/verify/<token>` (public QR check), `/health/prescriptions/<id>/print` (print view).

## Money

- Consultation fees: the consult engine (online / at the clinic, refunds by policy, commission, weekly payout).
- Medicine orders: `HEALTH_RX_ORDER` payments (or cash on handover), 2% commission via `financial_adjustments`.
- Rentals: `HEALTH_RENTAL` payments (rent + deposit + delivery; extensions), deposit refund minus damages through
  the gateway; 2% on rent + delivery.
- Prime: **launch mode (rule `primeForAll`, on)** — every verified provider gets the Prime features free; no plan is sold; providers pay the standard registration fee (₹999 slab) and 2% commission. With launch mode off: `HEALTH_PRIME` payments, GST 18% separately, invoice `PRM/<FY>/<n>`; optional pay-per-booking fee.
- Doctors are never paid for referrals or suggestions (NMC).

## Mobile apps

Android and iOS are a WebView shell of the site: every Health screen works in the installed apps as soon as the
website is deployed. App 1.10.0 adds `/health` and `/rx` App Links. Build: GitHub "Android APK" workflow (automatic
on `mobile/**`), iOS: "iOS" workflow (manual, EAS → TestFlight; needs the Apple secrets). The update prompt appears
once `MOBILE_APP_{ANDROID,IOS}_LATEST` = 1.10.0 is set on the server after the store release.
