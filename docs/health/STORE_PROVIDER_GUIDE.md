# GoKesari Health — guide for medical stores, home-care providers and equipment stores

All three start from Seller Central → Orders → **Health** (`/shop/health/hub`). Every screen updates live; times
are IST. GoKesari's commission (default 2%, Admin → Settings → rule `health`) is taken in the weekly payout.

## Medical store (pharmacy)

**Join:** register the shop with type **Pharmacy / Medical Store**, then Health → **Pharmacy profile**
(`/shop/health/pharmacy`): drug licence number, registered pharmacist name and registration number, council,
whether you deliver (radius) and accept cash on handover. GoKesari verifies it; only verified stores appear when
patients send prescriptions.

**Prescription requests** (`/shop/health/prescriptions`, with sound): each request shows the prescription (doctor
name and registration number, patient, date, validity), the medicines and quantities asked for, pickup or
delivery, address and distance. Check the prescription with its QR (genuine, not replaced), its validity date, and
that each medicine may be sold online (Schedule X / NDPS never).

1. **Quote within the response time** (default 15 minutes — after that the request expires and the patient picks
   another store): per medicine Available / Partly available (quantity) / Not available / **Substitute** (same
   generic and strength only — the patient approves or rejects each substitute), price, discount, delivery
   charge. Or **Decline** with a reason.
2. The patient approves and pays online, or chooses cash on handover (if you allow it).
3. **Pack** → **Ready for pickup** (the patient shows a pickup code at the counter) or **Out for delivery** (your
   delivery person's name and phone; the patient gives the delivery code at the door). GoKesari rider delivery for
   medicine orders comes later.
4. **Complete with the code** and enter the bill: per line batch number, expiry date and quantity supplied
   (never more than quoted or prescribed). Supplying less refunds the difference to an online payer. The bill is
   saved in the patient's record and the prescription's dispensed quantities go up, so it cannot be reused beyond
   what was prescribed.
5. Cancelling: the patient may cancel before packing; you may cancel with a reason (full refund).

API: `GET/POST /api/health/rx-orders` (`?shopId=` for your inbox), `GET/POST /api/health/rx-orders/<id>`
{quote, decline, approve, pay, cancel, pack, ready, dispatch, complete, newcode, problem}, `GET …/<id>/bill`,
`GET …/<id>/prescription`, `GET/POST /api/health/pharmacy`.

## Home-care provider (nurse, physiotherapist, massage therapist, attendant, baby care, sample collection)

**Join:** register as a practice (individual or agency) — shop type **Consultant / Professional Firm** — and set up
Appointments → Setup: team, a **Home care** category, services (single visit, hourly, 8 h / 12 h shift; a 24-hour
shift = a day and a night 12-hour booking), rates, hours, service area, certificates (State Nursing Council for
nurses, physiotherapy degree, …). Then Health → **Home-care visits → Profile** (`/shop/health/care/profile`):
provider kind, gender, categories, registration, service PIN codes / radius. GoKesari verifies documents (and the
police verification flag where needed) and issues your **ID card** with a QR (`/health/care/id/<card>`), which
patients see before the visit.

**Visits** (`/shop/health/care`): accept / decline, schedule, navigation; **On my way** (your location is shared
while the page is open); **check in with the patient's code**, **check out with their second code**; visit notes,
vitals and (with consent) photos go into the patient's record as a visit-note PDF; package progress (e.g. 3 of
10 sessions). Agencies can reassign a visit to another staff member. You see only the booking details, address,
instructions and records the patient chose to share for that booking. Earnings: `/shop/health/care` → Earnings
(paid through the weekly payout).

Patients have an **SOS** button during the visit (alerts their emergency contact and GoKesari support).

## Medical equipment store

**Join:** shop type **Medical equipment store**; Health → **Equipment rentals → Profile** (rental terms, damage
policy, delivery radius); verified by GoKesari.

**Listings** (`/shop/health/equipment`): from the master list (wheelchairs, beds, oxygen concentrators, CPAP,
monitors …) or your own; for sale (links to your normal shop product — buying is a normal GoKesari order) and/or
for rent (per day / week / month, minimum period, refundable deposit, delivery / installation charge, stock,
"prescription required").

**Rentals:** booked and paid online (rent + deposit + delivery) → **Out for delivery** → deliver with the patient's
**delivery code** (the rental starts) → reminders before the due date → the patient extends (pays the extra
period) or schedules the **return pickup** → **Returned**: record the condition, damages (with photos, never more
than the deposit) → the deposit minus damages is refunded through the gateway → **Closed**. Prescription-required
items need the patient's prescription or the doctor's equipment suggestion.

API: `GET /api/health/equipment/search`, `…/master`, `…/listings/<id>`, `GET/POST /api/health/equipment/rentals`,
`GET/POST …/rentals/<id>` {pay, extend, schedule-return, cancel, dispute, dispatch, deliver, returned, close},
`GET/POST /api/health/equipment/store`.

## Prime (all three)

Health → **Prime** (`/shop/health/prime`): plans and prices set by GoKesari, GST 18% shown separately, invoice
`PRM/<FY>/<n>`. Prime gives priority placement (always labelled "Prime"), a badge, instant booking, a virtual
number with call tracking and analytics. It does not guarantee customers.
