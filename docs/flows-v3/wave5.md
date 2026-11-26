# Flow spec v3 — wave 5 (F11, F15, F18)

Built 27-Nov-2026 on `feat/flows-v3-wave5` (from `origin/staging` 66269390, which includes wave 1). Every new
behaviour sits behind a new feature flag; with the flag off the site behaves exactly as before.

| Flag | Area | Seeded by |
|---|---|---|
| `flow_f11` | F11 delivery partner | migration **0222** — ON on the staging database (`gokesari_test`), OFF everywhere else |
| `flow_f15` | F15 society onboarding | same |
| `flow_f18` | F18 account recovery and closure | same |

Switch them in Admin → Feature flags (a reason is required; every change is logged). Account closure itself still
needs `account_self_deletion_enabled` (unchanged).

## Migration 0222 (`drizzle/0222_flows_v3_wave5.sql`)

Additive only, safe to re-run:

- `users.sessions_valid_after` (nullable): sessions signed in before it end on their next request;
- `societies`: nullable `authorised_person_name`, `authorised_person_role`, `flat_count`, `proof_type`,
  `proof_number`, `proof_image_url`, `delivery_hours_start`, `delivery_hours_end`, and `requires_proof`
  (default false — every existing society keeps false);
- `society_riders`: nullable `suspended_until`, `suspended_reason`, `suspended_by`;
- the three flag rows (`ON CONFLICT DO NOTHING`).

`login_otps.purpose` and `stored_images.purpose` are plain text columns: the new values (`RECOVERY_EMAIL`,
`RECOVERY_SMS`, `RECOVERY_NEW_EMAIL`, `RECOVERY_NEW_SMS`, `PHONE_LINK`, `ACCOUNT_DELETE_SMS`; `SOCIETY_PROOF`) need
no database change. No drops, renames, type changes or data changes. No new links between seller and customer tables.

## F11 — delivery partner (`flow_f11`)

| # | What it does | Where |
|---|---|---|
| 1 | A new rider application needs a profile photo (uploaded in the register form; an applicant may now upload `PROFILE_PHOTO`), the account's **verified** mobile (the form fills and locks it; an account without one verifies it in the form with an SMS code through the existing `/api/dual-auth/verify`) and the account's **verified** e-mail (filled and locked). Anything else: field errors `profilePhotoUrl` / `mobile` / `email`. | `services/delivery-partners.ts` (`checkFlowF11Application`), `components/delivery-partner-register-form.tsx`, `app/delivery-partner/register/page.tsx`, `api/images` |
| 2 | Approval needs the photo (rule `flowsWave5.riderPhotoAtApproval`), applications from before included. | `approveDeliveryPartner` |
| 3 | An approved rider without a photo sees a reminder with a link to `/gig/profile` on every rider page until they add one. Nothing is blocked. | `app/delivery-partner/layout.tsx` |
| 4 | Checked, unchanged: the rider ID card lists the verified societies whose list includes the rider (a paused listing is left off, F15 item 9); per-km pay plans and distance incentives (`/admin/rider-pay-plans`, `/admin/rider-earnings`, rule `riderPayPlans` and the other rider-v2 rules, all on) already cover "pay per km + km incentives" — no change. | `rider-files.ts`, `rider-pay-plans.ts` |

## F15 — society onboarding (`flow_f15`)

| # | What it does | Where |
|---|---|---|
| 5 | The application asks for the authorised person (name and role), the number of flats (optional) and a proof document: registration certificate or committee letter, with its number and/or a photo or phone-camera scan (`SOCIETY_PROOF`, viewable by the uploader and operations only). The registrant's own upload only. Wave 1's operator review ticket is opened as before. | `services/societies.ts` (`registerSociety`), `components/society-actions.tsx`, `api/societies`, `api/images`, `api/images/[id]` |
| 6 | A society that applied with these steps (`requires_proof`) can be verified only with a proof on file. Admin → Societies shows the details and a link to the document. Existing societies: unchanged. | `decideSociety`, `app/admin/societies/page.tsx` |
| 7 | New societies let only their approved riders deliver there: `exclusive_riders` is set on (rule `flowsWave5.newSocietiesExclusiveRiders`). As today, exclusivity applies once the list has a rider, so orders are never left without one. Existing societies keep their own setting. | `registerSociety`, `getSocietyDispatchRules` |
| 8 | Delivery hours at the gate (from / until, India time) in the society's rules; shown to the rider on the active delivery (new optional `gate.deliveryHours` field). Shown, not enforced in dispatch. | `updateSocietySettings`, `getSocietyDeliveryNotes`, `delivery-assignment.ts`, `delivery-partner-dashboard.tsx` |
| 9 | A society admin can pause a listed rider for 1–90 days with a reason, and resume them. While paused the rider is off the society's list, off its orders on every dispatch path, and off their ID card for it; the pause ends by itself. Revoke works as before. | `updateSocietyRider`, `delivery-eligibility.ts` (`blockedPartnerIds`), `rider-files.ts`, `api/societies/riders/[linkId]` |

No society fee (unchanged).

## F18 — account recovery and closure (`flow_f18`)

