# Login by mobile or email + profile — deploy and test

Covers migration `0038_login_profile` (numbered `0037` on staging before the merge with main's `0037_dispute_cases`) and the sign-in / onboarding / My Profile / checkout changes.

## What changed for users

| Situation | Behaviour |
|---|---|
| Enters a **registered mobile** | Code emailed to the account's email. The screen says "If +91 … is registered, we've emailed a code…" and does not show the address. |
| Enters an **unregistered mobile** | The same screen and reply as a registered one, so nobody can find out which numbers have accounts. "Sign up with your email" sends a code to the email typed; on success the number is saved on the account (new, or an existing email-only account) if no other account has it. |
| Enters an **email** | Code sent there. A new account (with wallet) is created on first success. |
| First sign-in, or details never saved | `/onboarding` shows: name, gender, mobile (email read-only) → delivery address with map pin / "Use my current location". Everything optional; **Fill in later** skips. Shown again on every sign-in until saved once. |
| Details saved but **no mobile** | "Add your mobile number for faster login next time" popup after each sign-in; **Not now** closes it. |
| **Checkout** | Every order needs a mobile number on the account. A personal order from a shop that delivers needs a saved address. Pickup-only shops and business (B2B) orders are unchanged. |
| **My Profile** (`/profile`) | Edit name and gender; add, change or remove mobile; change email (code sent to the **new** address; the old address is told); default address with geo-tag; link to manage all addresses and pins. |
| **Admin** (`/admin` → "Release a mobile number") | Frees a number someone else claimed. Numbers are not SMS-verified. |

Rules: mobile and email are each unique per account. Indian mobiles only (10 digits, starting 6–9), checked in the browser and on the server. Codes are 6 digits and expire in 10 minutes. After 5 wrong attempts the code stops working. There is a 60-second wait before resending, at most 5 codes per email per hour, and at most 20 requests per IP per hour. All of these are adjustable in Admin → Settings → `otp`.

## Environment variables (both environments)

Codes are sent by email, so these must be set or the mobile/email form shows a warning instead of the form:

```
AUTH_EMAIL_FROM="Gokesari <no-reply@gokesari.com>"
AUTH_EMAIL_SERVER=smtps://USER%40gokesari.com:PASSWORD@smtp.hostinger.com:465
```

Optional, for the draggable map pin: `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (browser) and `GOOGLE_MAPS_SERVER_API_KEY` (server). Without them the address form still offers **Use my current location**, which saves the device's latitude/longitude.

## Deploy — test first (test.gokesari.com, `staging` branch)

1. **Back up the test database.** In Neon, create a branch/snapshot, or run:
   `pg_dump "$DATABASE_URL" -Fc -f gokesari_test_before_0038.dump`
2. **Run the migration against the test database** from any machine with the repo checked out at this branch:
   `DATABASE_URL="<test database URL>" npm run db:migrate`
   It is additive and safe to re-run. It adds:
   - `users.gender` and `users.profile_completed_at`;
   - `login_otps.email` and `login_otps.purpose`;
   - a check that each code has an email or a mobile number.

   It also makes `login_otps.phone_e164` optional, and marks accounts that already have both a name and a mobile as "details complete" so they aren't prompted.
3. **Verify:**
   `psql "$DATABASE_URL" -c "select count(*) filter (where profile_completed_at is null) as will_be_prompted, count(*) as users from users;"`
4. **Merge the pull request into `staging`.** Hostinger auto-deploys test.gokesari.com on push. Watch the deployment log in hPanel → Websites → test.gokesari.com → Node.js / Git until the build finishes.
5. **Check SMTP** in the test site's environment variables (above). Then run the checklist below on test.gokesari.com.

The old code keeps working after the migration (the new columns are nullable), so step 2 can safely happen before step 4.

## Deploy — production (gokesari.com, `main` branch)

Only after every checklist item passes on test:

1. Back up the production database (Neon snapshot or `pg_dump … -f gokesari_prod_before_0038.dump`).
2. `DATABASE_URL="<production database URL>" npm run db:migrate`
3. Run the verify query from test step 3.
4. Open a PR `staging` → `main` and merge it. Hostinger auto-deploys gokesari.com.
5. Smoke test: sign in with mobile and with email, open My Profile, and place one small order.

**Rollback:** revert the merge on `main` (or `staging`) and push; Hostinger redeploys the previous build. The migration doesn't need undoing, because the previous release ignores the new columns. Restore the backup only if data itself is wrong.

## Test checklist

Use a real inbox you can read. Codes arrive with the subject "NNNNNN is your Gokesari sign-in code".

**New user via mobile**
- [ ] Enter an unused 10-digit mobile → "If +91 … is registered, we've emailed a code…", the same as for a registered number; no email arrives.
- [ ] Tap "Sign up with your email", enter an unused email → "We sent a code to ab***@…"; the email arrives.
- [ ] Enter the code → "Tell us about you" with the mobile pre-filled and the email read-only.
- [ ] Save name + gender → "Delivery address" step. Tap "Use my current location" (and drag the pin if Maps is configured), fill in the fields → Save. Lands on home.
- [ ] My Profile shows the name, gender, mobile, email and the default address with "Geo-tagged at …". The wallet exists.

**Returning user via mobile**
- [ ] Sign out, enter the same mobile → "If +91 … is registered…" (no address shown) and the code arrives at the account email; after the code, home opens with no form.

**New user via email**
- [ ] Enter an unused email → code → details form with an empty mobile field.
- [ ] Save without a mobile → address step → Fill in later → home.
- [ ] Sign out and sign in again with the email → the "Add your mobile number" popup appears. "Not now" closes it; it appears again on the next sign-in. Adding a valid number closes it for good.

**Existing email-only user (account from before this release)**
- [ ] Sign in with the email (code, magic link or Google) → the details form appears. The wallet balance and order history are unchanged.

**Skip and fill in later**
- [ ] New account → "Fill in later" on step 1 → home works and the wallet can be topped up.
- [ ] Add an item from a delivering shop → the cart shows "Add your mobile number…" and "Add a delivery address…" instead of the pay button.
- [ ] Add both → the pay button appears and the order is placed with the address.
- [ ] Sign out and in again before saving details → the details form appears again.

**Profile edit**
- [ ] Change the name and gender → Save details → "Saved"; the header initial updates.
- [ ] Change mobile → the new number shows; remove it → "Not added"; the cart then asks for a mobile again.
- [ ] Change email → code sent to the **new** address. A wrong code shows an error and the email stays the same. The right code updates it, and the old address gets a "was changed" email. Signing in with the new email now works.
- [ ] Manage addresses → edit an address, re-pin it, set a different default.

**Duplicate mobile or email**
- [ ] Add a mobile already on another account (profile, popup or onboarding) → "This mobile number is already linked to another account…".
- [ ] Change the email to one another account uses → "This email address is already used by another account."
- [ ] A mobile + an email that belongs to an account with a different mobile → the code goes to that email; signing in opens that account and it keeps its own mobile.
- [ ] A mobile already on another account + a new email → the code goes to the new email; entering it shows "This mobile number is already linked to another account…" and no account is created.
- [ ] Admin → Release a mobile number → the owner can now add it.

**Wrong or expired code, limits**
- [ ] A wrong code → "That code is wrong or has expired…". After 5 wrong tries even the right code is refused ("Too many wrong attempts").
- [ ] Wait more than 10 minutes, then enter the code → refused.
- [ ] Use the same code twice → the second time is refused. Request a new code → the older one stops working.
- [ ] "Resend code" is disabled with a countdown for 60 seconds.
- [ ] Invalid input: `12345`, `5876543210`, `abc@` → a clear validation message, and no email is sent.
- [ ] A suspended account → the same reply as any other request, and no code is sent.
