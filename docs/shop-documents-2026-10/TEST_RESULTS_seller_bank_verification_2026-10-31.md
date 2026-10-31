# Test results: seller document checks and bank check (31 Oct 2026)

**Scope:** seller onboarding verification (PAN, GSTIN, Udyam, FSSAI, Shop Act)
and the bank account check (Cashfree Verification Suite). Payment, checkout,
wallet, refund and payout code were not touched.
**Sites:** test.gokesari.com (staging). gokesari.com: not run (see "Production").
**Code:** PR #304 (`fix/kyc-unsupported-copy`), merged into `staging` at
06:47 UTC (`05b2e447`, owner's go-ahead); test.gokesari.com built it at 06:51 UTC.
**Run by:** Claude (developer session), 31 Oct 2026. Run 1 (before the fix)
05:40–05:45 UTC; run 2 (after the deploy) 06:54–06:57 UTC. API calls from the
signed-in staging test accounts `+gk-shop`, `+gk-admin` and `+gk-lc14`
(customer), sessions from `scripts/qa/signin-staging.ts`. Sandbox.co.in and
Cashfree sandbox test numbers only; no real document or bank account was used.
**Tracker:** `docs/gokesari-audit/SELLER_BANK_VERIFICATION_TRACKER_2026-10-31.xlsx`.
Spreadsheet copy of this report: `SELLER_BANK_VERIFICATION_TEST_RESULTS_2026-10-31.xlsx`.

## Root causes

| # | Defect | Cause, in plain words | What changed | Status |
|---|---|---|---|---|
| D1 | Status message says the document can't be checked online "for your state" | Our verification vendor (Sandbox.co.in) never checks Udyam, FSSAI or Shop Act in any state; they always go to manual review. The text blamed the seller's state, which was wrong. | New text: "This document can't be checked online. Our team will review it." Wizard Shop Act notice drops "in your state". Upload path unchanged. | **Verified on Test** |
| D2 | Sandbox test PAN XXXPX1234A comes back "Under review" instead of a result | Sandbox's test server answers only a request whose body exactly matches its saved example. It returns HTTP 404 "Test environment: Request does not match any saved example" for our PAN request, although our body equals the example in Sandbox's published API spec. The saved example itself is only in the KYC Postman collection in the owner's Sandbox account. This is a test-environment limit, not a live-API defect. | #304 now logs Sandbox's answer (masked), which is how the cause was found. No change to the PAN request without seeing the saved example (a guess could break the live check). | **Blocked** |
| D3 | Sandbox test GSTIN 33ABKCS2033B1ZW comes back "Under review" | Sandbox's test server answers 33ABKCS2033B1ZW with its "Provisional" sample record (log 06:55 UTC: status "Provisional"). Our rule sends a Provisional GSTIN to a person, so the result is "Under review" by design. Sandbox's other sample GSTINs fail the GST check character, so our form refuses them before any call. | The status word is now logged so the cause is visible. No rule change without a decision. | **Blocked** |
| D4 | Bank account check never runs on test | Keys are now set (CASHFREE_VERIFICATION_CLIENT_ID / _CLIENT_SECRET / _ENV, sandbox; 2FA mode IP whitelist). Cashfree answers HTTP 401 "authentication_failed: Invalid clientId and clientSecret combination": it does not accept the ID and secret as a pair on sandbox.cashfree.com/verification. That is a credentials refusal, not an IP-whitelist or signature refusal. | No code change. The bank check runs and records ERROR with Cashfree's reason; the account stays PENDING and the ₹1 check is offered. | **Blocked** |

## Results

| # | Environment | Check | Input | Expected | Actual | Result | Time | Remaining gap |
|---|---|---|---|---|---|---|---|---|
| T1 | Test | Bank check status card (Admin → Bank accounts) | Admin session, GET /api/admin/bank-account-check | "Keys found" once the owner's Verification Suite keys are set | Run 1 05:43: Keys not found. Run 2 06:56: Keys found (CASHFREE_VERIFICATION_CLIENT_ID/_CLIENT_SECRET), env sandbox, 2FA IP whitelist | **PASS** | 0.33 s | — |
| T2 | Test | Bank check connection test (finance) | Admin session, POST /api/admin/bank-account-check/test; Cashfree sample account 026291800001191 / YESB0000262 | Cashfree answers VALID for its sample account | Run 2 06:56: Cashfree HTTP 401 "authentication_failed: Invalid clientId and clientSecret combination"; outbound IP 93.127.208.167 | **FAIL** | 2.98 s | Owner to re-copy the Verification Suite sandbox key pair |
| T3 | Test | Save a test bank account: verified/failed with a reason; ₹1 check offered when the check can't run | Customer test account, PUT /api/bank-account with Cashfree sample 026291800001191 / YESB0000262, John Doe | VERIFIED or FAILED with Cashfree's reason; ₹1 check offered on NOT_CONFIGURED/ERROR | Saved; bank check ERROR (401 reason recorded for finance); account PENDING, shown ••••1191; ₹1 check still offered | **PASS** | 3.42 s | Verified/failed outcomes need working keys |
| T4 | Test | Auth failure diagnosis (IP whitelist vs public key) | — | Report which 2FA setting is missing | 401 "Invalid clientId and clientSecret combination" = key pair refused. Not an IP-whitelist or public-key refusal; that can only be judged once the pair is accepted | **PASS** | — | Re-run after the key pair is fixed |
| T5 | Test | PAN check, Sandbox test PAN (before fix) | Wizard step 1, no GSTIN: POST /api/shops/registration-draft/pan, PAN XXXPX1234A, consent + declaration | VERIFIED with name from the record | MANUAL_REVIEW config_unexpected_response; log 05:43:17 UTC "Sandbox PAN response had no data." Request body equals Sandbox's example; UI shows XXXXXX234A only | **FAIL** | 3.53 s | Re-run after #304 deploy to capture Sandbox's actual answer |
| T6 | Test | GSTIN check, Sandbox test GSTIN (before fix) | Wizard step 1: POST /api/shops/registration-draft/gstin, GSTIN 33ABKCS2033B1ZW, consent | VERIFIED with legal name and address filled in | MANUAL_REVIEW source_status_unknown; prefill empty; UI shows 33XXXXXXXXXX1ZW only | **FAIL** | 3.85 s | Re-run after #304 deploy; status word decides whether this is the Provisional rule |
| T5b | Test | PAN check, Sandbox test PAN (after #304) | Same as T5, 06:54 UTC | VERIFIED, or Sandbox's reason recorded | MANUAL_REVIEW config_unexpected_response; log: HTTP 404 "Test environment: Request does not match any saved example" | **FAIL** | 4.44 s | Sandbox test-environment limit: needs the saved example from the owner's Sandbox Postman collection |
| T6b | Test | GSTIN check, Sandbox test GSTIN (after #304) | Same as T6, 06:55 UTC; also 29AFSPB9500E1ZY, 36AEOFS9999J1ZI, 07CQZCD1111I4Z7 | A real verified / not-verified result | 33ABKCS2033B1ZW → MANUAL_REVIEW, status word "Provisional" (Sandbox's sample). The other three are refused by our form (422, wrong GST check character) before any call | **PARTIAL** | 2.89 s | Decision on Provisional; no Active sample GSTIN with a valid check character |
| T7 | Test | Udyam / FSSAI / Shop Act message | Wizard step 2, POST /api/shops/registration-draft/documents: Udyam, FSSAI, Shop Act numbers, consent; plus one call without consent | "can't be checked online. Our team will review it", no mention of state; manual review; upload unchanged | All three MANUAL_REVIEW vendor_unsupported; text "This number can't be checked online. You can carry on — our team will review it." / Shop Act: "Shop Act numbers can't be checked online. You can carry on — after registration, upload your Shop Act certificate…"; masked numbers only. Without consent → 422 | **PASS** | 2.4–2.6 s | Seller panel (existing shops) text checked in code/tests, not opened in the browser |
| T8 | Test (local + CI) | Both database layouts | Unit + verification integration suites | All pass on one database and on the split | Local 154/154 one DB, 202/202 split; CI test and test-split pass | **PASS** | CI ~45 min | — |
| T9 | Prod | Copy fix on gokesari.com | — | New message live | Not deployed: rides with release #302 (owner window) | **NOT RUN** | — | Owner's release window |
| T10 | Prod | PAN and GSTIN with the owner's real documents | — | VERIFIED or not verified from the live record | Not run: no real documents supplied; test numbers never used on prod | **NOT RUN** | — | Owner's own PAN/GSTIN and bank account |
| T11 | Android / iOS | Onboarding journey in the apps | — | New text shows in both apps | Apps are a WebView of the site: no build needed. Not run in the apps | **NOT RUN** | — | Run in the apps after the web deploy |

## Other checks

| Check | Result | How |
|---|---|---|
| Logs carry no full PAN, GSTIN, Udyam, FSSAI, Shop Act or bank number | **Pass** (one hardening) | Every `console.*` and error message in `src/server/kyc`, the bank check, seller verification and the wizard was read; none prints a full number. Cashfree's error message was stored as written, so digit runs of 5 or more are now masked. The new Sandbox log lines on test (06:54, 06:55 UTC) carry no number. The ₹1 check's order and refund logs (`bank-accounts.ts`) send no account number; they are payment code and were left alone. |
| Retries only for temporary errors; a timeout keeps the document "Checking" | **Pass** | `src/server/kyc/http.ts` retries timeouts, network errors, 408, 429 and 5xx only. 401/403/406 are not retried. A timeout returns PENDING with `vendor_timeout`: "The government service is slow right now. We'll keep trying automatically." |
| Consent gates every check | **Pass** | The server refuses the PAN, GSTIN and step-2 checks without consent; live on test, a step-2 call without consent returned 422. |
| Numbers encrypted at rest; only masked values in the UI | **Pass** | PAN encrypted with `PAN_ENCRYPTION_KEY`. Test API answers showed only `XXXXXX234A`, `33XXXXXXXXXX1ZW`, `UDYAM-MH-XXXXXX2977`, `XXXXXXXXXX0187`, `XXXXXXXXXXXX0001`, `••••1191`. No key was rotated. |
| Both database layouts | **Pass** | Local: 154 passed on one database, 202 on the split. CI on #304: `test` and `test-split` passed. |
| Android and iOS apps | **No build needed** | Both apps show the website in a WebView (`mobile/README.md`), so the new text reaches both with the web deploy. Not run inside the apps. |

## Production (gokesari.com)

Not run. The copy fix reaches gokesari.com with the next staging → main
release (draft PR #302, waiting for the owner's window; #304 is now part of
it). PAN and GSTIN on production need real documents belonging to the shop
owner being tested; none was supplied, and test numbers are never used there.

## Blocked: decisions needed

1. **Bank check key pair (test):** Cashfree refuses the Client ID and Secret
   now on test.gokesari.com as a pair (401 "Invalid clientId and clientSecret
   combination"). Re-copy both from the Cashfree dashboard's **Verification
   Suite / Secure ID, sandbox** section, as one pair (not the payment-gateway
   App ID / Secret, not production keys), and replace the two values one at a
   time in hPanel. After that, if Cashfree refuses the server address,
   whitelist **93.127.208.167** or set `CASHFREE_VERIFICATION_PUBLIC_KEY`.
2. **Sandbox PAN on test:** Sandbox's test server does not match our PAN
   request to its saved example. Either open the KYC Postman collection in
   your Sandbox account (or ask Sandbox support) and send the exact saved
   "Search PAN Lite" request body, or accept that PAN is proven on production
   with your own PAN.
3. **Provisional GSTINs:** keep sending them to the team (current), or treat
   "Provisional" as verified?
4. **Production tests:** your own PAN and GSTIN, and a bank account in your
   name, for the prod run.

## Test data left on staging

- `+gk-shop`: an open registration draft (PAN-only route) with Udyam, FSSAI
  and Shop Act checks in manual review.
- `+gk-admin`: an open registration draft (GSTIN route).
- `+gk-lc14` (customer): refund bank account `••••1191` (Cashfree's sample
  account), status Pending.