| # | What it does | Where |
|---|---|---|
| 10 | `/account/recover` offers "I lost my mobile number" and "I lost my e-mail" (wave 1's "lost both" form stays below it while `flow_f17` is on). A code goes to the factor still working — the account's e-mail, or its **verified** mobile by SMS; the reply is the same whether or not an account matches. A shop owner also gives a GSTIN or PAN of one of their shops (checked before the code is used up). Then a code to the new mobile / e-mail; on success the new contact is saved as verified, every session of the account ends (`users.sessions_valid_after`, checked in `readSession`; sessions now carry their sign-in time `sat`), trusted devices are forgotten, and the old contact is told (old e-mail by e-mail; old mobile by text message where text messages can be sent) as well as the account. The short-lived recovery token is signed and bound to the lost contact, so it works once. API `POST /api/account/recover/factor`. | `server/flows/account-recovery.ts`, `auth-sessions.ts`, `app/account/recover`, `api/account/recover/factor` |
| 11 | Linking or changing the mobile from My Profile, first-time setup or the "add your mobile" prompt needs an SMS code sent to the new number (`POST /api/me/phone/code`, then `PUT /api/me/phone { mobile, code }` or `PATCH /api/profile { mobile, mobileCode }`). Without the code the answer is 422 `PHONE_CODE_REQUIRED`; the forms then send the code and show a code field. The number is saved verified and the previous number gets a text message. Shop registration and onboarding v2 link numbers as before. | `server/flows/phone-link.ts`, `api/me/phone`, `services/profile.ts`, `components/phone-code-field.tsx`, `phone-link-form.tsx`, `profile-setup.tsx` |
| 12 | Account closure (with `account_self_deletion_enabled`): a code by e-mail **and** by SMS to the verified mobile (rule `flowsWave5.closureSmsCode`; an account without a verified mobile is asked to verify it first); the SMS code is used up only once the e-mail code is right too. | `account-deletion.ts`, `api/profile/delete`, `account-deletion-flow.tsx` |
| 13 | The owner's shops no longer need closing first: once their open orders are done (new check `SHOP_OPEN_ORDERS`) the system closes and hides them with the account (status INACTIVE, orders paused, subscriptions to them end) and switches them back on a restore. | `deleteAccount`, `restoreAccount` |
| 14 | Anyone with a dealer record, whatever their active role: dealer commission not yet paid (`DEALER_UNPAID_COMMISSION`), a franchise zone still held (`FRANCHISE_ZONE_LIVE`) or an open dealer account (`DEALER_ACCOUNT_OPEN`) stop the closure. | `gatherFlowF18Facts`, `blockersFrom` |
| 15 | At the final deletion (after the 90-day cooling-off), every role grant of the account is revoked. Tax records are kept as before (rule `accountDeletion.retentionYears`, 8 years). | `purgeOne` |

### Rule `flowsWave5` (Admin → Rules; each setting used only while its flag is on)

| Setting | Default |
|---|---|
| `recoveryWindowMinutes` (F18) | 15 — **DEFAULT – confirm with Sanjay** |
| `recoveryPerIpPerHour` (F18) | 5 — **DEFAULT – confirm with Sanjay** |
| `closureSmsCode` (F18) | true |
| `societyRiderSuspendMaxDays` (F15) | 90 — **DEFAULT – confirm with Sanjay** |
| `newSocietiesExclusiveRiders` (F15) | true |
| `riderPhotoAtApproval` (F11) | true |

Other choices to confirm (**DEFAULT – confirm with Sanjay**):

- where no SMS code can be sent (no SMS provider on the server), a new mobile is linked as today (unverified) and
  closure asks the e-mail code only, so nobody is stuck; "lost my e-mail" then points to the "lost both" form;
- a society proof is complete with either the document number or an uploaded image;
- the photo rule at approval also applies to applications made before the flag;
- a dealer record that is pending, approved or suspended is closed by GoKesari, not by self-service;
- text messages other than codes go through the existing text channel (the test outbox on staging); a DLT
  template for the "number replaced" message is not part of this wave;
- signing out everywhere applies to recovery; a contact change made while signed in keeps today's behaviour (other
  devices' trust is revoked, sessions stay).

No existing rule default was changed. APIs stay backward compatible: new endpoints, and new optional request /
response fields only (`profilePhotoUrl` was already accepted; `code`, `mobileCode`, `smsCode`; `maskedPhone`,
`shopsToHide`, `gate.deliveryHours`, society fields).

## Tests

`tests/integration/flows-v3-wave5.test.ts` — 24 tests, each item with its flag ON and OFF. Existing suites run
alongside: account deletion (integration and unit), sessions, authorization, OTP, SMS two-factor, dual auth, login
and profile, sign-in fixes, delivery partners and KYC, rider files / profile / growth / safety / pay plans, gig
worker, delivery assignment, societies (memberships, rider guard, join requests), image moderation, signup
referrals, wave 1, mobile auth, migration journal.

## Not in wave 5

- "Lost both" recovery: wave 1's support form (`flow_f17`), unchanged.
- Delivery hours are shown to riders but dispatch does not hold orders outside them.
- `society_rider_join_requests_enabled` (riders asking to join a society) stays as it is; switching it is an
  owner / flag decision.
- Rider pay numbers: the pay-plan screens exist; final numbers are the owner's (docs/rider-app-v2-2026-11).
