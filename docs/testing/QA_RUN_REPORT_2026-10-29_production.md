# Production test report — gokesari.com, 29 Oct 2026

**Result: nothing in today's releases broke a public page.**

- 89 checks passed, 4 failed and 3 were blocked; 1 was skipped by rule.
- The 4 failures are a gap in the test, not the site, and the 3 blocked checks were stopped by the host firewall.

## What was tested
- **Site:** gokesari.com serving main at `4585627` (release #287, "Release 29 Oct (6)").
- **Today's releases on it:** #275, #277, #281, #282, #285, #287. The post-deploy check passed after every one of them.
- **Tier:** the guest tier, on desktop and phone (Pixel 7). It covers 68 cases in 97 rows.
- **Run:** 16:24–16:36 UTC, from a copy of main at `4585627`.
- **Safety:** nothing was signed in, ordered, paid, uploaded or submitted, and no test data was used.
- **Results:** [qa-runs/2026-10-29-production-release-2026-10-29.json](qa-runs/2026-10-29-production-release-2026-10-29.json).

## Totals

| Pass | Fail | Blocked | Skipped |
|---|---|---|---|
| 89 (67 desktop, 22 phone) | 4 | 3 | 1 (TC-QA-007, which needs the server's database) |

## Failures and blocked checks

| Checks | Verdict | What happened |
|---|---|---|
| TC-RBAC-002, TC-AUTH-033 (desktop) | **Test gap** | 7 of 194 signed-in pages answer **404** to a guest: `/admin/dealers`, `/admin/dealers/analytics`, `/claims`, `/commission`, `/admin/shops/instant-approvals`, `/dealer`, `/dealer/apply`. They belong to the dealer programme, which is switched off on production (`dealer_programme_enabled`). A switched-off page answers "not found" before it checks who is asking. |
| TC-SEC-001, TC-RBAC-002 (desktop) | **Test gap** | 25 of 368 write endpoints answer **404 `FEATURE_NOT_AVAILABLE`** instead of 401/403. They are `/api/admin/dealer*`, `/api/dealer/*` and `/api/admin/support-services`, gated by `dealer_programme_enabled` and `paid_support_services_enabled`. Confirmed by hand: `GET /api/dealer/leads` answers `{"code":"NOT_FOUND","details":{"reason":"FEATURE_NOT_AVAILABLE","feature":"dealer_programme_enabled"}}`. |
| TC-DISC-004, TC-FLD-022, TC-DISC-007 (blocked) | **Host firewall (E-01)** | A search for `<script>…` was answered 403 by the host's firewall for 80 s, not by the app. Another TC-DISC-007 row passed. |

**Nothing is exposed.** While the dealer programme and paid support services are switched off, those pages and endpoints don't exist for anyone.

The access checks in `tests/qa/guest/access.spec.ts` predate these routes, which first reached production on 28 Oct (#268). They need to accept a "feature not available" 404 as closed to a guest. Once either feature is switched on, those routes must answer 401/403 to a guest, and should be checked again then.

## Speed
No page took more than 5 s. Single requests timed: home 1.37 s, shops 0.97 s, search 0.91 s, categories 0.76 s, sign-in 0.48 s.

## Compared with the last production run (25 Oct, 96 pass)
- **Newly failing:**
  - TC-RBAC-002, TC-AUTH-033 and TC-SEC-001, all from the switched-off dealer and support-services routes (test gap).
- **Newly blocked:**
  - TC-DISC-004 and TC-FLD-022 (host firewall).
- **Still passing:** everything else that passed on 25 Oct.

## Not covered on production
- Signed-in journeys (orders, payments, shop and rider screens) are never run on production by rule.
- Today's changes are mostly signed-in features: dealers, shop documents, dealer payouts and the wizard. They need the signed-in tier on test.gokesari.com.

## Next steps
1. Update the guest access sweep to treat `FEATURE_NOT_AVAILABLE` 404s as closed. This is a small test-only change.
2. When the dealer programme or paid support services is switched on, re-run the guest tier to confirm those routes answer 401/403.
