# Testing report — rider Aadhaar by DigiLocker

PR [#312](https://github.com/sanjaymorankar-debug/GoKesari/pull/312) (feature + app 1.6.0) and
fix PR [#314](https://github.com/sanjaymorankar-debug/GoKesari/pull/314), both into `staging`.
Why: Sandbox.co.in discontinued both Aadhaar OTP (OKYC) endpoints; DigiLocker replaces them.
Feature description: [README.md § KYC provider](README.md). Earlier gig-worker results:
[TESTING_REPORT_GIG_WORKER.md](TESTING_REPORT_GIG_WORKER.md).

_Status of this report (1 Nov 2026): unit / integration, CI and the Test site are done, including
the retest after fix #314. The production release and its smoke test come with the next
staging → main release (§6), run by the release session._

## 1. Summary

| Area | Result |
|---|---|
| Unit tests (parsers, adapter, signature, mock) | PASS — 14 cases |
| Integration tests (real PostgreSQL, single and split layouts) | PASS — 14 cases; full suite 3095 / 3099, the 4 failures listed in §7 |
| CI on #312 (test, test-split, mobile, APK preview + production) | PASS |
| Test site, mock DigiLocker — approve / deny / expire / mismatch / vendor down / resend | PASS (D-DL-1 found and fixed in #314, retested PASS) |
| Test site, Sandbox **test** keys | Not possible: Sandbox's test environment only answers saved example requests; the check stays Pending (`config_unexpected_response`) as designed |
| Legacy OTP-verified Aadhaar after the switch | PASS — stays Verified, shown as method "okyc_legacy" |
| Production smoke | Pending — after the release (§6) |

## 2. Unit tests — `tests/unit/kyc-digilocker.test.ts`

| # | Case | Result |
|---|---|---|
| 1 | Session init: session id and the DigiLocker link | PASS |
| 2 | Session status: the four documented states; documents only on succeeded | PASS |
| 3 | The webhook's `data` is the same session object | PASS |
| 4 | Document: the UIDAI XML link, preferred over other files; none when only a PDF | PASS |
| 5 | Profile: only the DigiLocker id and the name come out | PASS |
| 6 | Aadhaar XML: the name and the last four digits only | PASS |
| 7 | Starts a session with the documented body: Aadhaar only, our return link, consent expiry | PASS |
| 8 | Status is a GET; 521 (no such session) is null; 503 is the vendor being down | PASS |
| 9 | Fetches the Aadhaar: XML read in memory, profile id kept, nothing else | PASS |
| 10 | No consent (400), not in DigiLocker (404), session unusable (523) | PASS |
| 11 | Accepts Sandbox's documented signature (base64 HMAC-SHA256 of `JSON.stringify(payload)`) | PASS |
| 12 | Refuses a wrong, missing or other-key signature | PASS |
| 13 | Mock: links to the local consent page on the same site; waits until a button is pressed | PASS |
| 14 | Mock: approve / mismatch / deny / expire / down | PASS |

## 3. Integration tests — `tests/integration/rider-aadhaar-digilocker.test.ts`

Run on the single-database layout and on the two-database split (`DB_SPLIT_MODE=split`).

| # | Case | Result |
|---|---|---|
| 1 | Consent → session → signed webhook → Verified; only the name, last four digits and a keyed token are kept | PASS |
| 2 | The return link settles the check too (redirect on `AUTH_URL`, not the request origin), then a duplicate webhook changes nothing | PASS |
| 3 | From the app: the return link hands back to the app build's scheme | PASS |
| 4 | A second tap hands out the same open link instead of a new session | PASS |
| 5 | Declined consent → Failed, with a way to start again | PASS |
| 6 | Expired at DigiLocker, or our link ran out unused → Failed (expired) | PASS |
| 7 | Name doesn't match → Pending for an admin (manual review), who decides by hand | PASS |
| 8 | Vendor down at start or while checking → Pending with an error code, never Failed | PASS |
| 9 | The same DigiLocker account on another partner → Failed (already used) | PASS |
| 10 | The webhook refuses unsigned and wrongly signed payloads, and everything when no secret is set | PASS |
| 11 | OTP fields gone with DigiLocker on; legacy OTP and DigiLocker each refuse the other method | PASS |
| 12 | An Aadhaar verified by the legacy OTP stays valid after the switch | PASS |
| 13 | Admin: method, session status and reason; Resend link starts a new session and notifies the partner | PASS |
| 14 | The mock consent page's API refuses unknown sessions | PASS |

`tests/integration/gig-worker-partner.test.ts` was updated (OTP cases run under `okyc_legacy`;
a fully verified partner now uses DigiLocker) and passes. The database check that refuses a
stored full Aadhaar number is unchanged and passes.

## 4. Test site — test.gokesari.com, 31 Oct 2026 (18:00–18:10 UTC)

Build `01a19317` at staging `4a8a76e6` (#312). Migration `0123_rider_aadhaar_digilocker`
applied by the "Test database" workflow (run 41226599797, split layout, 1 applied, verify OK).
Accounts: the staging QA rider (`customer2`, "QA Gig Rider") and the staging QA admin, signed
in with their emailed codes. The rider's earlier OTP-verified Aadhaar was reopened by an admin
"Failed" decision for the test, and ends Verified again (case 6).

| # | Case | Expected | Result |
|---|---|---|---|
| 1 | Existing OTP-verified Aadhaar after the release | Still Verified; admin shows method okyc_legacy | PASS |
| 2 | Sandbox **test** keys: start a session | Sandbox test env answers only saved examples (HTTP 404 "Request does not match any saved example") → Pending `config_unexpected_response`, never Failed | PASS (vendor-error path) |
| 3 | Mock — deny | Failed; return link → KYC page `?digilocker=failed` | PASS |
| 4 | Mock — expire | Failed (expired) | PASS |
| 5 | Mock — vendor down | Pending; admin sees "KYC provider not answering (vendor_source_down)…", Resend available | PASS |
| 6 | Mock — approve | Verified, method digilocker, shown as `XXXX XXXX 4321` (last 4 only) | PASS |
| 7 | Admin Resend link | New session and link; the partner's "open" link follows the new one; reason "Our team sent you a new DigiLocker link" | PASS |
| 8 | Mock — name mismatch | Pending for manual review (`name_mismatch`, score 30), admin sees why | PASS |
| 9 | Webhook with a bad / missing signature | 401 "Invalid signature" | PASS |
| 10 | Mock consent page | 200, opens on the same site | PASS |
| 11 | Start without signing in | 401 | PASS |
| 12 | Return link redirect in a browser | Goes to `https://test.gokesari.com/delivery-partner/kyc?digilocker=…` | **FAIL → D-DL-1**, fixed in #314; retest §4a PASS |

### 4a. Retest after #314

Staging `de12f66a` (#314), 1 Nov 2026.

| # | Case | Result |
|---|---|---|
| 1 | Unknown return key → `303 https://test.gokesari.com/delivery-partner/kyc?digilocker=unknown` | PASS |
| 2 | Reopen, start, approve on the mock → return `303 https://test.gokesari.com/delivery-partner/kyc?digilocker=verified`; KYC page 200 | PASS |
| 3 | Check Verified, method digilocker, `XXXX XXXX 4321`; the page shows "Aadhaar from DigiLocker — with your consent" and no OTP field | PASS |
| 4 | "Open" link signed in → the partner's open DigiLocker link; signed out → `https://test.gokesari.com/signin` | PASS |
| 5 | Rule `riderVerification` reset to its default afterwards (`aadhaarMethod: digilocker`, `digilockerProvider: kyc_provider`) | Done |

## 5. Defects

| Id | Found | Defect | Fix | Status |
|---|---|---|---|---|
| D-DL-1 | Test site, case 12 | The return link (and the resend "open" link) redirected a browser to `https://0.0.0.0:3000/…`: behind Hostinger's proxy a request's own origin is the internal address | #314: both use `AUTH_URL` (`siteBase()`), as the DigiLocker `redirect_url` already did; the integration test now sends the request to `0.0.0.0:3000` | Fixed, retest §4a PASS |

Not a defect of this feature but seen during the run: test.gokesari.com's sign-in emails hit
Hostinger's outgoing mail limit (`451 4.7.1 Ratelimit "hostinger_out_ratelimit"`, 18:00–18:03 UTC),
so a new rider sign-in could not get its code for a while. Already-signed-in sessions were used.

## 6. Production — gokesari.com

Environment on 31 Oct 2026: `KYC_PROVIDER`, `KYC_ENV`, `SANDBOX_CO_API_KEY/SECRET` and
`SANDBOX_CO_WEBHOOK_SECRET` set by the owner. Release: migration 0123 through the Production
database workflow, then the staging → main release (one release at a time, post-deploy check).

Smoke test plan (no real Aadhaar is verified without Sanjay's go-ahead): start a session, check
the DigiLocker page opens, cancel / deny, and check the partner returns cleanly to a Failed
(declined) or Pending check.

_Result: filled in after the release._

## 7. Known failures outside this feature

The full local suite had 4 failures before #312's last commit; one was this feature's (fixed in
`e7e360df`). The other three fail on `staging` without this change too:
`tests/unit/product-import-parser.test.ts` (PUZZLES.xlsm),
`tests/integration/product-import.test.ts` ("all fields optional"),
`tests/unit/pmd-sources.test.ts` (streaming .xlsx; addressed by #311).

## 8. Needs the owner (Sanjay)

1. Sandbox.co.in: confirm DigiLocker is enabled on the **live** account (the test environment cannot run it).
2. Sandbox Console: webhook URLs `https://gokesari.com/api/webhooks/sandbox-co/digilocker` and `https://test.gokesari.com/api/webhooks/sandbox-co/digilocker`, with the secrets now set as `SANDBOX_CO_WEBHOOK_SECRET`.
3. Go-ahead for one real Aadhaar verification on production.
4. Legal review of the consent wording (version `2026-10-31-digilocker`).
5. App 1.6.0: the Android APKs (preview + production) built on #312's CI; the production APK is rebuilt on the push to `main`. The **iOS build cannot run yet**: the repository has no `EXPO_TOKEN`, no App Store Connect key (`ASC_API_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`) and `mobile/app.config.ts` has no Expo project id (setup: `mobile/README.md`, "iPhone builds from GitHub"). Once they are added, run Actions → "iPhone app" (production). Store uploads follow.
6. Provider choice: Sandbox.co.in (DigiLocker) stays the Aadhaar provider; Gridlines leaves checks Pending with the reason shown to admins.
