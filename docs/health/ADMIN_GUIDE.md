# GoKesari Health — admin and operator guide

Admin board → Categories → Shop categories → **Health**; operator board → Catalogue → Shop categories → **Health** (`/admin/health`). Staff see **metadata only** — no diagnoses, notes,
medicines or reports — except through break-glass. Permission `health:manage` (admins and operators);
`health:break_glass` (admins only).

| Tab | Who | What |
|---|---|---|
| Verification | Admin, operator | Doctors (council, registration number + year, HPR id, certificate; link to the National Medical Register for the manual check), home-care providers (police verification flag), medical stores (drug licence, pharmacist), equipment stores. Approve / reject with a reason; the owner is told. |
| Specialties | Admin, operator | Every medical practitioner by Health group (General & family, Specialists, Women & child, Dental, Eye & ENT, Mind, Therapy, AYUSH, Diagnostics, Animal care; plus Home care): the bookable specialties with their certificate and doctor count, a "Find a doctor" mark for those patients can search, and the same group in the registration list with shop counts. Read-only; edit in Consultants → Categories and Shop categories. The Health card on Shop categories opens here. |
| Drug master | Admin, operator | Search, add, edit; schedule (OTC / G / H / H1 / X / NDPS), prescription-required, **teleconsultation list** (O / A / B / Prohibited), online sale; CSV import (sample file on the tab) and ICD-10 CSV import. Schedule X / NDPS are always prohibited by video and never sold online. **Review the starter list with a pharmacist / doctor before go-live.** |
| Lists | Admin, operator | Home-care categories (in the consultant categories, group "Home care"), equipment master list. |
| Prime | Admin | Plan builder (features, quotas, prices per term, optional city / specialty scope), coupons, subscriptions, revenue. No price is in code. |
| Settings | Admin | Rule `health` (read-only here; edit in Admin → Settings) and the `consultBooking` switch. |
| Reports | Admin, operator | Health bookings, prescriptions issued, medicine orders, rentals, care visits, Prime revenue, referrals, consents granted / withdrawn, data requests — counts only, CSV download. |
| Access & audit | Admin, operator | Health access log (patient shown as id + initials), Health audit trail. |
| Break-glass | Admin (rule `breakGlassEnabled`) | Emergency read of a patient's timeline and prescriptions with a reason of at least 20 characters. Each open is written to the patient's access log (they see it), audited, and the patient is notified. |
| Data requests | Admin, operator | DPDP export / delete requests: mark done or reject with a note (the patient is told). Delete hides the records at once; medical records stay restricted for at least 3 years. |
| Support | Admin, operator | Links to the help desk (Booking / Other / Grievance), consultant bookings and order disputes. |

## Switching Health on

> **Status (24-Nov-2026):** already done on both sites. Migration 0156 switched `health.enabled` and
> `consultBooking.enabled` on (owner, 20-Nov-2026, DECISIONS H-47); gokesari.com has served Health since
> 20-Nov-2026 23.32 IST (release #440). Step 2 (legal review) and the drug-master review stay recommended, not a
> condition for go-live. The steps are kept for a fresh database or after switching Health off.
>
> Licences: medical stores are verified here (drug licence, pharmacist), but the shop's drug licence and a doctor's
> medical registration are asked for **on the owner's promise** (90 days, then suspension), set in Admin → Shops →
> Document rules (decision log DF-08, DF-09; DECISIONS H-52), not before the shop goes live.

1. Admin → Settings → `consultBooking.enabled` on (and `reminderHours` [24, 2]).
2. Review the drug master and the consent / retention texts (legal review, DECISIONS H-30).
3. Admin → Settings → `health.enabled` on.
4. Verify the first doctors, pharmacies, providers and equipment stores.
5. Owner inputs before full use: telephony account for Prime virtual numbers (`telephonyProvider`,
   `HEALTH_TELEPHONY_WEBHOOK_SECRET`), SMS / WhatsApp vendor, Prime launch prices, optional PrintNode / QZ Tray
   account for silent printing, confirmation that the database server's disk is encrypted.

Rollback: switch `health.enabled` off (screens say "coming soon"; issued prescriptions still verify). Database
rollback `scripts/rollback-0156.sql` only after a full backup of schema `health`.
