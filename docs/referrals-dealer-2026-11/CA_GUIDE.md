# CA guide — TDS on dealer and team-member commission

03-Nov-2026. Page: **https://gokesari.com/admin/tds-commission** (sign in with the account an admin
gave the *Chartered Accountant* role). Read-only payout reports:
`/api/admin/dealer-payout-reports?report=summary&format=xlsx` (also `lines`, `pending`, `failed`).

## What you can do

* **TDS rows** — dated, by payee type (individual, firm, company, any) and PAN status: rate, annual
  threshold, mode, the section (free text — please give the section under the Income-tax Act 2025),
  effective from. Adding a row closes the previous one of the same kind the day before.
  **Confirm (CA)** marks a row confirmed; only the CA can. An unconfirmed row blocks paying.
* **Modes** — CATCH_UP: once a PAN's commission in the financial year passes the threshold, the
  whole year is taxed, less TDS already deducted. EXCESS_ONLY: only the part above the threshold.
* **Certificates** — a payee's lower / nil deduction certificate: number, rate, validity, the amount
  it covers (the payee's PAN key comes from the team mapping; the PAN itself is not typed here).
* **Challans** — month, section, amount, BSR code, challan serial, deposit date.
* **Downloads** — monthly TDS per payee (CSV); the quarterly **26Q data** (CSV with full PANs — the
  download is logged); the Form 16A tracker per quarter.
* **Form 16A** — upload the PDF per payee and quarter; the payee downloads it from their dealer page.
* **Exceptions** — payouts with an unconfirmed or missing row (and whether an admin overrode it),
  reversals crossing a financial year, payees held without a PAN.

## What we need from you

1. The section and rates for commission (old 194H; 206AA without PAN) under the 2025 Act.
2. Threshold (₹20,000 starting value) and CATCH_UP vs EXCESS_ONLY.
3. Treatment of a reversal of commission paid in an earlier financial year (flagged
   REVERSAL_PRIOR_FY; nothing is adjusted automatically across years).
4. GST on commission: invoices from registered dealers; self-invoice / RCM for unregistered ones.

You cannot approve, pay or change dealer commission rules.
