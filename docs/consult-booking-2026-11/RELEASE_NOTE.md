# Release note — Consultant appointments (20-Nov-2026)

**Released.** On gokesari.com since **20-Nov-2026 23.32 IST** in release #440 (with newspapers, Puja Samagri, GoKesari
Health, territory dealers, tagline and welcome kit). Restore point `prod-db-migrate-2026-11-20-1631-run58` taken at
22.01 IST before migration 0153 was applied; post-deploy check passed 23.35 IST; consultant guest checks
TC-CON-001..004 passed on production 23.37 IST. The unpaid-hold fix below (#434) follows in a later release.

**For customers.** "Find a Consultant" (Shops → Consultants, or `/consult`): doctors, dentists, advocates, CAs,
tax consultants, IT consultants, architects, interior designers, tutors, trainers, salons and home-service experts
near you, with distance, map, directions, rating and the next free time. Filter by category, service or name,
language, in person / video / phone / home visit, fee and day. Pick a consultant or "any available", a time
(IST), and pay online (UPI, card, net banking — the time is held 10 minutes), pay at the visit, or nothing for a
free service. Group sessions (classes, workshops, family) and team appointments are supported. My appointments
(Orders → Appointments): reminders 24 h and 1 h before, the completion code, change time or cancel under the
consultant's policy, refund status, receipts / tax invoices, private files, rating, and "Report a problem".

**For consultants and firms.** Register as "Consultant / Professional Firm" (same registration, fee, referral,
GST/PAN and auto-approval as shops). Seller Central → Orders → Appointments: day / week / month calendar with the
team side by side, colour-coded statuses, today's agenda, earnings and utilisation; accept / decline, mark
arrived, complete with the customer's code, no-show, record payment at the counter (receipt issued), private
notes, video link, move or reassign. Setup: profile and map pin, cancellation policy, team members (categories,
languages, registration certificate, slot length, buffer, people per slot), weekly hours with several sessions a
day, leave, holidays, blocked or extra hours, and services (duration, free / fixed / advance, modes, one-to-one /
team / group, GST).

**For GoKesari staff.** Admin → Shops → Consultants: certificate and profile verification, every booking with
filters, refunds and disputes (help-desk tickets), staff cancellation with full refund, categories with
commission % (default 2%) and required registration, policy templates, and reports (bookings, revenue,
commission, top categories, areas and consultants). Operators onboard consultants with the owner's consent
and set up their appointments and map pin.

**Money.** Online payments go through the existing gateway; GoKesari's commission (category %, default 2%) is
taken on what the consultant keeps and settled in the weekly shop payout. Refunds return to the original payment
method.

**Unpaid holds (#434, D-CB-09 — next release).** When the 10-minute hold on an online booking runs out without payment, the
booking ends as "payment failed", the time is freed and the customer is told "Payment for … did not go through".

**Switch.** Rule `consultBooking` (Admin → Settings). GoKesari Health's migration 0156 (#429) switches it on: on
test.gokesari.com when #429 landed, on gokesari.com in the joint release (owner's launch decision, CB-23).

**Apps.** Android and iOS show all of it immediately (website screens); app 1.9.0 adds `/consult` app links.

Migration 0153 (new tables only; rollback `scripts/rollback-0153.sql`).
