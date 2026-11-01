# Billing v2 — blockers needing Sanjay

As of **01-Nov-2026**. Everything below is built (or will be) behind an OFF flag, so none of it stops the rest of the work; each item stops only the feature named.

| # | Blocker | What it stops | What is needed |
|---|---|---|---|
| B1 | **GSP contract and credentials** (ClearTax, Masters India, Cygnet, IRIS, Vayana…) — today `GSP_PROVIDER` accepts only the mock, refused on production | §9 entirely on live data: GSTIN connect, GSTR-1 save/file, 2B/IMS pull, 3B, ledgers, e-invoice (IRN), e-way bill; GSTR-8 push for GoKesari; flag `gsp_live`, `einvoice`, `ewaybill` | Choose a GSP; sandbox + production API credentials; GoKesari's own GSP registration as an ECO |
| B2 | **CA answers to the six §12 questions** | Switching on `tcs_engine`, `tds_engine`, `delivery_9_5` on production; restaurant s.9(5) (built, row OFF — also: state of GoKesari's registration for s.9(5) supplies, D34); PAN-only firms | Written answers; then an admin records "confirmed by CA" on each statutory row (/admin/statutory). Defaults chosen meanwhile: DECISIONS.md D7–D11 |
| B3 | **CA confirmation of Notification 09/2026-CT(R)** (s.9(5) delivery at 5% without ITC from 1 Nov 2026) | Correct delivery-fee GST from 1 Nov 2026 | Confirm the notification number, rate and "without ITC"; the dated row is in place, unconfirmed |
| B4 | **Invoice numbering format** — the seeded default LEGACY gives 25-character numbers, above the 16 allowed (Rule 46, e-invoice schema). GST16 exists. | Compliant numbers; e-invoicing | Owner/CA to approve switching `documentNumbering` to GST16 from a date (best: start of a financial year, or now with a note in GSTR-1 Table 13) |
| B5 | **Tally / Busy partner access** (Tally Solutions TDL / partner programme; Busy has no public API) | Phase 2 live Busy connector; signed Tally connector distribution | Partner agreements, or accept file-only for Busy and Marg |
| B6 | **Zoho / Odoo OAuth app registration for production** | Live Zoho / Odoo sync for every shop | Zoho API console client (India DC) and Odoo plan with JSON-2 API |
| B7 | **Native mobile release** (Play Console / App Store access, signing) | Bluetooth thermal printing, native barcode scanner, opening the POS cold with no network — native code cannot reach installed apps through the web (the offline POS itself runs in the WebView once open, D33) | Store accounts in hand for a release; the WebView carries every web feature without one |
| B8 | **Production window** | Merging billing v2 to `main` / gokesari.com | Owner-approved window (CLAUDE.md: one production release at a time); flags stay OFF after deploy |
