# Test results: image and banner audit (PR #603), 26-Nov-2026

| ID | Test | Where | Result | Time (IST) |
|---|---|---|---|---|
| IMG-01 | Daily-milk banner subject is dairy, never a diya | unit | Pass | 11.00 |
| IMG-02 | Each built-in banner has its own subject | unit | Pass | 11.00 |
| IMG-03 | Admin banner subject from linked shop type, then its words | unit | Pass | 11.00 |
| IMG-04 | Puja art only puja items; medicine art only medical items | unit | Pass | 11.00 |
| IMG-05 | Puja goods fall back to 🪔 (incl. camphor tablets) | unit | Pass | 11.00 |
| IMG-06 | Hardware / newspaper fall back to their own icon | unit | Pass | 11.00 |
| IMG-07 | Existing fallback icons unchanged | unit | Pass | 11.00 |
| IMG-08 | Homepage + tile-board regression suites (57 tests) | unit | Pass | 11.00 |
| IMG-09 | Typecheck (tsc) and eslint on changed files | local | Pass | 11.05 |
| IMG-10 | Banner slide 1 desktop: four on-subject pictures, panel filled | local server | Pass | 11.12 |
| IMG-11 | Banner slide 2 desktop: dairy only (🥛🧈🧀🍦) | local server | Pass | 11.12 |
| IMG-12 | Banner mobile 375 px: pictures clear of slide controls | local server | Fail → fixed → Pass | 11.14 |
| IMG-13 | Banner tablet 768 px | local server | Pass | 11.15 |
| IMG-14 | Broken-image check: 15 puja SVGs on gokesari.com | prod | Pass (15 × 200) | 11.03 |
| IMG-15 | Broken-image check: 15 puja SVGs on test.gokesari.com | staging | Pass (15 × 200) | 11.03 |
| IMG-16 | Staging queue: CI, deploy, post-deploy check, guest QA | test.gokesari.com | Pending (queued 11.18) | — |
| IMG-17 | Banners and product cards on test.gokesari.com | test.gokesari.com | Pending | — |
| IMG-18 | Prod release + post-deploy check + same checks | gokesari.com | Pending (23.00 window) | — |
| IMG-19 | Android / iOS app shows the new banners | apps (WebView) | Pending (after prod) | — |

Defect found and fixed: IMG-12. On phones, the slide controls covered the bottom-left banner picture. Fixed by lifting the picture area above the controls below 640 px.

Screenshots: `screenshots/` (before = gokesari.com, after = local server).
