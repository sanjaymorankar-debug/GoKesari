/**
 * GoKesari Health (docs/health/) — the signed-in journeys of the plan. Each is automated end to end against
 * real PostgreSQL in tests/integration/health-*.test.ts (run in CI); on test.gokesari.com they need the
 * staging accounts plus a verified demo doctor, pharmacy, care provider and equipment store
 * (scripts/consult-demo-seed.ts + scripts/health/demo-seed.ts) and are run by hand from
 * docs/health/TESTING_REPORT.md until signed-in UI checks are written for them.
 */
import { manual } from "../lib/record";

const WHERE = "covered by tests/integration/health-*.test.ts in CI; on staging run by hand per docs/health/TESTING_REPORT.md";

manual("TC-HLT-010", "book a verified doctor — the booking appears in Today live within 2 s", WHERE);
manual("TC-HLT-011", "token clinic: tokens in order and live queue position", WHERE);
manual("TC-HLT-012", "an unverified doctor cannot be booked or prescribe", WHERE);
manual("TC-HLT-013", "issue a prescription: PDF in the record, e-mail with PDF, print, booking completed within 30 s", WHERE);
manual("TC-HLT-014", "prescription QR verification: public vs authorised viewers", WHERE);
manual("TC-HLT-015", "amend creates a new version with a reason; the old QR says replaced", WHERE);
manual("TC-HLT-016", "telemedicine: prohibited medicine blocked, List B only after an in-person visit", WHERE);
manual("TC-HLT-017", "an allergy warning must be acknowledged before issuing", WHERE);
manual("TC-HLT-018", "letterhead modes and the calibration print", "printing on paper needs a person and a printer (docs/health/DOCTOR_GUIDE.md §4)");
manual("TC-HLT-019", "earlier records visible to a doctor only while consent is active; each look logged", WHERE);
manual("TC-HLT-020", "lifelong record: three doctors and a nurse in date order per family member", WHERE);
manual("TC-HLT-021", "family: a dependent at once, an adult only after the one-time code", WHERE);
manual("TC-HLT-022", "prescription to a store — pickup with OTP, bill in the record", WHERE);
manual("TC-HLT-023", "prescription to a store — delivery with OTP and substitute approval", WHERE);
manual("TC-HLT-024", "dispensed quantity can never exceed the prescribed quantity", WHERE);
manual("TC-HLT-025", "a store that does not reply in time — the patient is told and offered another store", WHERE);
manual("TC-HLT-026", "suggestions on the prescription: Book now for specialist, care, equipment, lab, follow-up", WHERE);
manual("TC-HLT-027", "home care: book, accept, on the way, OTP check-in / out, notes in the record, rating", WHERE);
manual("TC-HLT-028", "equipment rental: deposit, delivery OTP, return, deposit refund minus damages", WHERE);
manual("TC-HLT-029", "listing in launch mode: Prime features free for every medical shop, no plan to buy; admin-priced plans when launch mode is off", WHERE);
manual("TC-HLT-030", "patient referral codes and rewards can be switched off by admin", "the existing customer referral flow (its own cases); Health links to it");
manual("TC-HLT-031", "admin: verification queues, drug master CSV, break-glass with a reason", WHERE);
manual("TC-HLT-032", "privacy: withdraw sharing, access log in IST, download data, delete request", WHERE);
