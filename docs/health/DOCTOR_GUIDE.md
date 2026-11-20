# GoKesari Health — doctor and clinic guide

## 1. Join and get verified

1. Register your clinic on GoKesari as a shop (type **Doctor / Clinic** or **Consultant / Professional Firm**) —
   the normal registration: PAN / GST, fee, referral code.
2. Seller Central → Orders → **Appointments → Setup**: add yourself (and other doctors) to the team, choose a
   doctor category (General Physician, Dentist, Paediatrician …), upload your **council registration
   certificate**, set services and fees (in-clinic, video, follow-up), weekly hours, leave, and the map pin.
   Publish.
3. Seller Central → Orders → **Health → Doctor & print settings**: your full name as registered, qualifications,
   specialties, **council, registration number and year**, HPR id (optional), signature and stamp images.
4. GoKesari verifies the certificate and the practice. Until then you can set everything up, but patients cannot
   book you through GoKesari Health and you cannot issue prescriptions.

Reception staff: add them to the team with their GoKesari e-mail in a non-doctor role — they see Today, check-in,
queue and payments, never the consultation pad.

## 2. Today (who is coming and when)

Seller Central → Orders → Health → **Clinic — Today**. Live: new bookings, cancellations and check-ins appear within
a second with a sound (switch it off with "Sound"). Per patient: time (or token), name, age / gender, new or
follow-up, clinic / video / home, reason, payment status, check-in.

- **Check in**: scan the patient's QR (or type the 4-digit code from their booking). "Arrived (no code)" also works.
- **Call next / Call**, **↑ ↓** to reorder, **No-show** after the time, **Take payment** (counter payment).
- **Walk-in / book for a patient**: the patient's GoKesari mobile or e-mail → the earliest free time today, a token.
  Token clinics: switch on "Token clinic" in settings and set the minimum notice to 0 in Appointments → Setup.
- **Consult** opens the pad. **Join video** for video appointments.

## 3. The consultation pad

Left: vitals (BMI automatic), complaints, history, examination, diagnosis (free text or ICD-10), tests advised,
medicines, advice, follow-up date, referrals and suggestions. Right: the patient summary — **allergies in red**,
conditions, current GoKesari medicines, your past visits; other providers' records only when the patient shares
them (every look is shown to the patient). "Ask the patient" sends a request when they chose "ask each time".

Medicines: type a brand or generic; dose, frequency (1-0-1 …), before / after food, days; the quantity fills in
automatically (change it if needed); instructions in English and, if set, Hindi / Marathi. Warnings: recorded
allergies, duplicates, medicines not in the drug master. **Video / phone visits:** prohibited medicines are
blocked and List B medicines are allowed only as a follow-up of an in-person visit (Telemedicine Practice
Guidelines 2020). "Repeat last", templates and favourites save time. The draft saves itself.

Referrals and suggestions (optional; printed on the prescription if ticked): another specialist (with a note and
urgency), home care (nurse, physiotherapist, massage, attendant …), equipment (buy / rent), lab tests (home
collection), follow-up visit. The patient gets a **Book now** button for each. You see only whether it was booked.
GoKesari never pays or credits doctors for referrals or suggestions (NMC Code of Ethics).

**Preview on letterhead** → **Issue prescription**: a number (RX-2026-000123) and a verification QR; it is saved in
the patient's record, e-mailed to them with the PDF, sent by app / SMS / WhatsApp, the print view opens, and the
appointment is completed (fee settled) if the patient was checked in with their code.

**Amend** (open the prescription): a new version with a reason; both are kept; the patient is told again.

## 4. Letterhead and printing

Doctor & print settings → **Letterhead and printing** (for the whole clinic or one doctor):

1. **My digital letterhead** — upload header and footer images (PNG / JPG; export a PDF letterhead page as an image
   first) or a full-page background; set the header / footer heights and margins.
2. **My pre-printed letterhead paper** — nothing is printed in the header / footer area. Calibrate:
   1. Click **Calibration test print**, print it **at 100%** ("Actual size", not "Fit to page") on one sheet of
      your letterhead paper.
   2. On the millimetre grid, read where your printed header ends (e.g. 42 mm) and where your footer starts from
      the bottom (e.g. 25 mm). Enter them as the top and bottom margins; adjust left / right if needed.
   3. Save and print the calibration sheet again: the red box must sit inside the blank area.
   The e-mailed PDF still has a complete header (your digital images if uploaded, else the GoKesari standard).
3. **GoKesari standard letterhead** — built from your profile (name, qualifications, registration, clinic).

Also: paper size (A4 / A5 / Letter), font size, sections to print, Hindi / Marathi lines, signature on / off.

### Printing without a dialog (auto-print)

- Tick "Print automatically when I issue".
- On the reception PC, start Chrome with **kiosk printing** so the print view prints straight to the default
  printer:
  - **Windows:** make a shortcut to `"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing https://gokesari.com/shop/health`
    and set your prescription printer as the Windows default printer.
  - **Mac:** `open -a "Google Chrome" --args --kiosk-printing https://gokesari.com/shop/health` (quit Chrome first),
    and set the default printer in System Settings → Printers & Scanners.
- **GoKesari Print Helper (cloud / QZ Tray):** a silent print helper through PrintNode or QZ Tray needs an account
  and a signing certificate; GoKesari will enable it (rule `health.printProvider`) once the owner sets it up. Until
  then kiosk printing is the supported silent-print method.
- Phones and tablets (GoKesari app): "Open PDF" → the system share / print sheet.
- Every print and reprint is counted and logged in the patient's access log.

## 5. Prime

Seller Central → Orders → Health → **Health Prime**: instant online booking, labelled priority placement, Prime
badge, a virtual phone number with call tracking and missed-call alerts, WhatsApp / SMS reminders, patient stories,
analytics. Prices and contents are set by GoKesari (shown on the page, GST 18% extra). Prime does not guarantee
patients; free listings are never hidden.
