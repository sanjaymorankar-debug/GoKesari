# Test results — 13 Oct 2026 release (Tasks 1–6)

Production (gokesari.com) was **not** touched. Staging = test.gokesari.com
after PR #146 (staging `da0f86a`).

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

## Not run yet

- Staging re-test of the upload after PR #147, and the health-check reading on Hostinger.
- Customer signup → order → delivery OTP → completion **on staging** (run locally on the production build — 21/21 above; the staging pass needs the sandbox payment workflow and is next).
- Android/iOS: no native change in this release (WebView); spot-check on the preview app after staging is final.
- Production release and smoke test — waiting for the owner's go-ahead (see the session summary).
