# Consultant appointments and bookings

Owner brief 20-Nov-2026, 09.37 IST. Gap report: [GAP_REPORT.md](GAP_REPORT.md). Decisions: [DECISIONS.md](DECISIONS.md). Release note: [RELEASE_NOTE.md](RELEASE_NOTE.md).

## Switching it on

Rule **`consultBooking`** (Admin → Settings), shipped **off**. Off: `/consult` says "coming soon", consultant
pages and new bookings are closed, existing bookings can still be opened, cancelled and refunded, and staff can
prepare categories and verify profiles in Admin → Categories → Shop categories → Consultants. Settings in the rule: hold minutes (10),
default commission (200 bp = 2%), reminder hours ([24, 1]), modes whose completion needs the customer's code
(in person, home visit), code attempts (5), file size / count, nearby radius (25 km), auto-verify profiles that
need no certificate.

## Who does what

| Role | Where | What |
|---|---|---|
| Customer | `/consult`, `/consult/<shop slug>`, `/consult/bookings`, `/consult/bookings/<id>` (+ `/receipt`) | Find (category, service / name, language, mode, fee, day, near me), book, pay, attach files, reschedule, cancel, rate, dispute, add to calendar |
| Consultant / firm owner | Seller Central → Orders → **Appointments** (`/shop/consult`), Setup (`/shop/consult/setup`) | Dashboard, day (team side by side) / week / month calendar, all booking actions, profile, policy, team, services, hours, leave, certificates, publish |
| Team member | `/shop/consult` (linked by their GoKesari e-mail) | Own calendar and bookings |
| Admin / operator (`consult:manage`) | Admin → Categories → Shop categories → **Consultants**; operator → Catalogue → Shop categories → **Consultants** (`/admin/consult`) | Verification, every booking (refunds, disputes, staff cancel), categories (commission %, registration, SAC), policy templates, reports |
| Operator-limited (`consult:onboard`) | Operator → My shops → **Consultant setup** (`/operator/consult`) | Onboard the practice with the owner's e-mail consent (existing flow), then set up its appointments and map pin |

Registration of a consultant is the existing shop registration (fee, referral code, GST/PAN, payment-based
auto-approval, seller documents); the new shop type **Consultant / Professional Firm** sits with the other
professional types. A profile is listed once the shop is approved and it has a member with hours, a service,
a map pin, and each required registration certificate uploaded.

## Data model (migration 0153)

`consult_categories` · `consult_policy_templates` · `consult_profiles` (one per shop) · `consult_members` (+
`consult_member_categories`, `consult_member_documents`) · `consult_services` · `consult_weekly_hours` ·
`consult_time_off` · `consult_bookings` · `consult_booking_members` · `consult_booking_events` ·
`consult_booking_files` · `consult_access_logs` · `consult_receipt_counters`. Times are `timestamptz` (UTC),
shown in IST. Rollback: `scripts/rollback-0153.sql`.

### No double booking

1. Every write that takes time locks the members' rows (`FOR UPDATE`, id order), releases lapsed holds and
   re-checks the time from the database (`lib/consult/slots.ts`), never trusting a browser's slot.
2. `consult_booking_members_no_overlap`: `EXCLUDE USING gist (member_id WITH =, slot WITH &&, share_key WITH <>) WHERE (active)`.
   Rows of one group session (`G:<service>:<start>`) or one multi-person slot (`S:<member>:<start>`) share a key;
   their capacity is checked under the lock. Buffers are part of `slot`.
3. Online payment holds the time 10 minutes (`PENDING_PAYMENT`, `hold_expires_at`); the every-minute job
   `consult-holds` releases lapsed holds. A capture after the hold takes the time back if still free, else the
   whole payment is refunded.

## Money

- Fee types: free, fixed, advance (deposit) with the balance at the visit or online. Group fees are per person.
- Online: payment-intent purpose `CONSULT_BOOKING` (Cashfree / sandbox, UPI, cards, net banking).
- Pay at visit: the consultant records cash / UPI / card; a receipt is issued.
- Refunds through the gateway to the original method: consultant / GoKesari cancels → full; customer cancels →
  full until `free_cancel_hours`, then `late_cancel_refund_pct`; no-show → `no_show_refund_pct`. The customer sees
  the live refund state.
- Settlement: on a final status, `financial_adjustments` (SHOP_ADJUSTMENT, PENDING) — + online money kept,
  − commission on everything kept (online, and at-visit money once completed). The weekly shop payout cycle
  pays / recovers them. Incremental and idempotent (`consult:<booking>:credit|commission:<n>`).
- Receipts `GKC/<FY>/<000001>` per firm; a tax invoice (CGST + SGST split of the GST-inclusive fee, SAC from the
  category) when the firm is GST-registered (REGULAR + GSTIN) and the service carries a GST rate.

## Notifications

Sent at the event (no polling), in-app + e-mail + push, to the customer and the firm (owner and assigned
members): booked, confirmed, awaiting approval, rescheduled, cancelled / declined, payment received / failed,
refund, completed, no-show, dispute, verification. Category **Appointments** in notification settings.
Reminders 24 h and 1 h before (scheduled notices, kind `CONSULT_REMINDER`, re-checked when sent).
SMS / WhatsApp follow each person's own opt-in once a vendor is integrated (stubs today).

## Privacy and security

Notes and files are visible only to the customer, the firm (owner / assigned member) and `consult:manage`
staff. Files and certificates are AES-GCM encrypted in the database and served through 5-minute signed links
bound to the viewer, after a session and access check. Every look by the firm or staff at a booking with notes,
files or a medical / legal category, and every download, is written to `consult_access_logs`. Consent (version
and time) is stored on each booking. Every slot and booking action is validated on the server.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/consult/search` | public search |
| GET | `/api/consult/availability` | free times |
| GET / POST | `/api/consult/bookings` | my bookings / book |
| GET / POST | `/api/consult/bookings/<id>` | detail / `{action}`: cancel, reschedule, pay, rate, dispute, accept, reject, arrive, complete, no-show, note, paid, meeting, reassign |
| GET / POST | `/api/consult/bookings/<id>/files` | signed links / upload |
| GET | `/api/consult/bookings/<id>/ics` | calendar file |
| GET | `/api/consult/files/<booking\|member>/<id>?exp&sig` | private file |
| GET / POST | `/api/consult/firm/<shopId>` | setup / calendar / dashboard; profile, publish, pause, member, hours, service, time-off |
| POST | `/api/consult/firm/<shopId>/document` | registration certificate |
| GET / POST | `/api/admin/consult` | categories, templates, profiles, bookings, report, documents; category, template, verify, cancel |

## Mobile apps

The Android and iOS apps are a WebView shell of the website: every screen above works in installed apps as soon
as the website is deployed, and booking pushes open their page. App 1.9.0 adds `/consult` to Android App Links
(links tapped outside the app); built by the "Android APK" workflow, iOS by "iOS" (manual, TestFlight).
