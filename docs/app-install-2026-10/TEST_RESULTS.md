# App install prompt and app updates — test results (31 Oct 2026)

Owner's copy: `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking/APP_INSTALL_UPDATE_TEST_RESULTS_2026-10-31.xlsx`.

| Case | Test | Device / browser | Local | Test site | Prod |
|---|---|---|---|---|---|
| TC-APP-001 | First visit shows the prompt | Android Chrome profile (Pixel 7) | Pass | waits for deploy | waits for release |
| TC-APP-002 | Not now hides it for this page view; decline counted | Android Chrome profile | Pass | waits | waits |
| TC-APP-003 | Shown again on visits 2 and 3 | Android Chrome profile | Pass | waits | waits |
| TC-APP-004 | Install → Chrome's dialog; none after install | Android profile, synthetic install events | Pass (real dialog: manual) | waits | waits |
| TC-APP-005 | Installed → no prompt | installed flag | Pass | waits | waits |
| TC-APP-006 | No prompt inside the native app | GoKesariApp UA, Android + iPhone | Pass | waits | waits |
| TC-APP-007 | iPhone Add to Home Screen guide | iPhone 15 profile | Pass (real Safari: manual) | waits | waits |
| TC-APP-008 | Account record; guest 401 | integration, one DB + split | Pass | waits | waits |
| TC-APP-009 | /sw.js fresh, versioned cache | API | Pass | waits | waits |
| TC-APP-010 | New deploy → Reload → new version | local restart = new build | Pass | after deploy | after release |
| TC-APP-011 | /api/app/version | API | Pass | waits | waits |
| TC-APP-012 | Native app update offered and installed | phone with app 1.5.0 | Manual (logic: mobile unit tests pass) | manual | manual |
| TC-APP-013 | Sheet fits the phone screen | iPhone 15 profile | Pass | waits | waits |

Automated: unit 10/10, integration 7/7 on both database layouts, mobile 47/47,
QA 5/5 (2 manual). Defects: none in this feature. Two unit tests
(pmd-sources, product-import-parser) fail locally on staging as well —
not related.
