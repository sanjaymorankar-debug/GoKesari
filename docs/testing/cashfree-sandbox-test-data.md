# Cashfree sandbox test data (GoKesari staging)

Use these **only** with the Cashfree **sandbox** keys on test.gokesari.com
(staging). Never use real cards, real UPI IDs or real bank accounts on
staging. Never use these values, or sandbox keys, on gokesari.com
(production). Keys are never in code: they come from the environment
(`CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV=sandbox`).

**Source:** Cashfree Payments docs, "Data to Test Integration"
(https://www.cashfree.com/docs/api-reference/payments/data-to-test-integration).
It is public test data, not a secret. The owner supplied a copy on 9 Oct 2026,
captured from the page on 1 Sep 2026. If a value stops working, check that page
for the current list.

## Quick reference

| What | Value |
|---|---|
| OTP for every test card | **111000** |
| Card expiry / CVV / name (domestic test cards) | **03/2028** / **123** / **Test** |
| UPI success / failure | **testsuccess@gocash** / **testfailure@gocash** |
| Net banking test bank | **TEST Bank**, payment code **3333**, bank API code **TESTR** |
| Pay later / cardless EMI mobile | **8714268343** (any provider; cardless EMI minimum ₹1,000) |

## Test cards (INR)

| Network | Type | Variant | Card number |
|---|---|---|---|
| Visa | Credit | Premium | 4466 0502 5438 1183 |
| Visa | Credit | Corporate | 4074 9700 8434 3075 |
| Mastercard | Debit | Retail | 5409 1626 6938 1034 |
| Mastercard | Credit | Retail | 5105 1051 0510 5100 |
| Mastercard | Credit | Premium | 5242 5358 3749 2075 |
| Mastercard | Credit | Corporate | 5552 1907 5837 2734 |
| RuPay | Debit | Retail | 6074 8259 7208 3818 |
| RuPay | Credit | Retail | 6528 5912 3454 3575 |

Expiry 03/2028, CVV 123, name "Test", OTP 111000 for all of them. (The
supplied copy cut off the first rows of this table, the Visa retail cards, and
its last column; see the Cashfree page for those.)

**Already proven on GoKesari staging (8–9 Oct 2026):** these were used by
`scripts/test-site/sandbox-pay.mjs` (GitHub workflow "Sandbox payment",
`.github/workflows/sandbox-pay.yml`):
- Visa **4111 1111 1111 1111**, expiry 12/30, CVV 123, OTP 111000 (credit card);
- debit card **4706 1312 1121 2123**;
- net banking bank code **3003**;
- UPI testsuccess@gocash / testfailure@gocash.

Prefer these first, since they are known to work with our checkout.

### USD cards

| Number | Expiry | CVV | Name |
|---|---|---|---|
| 7000 0083 1380 6604 | 09/2027 | 581 | Test |
| 7000 0091 5369 7715 | 12/2021 | 591 | Test |
| 7000 0094 7240 2110 | 05/2024 | 204 | Test |
| 7000 0055 0418 0328 | 08/2026 | 324 | Test |
| 7000 0014 6659 2972 | 02/2026 | 153 | Test |

USD subscription card: 4138 6748 6000 0008, 01/2027, CVV 123, Test.
(GoKesari charges in INR only; these are listed for completeness.)

## UPI test VPAs

| VPA | Result |
|---|---|
| testsuccess@gocash | Success |
| testfailure@gocash | Failed |
| testinvalid@gocash | Invalid VPA |
| testdeclineuser@gocash | Issue from the user; ask them to retry |
| testexpired@gocash | User did not complete in time; ask them to retry |
| testtimeoutbank@gocash | Issuing bank did not respond in time; ask them to retry |
| testremitterunavailable@gocash | Remitter bank not available |
| testinsufficientfunds@gocash | Insufficient funds; retry after adding funds |
| testnetworkerror@gocash | Network infrastructure error |
| testinvalidpin@gocash | Wrong PIN; retry with the correct PIN |
| testremitterdispatchfailed@gocash | Remitter bank not available |
| testbeneficiarytimeout@gocash | Declined: slow response from beneficiary bank |
| testuserdropped@gocash | Cancelled or unattempted |
| testtransactionrisk@gocash | User's bank rejected it (risk); check with the bank |
| testfingerprintmismatch@gocash | Device fingerprint mismatch |
| testinvalidvpa@gocash | Payment instrument not set up properly |
| testbankriskrejected@gocash | User's bank rejected it (risk); check with the bank |
| testremittertimeout@gocash | Declined: slow response from remitter bank |
| testfraud@gocash | Issuer or PSP declined |
| testvalidationerror@gocash | TPV: paid from a different bank account |
| testdebitfailed@gocash | Issuer or PSP declined |
| testpspunregistered@gocash | Instrument blocked by the network |

(One row between testinsufficientfunds and testnetworkerror was cut off in
the supplied copy.)

## TPV (third-party validation) UPI

| Parameter | Value |
|---|---|
| userVPA (success) | testtpvsuccess@gocash |
| userVPA (fail) | testtpvfail@gocash |
| accountNumber | 1111222233 |
| ifsc | TEST0001234 |

(The "Test TPV net banking" table was cut off in the supplied copy.)

## Token vault test cards

Append any 10 digits to a BIN. Expiry: any future date. CVV: any 3 digits.
- Visa BINs: 470613, 457623, 436534, 415527, 466535.
- Mastercard BINs: 559423, 544405, 533983, 555219, 524877.

## EMI test cards

Expiry: any future date. CVV: any 3 digits.

| Bank | card_bank_name | Card number |
|---|---|---|
| Axis Bank | Axis | 4111 4647 7655 4152 |
| Standard Chartered | Standard Chartered | 4622 7185 3202 3725 |
| ICICI Bank | ICICI | 4748 4661 2346 7526 |
| Kotak Bank | Kotak | 4363 9070 5531 5237 |
| Bank of Baroda | BOB | 4111 5638 8133 3699 |
| AU Bank | AU | 4111 5849 6705 0056 |
| Citi Bank | CITI | 4112 5229 6265 9579 |
| Yes Bank | YES | 4111 6514 1790 3257 |
| IndusInd Bank | INDUS | 4111 5351 6094 6904 |
| HSBC Bank | HSBC | 4111 6668 0832 0291 |
| Federal Bank | FED | 4111 5924 7037 2263 |
| HDFC Bank (debit card EMI) | HDFC | 4386 2412 2321 5159 |

## Not available in the sandbox

PayPal and bank transfer. Pre-authorisation works for card and UPI through
the order-pay `link` channel: create the order with `order_note:
preauth_transaction`, then capture or void with the Preauthorisation API.

## Wallet test

Only a test wallet exists in the sandbox; there is no individual provider.

## How a staging payment is completed here

The cloud session cannot reach Cashfree directly (network policy), so the
"customer pays" step runs on a GitHub runner:
1. The test site creates the order and returns a `payment_session_id`.
2. Run the "Sandbox payment" workflow (`.github/workflows/sandbox-pay.yml`,
   `workflow_dispatch`) with inputs `session`, `instrument`
   (`upi-success`, `upi-failure`, `card-success`, `card-failure`,
   `debit-card-success`, `credit-card-success`, `netbanking-success`,
   `netbanking-failure`) and, for cards, an optional `card` number from
   this page.
3. Confirm on the site (e.g. `POST /api/wallet/verify` for a top-up).

See also docs/four-features-2026-10/README.md (T-3).
