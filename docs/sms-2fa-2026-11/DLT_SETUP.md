# SMS codes in India: what the owner must register (DLT + MSG91)

24-Nov-2026. Needed before the SMS sign-in code or the checkout code can be
switched on for **gokesari.com**. On test.gokesari.com nothing here is needed:
`SMS_PROVIDER=mock` writes the codes to Admin → Test messages.

Indian telecom rules (TRAI TCCCPR 2018) block any business SMS whose sender,
header and exact text are not registered on a DLT (Distributed Ledger
Technology) portal. MSG91 sends only what DLT approved.

## 1. Principal Entity (PE) registration — once

Register GoKesari as a **Principal Entity** on one operator's DLT portal (the
registration is shared with all operators):

| Operator | Portal |
|---|---|
| Jio | trueconnect.jio.com |
| Vodafone Idea (Vi) | www.vilpower.in |
| Airtel | dltconnect.airtel.in |
| BSNL | www.ucc-bsnl.co.in |

You need: the business PAN, GSTIN (or another proof of business), a letter of
authorisation on letterhead for the person registering, their ID, and the
registration fee the portal shows (about ₹5,900 incl. GST on most portals).
Approval usually takes 1–3 working days. Note the **PE ID** (19 digits).

## 2. Sender header — 6 letters

Register a **Transactional / Service** header of exactly 6 letters, close to
the brand, e.g. **`GOKSRI`** (alternatives if taken: `GOKESR`, `GKESRI`).
This becomes `MSG91_SENDER_ID`.

## 3. Content template for the code

Register one template, linked to the header above:

- **Category / type:** Service Implicit (OTP). On some portals the type is
  simply "OTP" — choose that.
- **Text — exactly** (the app sends this wording; `{#var#}` are the variables):

  ```
  {#var#} is your GoKesari code. It expires in {#var#} minutes. Do not share it with anyone. -GoKesari
  ```

- Variables: first = the code (6 digits), second = minutes (5 by default, rule
  `otp.expiryMinutes`).

Note the **Content Template ID** (19 digits) once approved.

One template serves the sign-in SMS code, the checkout code and the codes for
shops registered with a mobile number only.

## 4. MSG91 account

1. Create a GoKesari account at msg91.com (business KYC as they ask).
2. **Add the DLT details:** PE ID, the header `GOKSRI` (approved on DLT).
3. **Create a template (Flow)** in MSG91 → SMS → Templates with the same text,
   using MSG91 variables **`##otp##`** and **`##minutes##`** in place of the two
   `{#var#}`:

   ```
   ##otp## is your GoKesari code. It expires in ##minutes## minutes. Do not share it with anyone. -GoKesari
   ```

   Link it to the DLT Content Template ID and the header. MSG91 shows a
   **template id** for it → `MSG91_OTP_TEMPLATE_ID`.
4. MSG91 → API → **Auth key** (create one for the server only; whitelist the
   server's IP 189.72.155.162 if MSG91 offers IP security) → `MSG91_AUTH_KEY`.
5. Buy SMS credits (transactional route).

## 5. Settings on the server

On gk-db-1, through the site kit (scripts/vps-app/README.md; values typed
hidden, never committed). Production site `gokesari-prod`:

```
sudo gk-site env set gokesari-prod SMS_PROVIDER          # msg91
sudo gk-site env set gokesari-prod MSG91_AUTH_KEY        # the auth key
sudo gk-site env set gokesari-prod MSG91_SENDER_ID       # GOKSRI
sudo gk-site env set gokesari-prod MSG91_OTP_TEMPLATE_ID # the MSG91 template id
sudo gk-site env set gokesari-prod MSG91_DLT_TE_ID       # optional: the DLT content template id
sudo gk-deploy restart gokesari-prod
```

This changes the server, so it needs the owner's OK (CLAUDE.md). The app never
logs the key, the code or the full number.

## 6. Check, then switch on

1. Admin → Settings → **Sign-in security** → the SMS provider line must say
   "MSG91 configured".
2. Switch on "Shop owners: email + SMS code at sign-in" first (a reason is
   required) and sign in with a test shop owner account to see a real SMS.
3. Then customers, and (if wanted) the Checkout code tab.

If MSG91 is down or a key is wrong, sending fails ("We could not send the SMS
just now") — switch the audience off on the same page and sign-in returns to
email-only at once.
