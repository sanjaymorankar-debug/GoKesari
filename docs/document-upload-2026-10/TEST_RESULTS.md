# Test results — 13 Oct 2026 release (Tasks 1–6)

Staging = test.gokesari.com (PRs #146–#148, staging `8f638bf`). Production =
gokesari.com, released through PR #149 (main `d1e0727`), merged 06:38:50 UTC
on 13 Oct with the owner's go-ahead.

## Automated (CI on PR #146 and locally)

| Suite | Result |
|---|---|
| Unit + integration (vitest, real PostgreSQL) | **1,743 passed** locally on the full suite. 5 failures there were fixed (a CI-timing budget for the new split test; the board's approved menu count) and the affected files re-run green. CI `test` job on the final head: **pass** |
| Typecheck, lint, production build | pass |
| New: document-extract (unit) | 21/21 |
| New: document-uploads (integration, incl. real OCR + PDF) | 16/16 (after PR #147: + reader-unavailable fallback, health check) |
| New: db-split (integration, two real DBs + postgres_fdw) | 5/5 |
| New: db-split-ownership, email-brand, tile-board | 3/3, 3/3, 39/39 |
| E2E branding/footer — local production build | 16/16 |
| E2E lifecycle regression (`regression-items-a-e`) — local production build | **21/21**: order → accept → pack → rider → delivery code → delivered (wallet charged once); cancellations and refunds; open-order prompt; societies; rider KYC; vouchers; returns; slots; batching; invoices; delivery photos; acceptance timeout; crons; access control. Two of its steps had gone stale before this work (settings page became a searchable list; shop contact card moved in Seller Central) and were left out; two others were refreshed (delivery code stored hashed since 0059; cart asks "Yes, cancel it") |
| Browser flow on the local production build (`/shop/documents`, phone) | expired FSSAI photo → EXPIRED flag, submit refused; valid licence → OCR 93 %, number/name/address/expiry pre-filled → Verify & Approve → CONFIRMED, FSSAI banner cleared |
| DB split CLI on a local copy | 190 tables (90 seller, 100 customer/core), 1,885 rows, every checksum equal, 0 broken cross-database links (SAMPLE_VERIFICATION_REPORT_local.md) |

## Staging (test.gokesari.com), 03:44–03:58 UTC

| Time | Check | Result |
|---|---|---|
| 03:45 | "Test database" workflow run 38343142041: backup → migrate (0075) → verify | PASS |
| 03:47 | New build live (sign-in page carries the wordmark) | PASS |
| 03:48 | E2E branding/footer, desktop + phone, Chromium + mobile profiles | **16/16 PASS** |
| 03:51 | Sign-in code email (sanjaymorankar+gk-shop) opens with "GoKesari · Everything for Everyone" | PASS |
| 03:52 | Shop owner signs in; `/shop/documents` for a non-food shop: PAN, GSTIN, Udyam (optional), Shop Act — no FSSAI card | PASS (correct: not a food shop) |
| 03:54 | `/shop/documents` for E2E Four Features Bakery (food): FSSAI card present | PASS |
| 03:52 | Admin signs in; `/admin/document-uploads` loads | PASS |
| 03:58 | Photo upload → `POST /documents/read` | **FAIL — 504 Gateway Time-out at 60 s.** Same read is ~1 s locally/CI. Fix in PR #147: 25 s limit, then "type the details" (NOT_READ) instead of an error; admin health check `GET /api/admin/document-reader` to find the host cause |

## Staging re-check after PRs #147 and #148, 05:33–06:17 UTC

| Time | Check | Result |
|---|---|---|
| 05:33 | Admin `/admin/document-uploads` lists the earlier uploads | PASS (2 rows) |
| 05:33 | Reader health `GET /api/admin/document-reader` (after #147) | FAIL at "find language model": the model file was not in the Hostinger bundle → PR #148 ships it |
| 06:15 | Reader health after #148 | model found, OCR engine loads; **"start OCR worker" times out at 45 s** on Hostinger (open item below) |
| 06:16 | Bakery owner uploads an FSSAI photo → `POST /documents/read` | **PASS — 201 in 31 s** (was 504): NOT_READ flag, empty fields, "type the details exactly as printed" |
| 06:17 | Owner types the details → Verify & Approve | **PASS — CONFIRMED**. Also on staging: an expired licence typed in is refused (422) |
| 06:37 | CI on the release PR #149 (`test`, `scope`) | PASS |

## Production (gokesari.com), 13 Oct, 06:39–06:55 UTC

Read-only: no sign-in, no orders, no test data, no sandbox keys.

| Time | Check | Result |
|---|---|---|
| 06:39 | Baseline before deploy: `/`, `/shops`, `/search`, `/categories`, `/signin`, `/sell`, `/legal/privacy-policy`, `/api/referral-settings` | all 200; new routes 404 (old build) |
| 06:42 | New build live, 3 min after merge. Hostinger applied migration 0075 in the build (`MIGRATE_ON_BUILD`); a failed migration would have kept the old build | PASS |
| 06:43 | Same 8 pages after deploy | all **200** |
| 06:43 | `/shop/documents`, `/admin/document-uploads` | 307 → sign-in (correct when signed out) |
| 06:43 | `/api/admin/document-reader`, `/api/shops/…/documents` | 401 (correct when signed out) |
| 06:43 | Home page HTML: wordmark, "Go", "Kesari", tagline, company/GSTIN line | present |
| 06:45 | E2E branding/footer, desktop + phone, Chromium + mobile profiles | **16/16 PASS** |
| 06:50 | Screenshots, desktop and Pixel 7 | header and footer correct, except one line on a 412 px phone starting with a stray "·" (below) |

**Found on production, fixed in a follow-up PR:** on some phone widths one
footer line began with "·". Hiding a line's leading dot let that link fit on
the line above, where it needed its dot back, so the row never settled. The
fix measures lines with every dot shown, then pins each line with a
zero-height break. A new E2E check sweeps 320–1366 px: it fails on the
current production footer (reproduced) and passes with the fix (18/18 locally
on the production build).

## Open items

- ~~**OCR on Hostinger:** the OCR worker thread does not start within 45 s on
  the shared host.~~ **Fixed 15 Oct (D-18):** photos are read in the owner's
  browser (#169), released to gokesari.com — see "14–15 Oct" below.
- **Task 1 (DB split):** waiting for the seller test database details and the
  `TEST_SELLER_DATABASE_URL` / `TEST_CUSTOMER_DATABASE_URL` secrets.
  Production stays `DB_SPLIT_MODE=single`.

## Not run yet

- Customer signup → order → delivery OTP → completion **on staging** (run locally on the production build — 21/21 above; the staging pass needs the sandbox payment workflow and is next).
- Android/iOS: no native change in this release (WebView); spot-check on the preview app after staging is final.


# 14–15 Oct 2026: photos read in the owner's browser (#169, fixes D-18)

Change: [README, "Reading in the browser"](README.md). Staging = PR #169
(staging `c8e103d`). Production = #175 (another session's cherry-pick of the
same commit) and #177 (this commit, merged right after — no code change),
live on gokesari.com at 14:43 UTC on 15 Oct.

## Automated (14 Oct)

| Suite | Result |
|---|---|
| CI `test` on #169 and on #177 (full suite + production build) | pass |
| Full vitest suite, local PostgreSQL 16 | **1,762 passed** (139 files) |
| Integration `document-uploads` (5 new: browser read used and checked, expired refused, empty → UNREADABLE + small photo → LOW_QUALITY, `DOCUMENT_OCR_BROWSER=off` reads on the server, PDF unaffected) | 21/21 |
| Unit `ocr-assets-route` | 2/2 |
| E2E `document-browser-read`, local production build, desktop + Pixel 7 (read in the browser, engine `browser-tesseract`, no CSP violation; with `/api/ocr-assets` blocked the server reads it) | 4/4 |
| E2E branding/footer + smoke | 30/30 |
| E2E order lifecycle (`regression-items-a-e`) | 21/21 (the two steps stale since before 13 Oct, D-20, left out as then) |

## Staging (test.gokesari.com)

Shop owner `sanjaymorankar+gk-shop` and admin `+gk-admin`, signed in with the
real emailed codes. Shop: E2E Four Features Bakery (food, FSSAI card). A
generated FSSAI licence photo was read, checked, then discarded with "Upload
again" — never submitted, so the bakery's documents are unchanged.

| When | Check | Result |
|---|---|---|
| 14 Oct 17:30, before #169 | FSSAI photo, desktop | **FAIL (baseline, D-18)**: NOT_READ, every field empty, 31 s |
| 15 Oct, after #169 | Reader files `/api/ocr-assets/7.0.0/…`; CSP | worker, relaxed-SIMD core, English model all 200; `'wasm-unsafe-eval'` present; no CSP violation |
| 15 Oct | FSSAI photo, desktop | **PASS**: number 11521998000123, name, expiry 2027-03-31 pre-filled; NAME_MISMATCH warning (expected — the test licence's name is not the bakery owner's). 25 s on the first request after the deploy (cold start), **7.4 s** on re-run |
| 15 Oct | FSSAI photo, Pixel 7 | **PASS**: same fields, 8.4 s |
| 15 Oct | `/admin/document-uploads` | **PASS**: "File · browser-tesseract 92%" |
| 15 Oct | E2E branding/footer on test.gokesari.com | **18/18** |

## Production (gokesari.com), 15 Oct — read-only

No sign-in, no upload, no test data.

| Time (UTC) | Check | Result |
|---|---|---|
| 14:20 | Baseline: 8 public pages; `/api/ocr-assets`; CSP | 200; 404 (old build); no `'wasm-unsafe-eval'` |
| 14:43 | New build live | `/api/ocr-assets` 200 |
| 14:45 | `/`, `/shops`, `/search`, `/categories`, `/signin`, `/sell`, `/legal/privacy-policy`, `/api/referral-settings`; `/shop/documents`, `/admin/document-uploads` signed out | all 200; 307 to sign-in |
| 14:45 | Five reader files; another version | all 200 (111 KB worker, 3.9 MB cores, 2.9 MB model); other version 404 |
| 14:45 | CSP `script-src` | `'wasm-unsafe-eval'` present |
| 14:46–14:47 | The reader in Chromium on `/signin`, from gokesari.com's own files, on an image drawn in the browser (nothing uploaded) | **PASS**: "License Number : 11521998000123 / Valid Upto : 31/03/2027" at 91 % — desktop 3.9 s, Pixel 7 2.3 s; no CSP violation |
| 14:50 | E2E branding/footer on gokesari.com | **18/18** |

**Not run on production:** a real shop owner's photo upload (no test data on
production). Watch the first real upload in `/admin/document-uploads` — the
engine column should read `browser-tesseract`.

Wordmark: kept saffron ("Go" and "Kesari", bold G and K, saffron bold
tagline), as the owner confirmed on 14 Oct; branding E2E checks it on both
sites.
