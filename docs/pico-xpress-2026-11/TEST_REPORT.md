# Pico Xpress — staging test report

**Site:** test.gokesari.com, release `cfc29456` (PR #677). The Pico sandbox is `dev-api.picoxpress.com`.

**Run:** 27-Nov-2026, 22.21–22.24 IST, on gk-db-1 against `gokesari_test`. The real app code was used (`picoOptionForOrder`, `planFulfilment`, `refreshPicoShipment`, `cancelPicoShipment`), with webhooks sent over public HTTPS.

**Route:** pickup at PIN 560064 (Koramangala), delivery to PIN 560002.

**Result:** 21 pass, 3 pending, 0 fail. The workbook is `PICO_XPRESS_TEST_RESULTS_2026-11-27.xlsx` in the owner's Test_Cases_Tracking folder.

| Area | Result |
|---|---|
| Stored keys | Pass. The AWB fetch answered `PX_200 SUCCESS` (22.03). |
| AWB pool | Pass. The first booking refilled 500 AWBs in 4.7 s. Nothing was reused: 497 available and 3 retired after the run. |
| Webhook token (before the allowlist) | Pass. Wrong token → 401. No token → 401. Right token → 200, event stored. Duplicate → 200, no second event. |
| IP allowlist 4.187.148.44 | Pass. Calls from any other address → 403, even with the right token. |
| PREPAID booking | Pass. Serviceable, booked in 8 s (AWB 100100236758), plan GOKESARI_PARTNER/PICO, no GoKesari rider search. Cancelled while CREATED; Pico confirmed CANCELLED. |
| COD booking | Pass. Booked in 4 s (AWB 100100236759), collectible ₹1,000.00. Cancelled while CREATED; Pico confirmed CANCELLED. |
| Pico slow or down | Pass, recovered. Order create took over 10 s three times: the booking was marked not confirmed, then the status pull found it CREATED, with no duplicate. Then Pico returned HTTP 500 ("oms-service" down) for cancel and track: a clear message was shown, and the cancel retried at 22.23 succeeded. |
| Masked API log | Pass. `clientKey`, OTPs and the customer's name and street are masked. |
| Caddy access log | Pass. The token is logged as `token=REDACTED`. |
| Rider journey (assigned → delivered) | Pending. Pico's sandbox does not move orders on its own. The automated tests cover the journey (32 integration tests). |
| Screen walkthrough (shop, customer, admin) | Pending. |
| Location webhook | Pending. It is a paid add-on and its flag is OFF. |

**Test orders:** TEST-mwz7x3px-4, TEST-mwz80h8e-4 and TEST-mwz80s7i-10. All are cancelled at Pico and in GoKesari.
