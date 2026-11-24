# Order tax snapshot (migration 0184)

GoKesari prices include GST. From this release, checkout records the GST
included in each order line, so invoices, statements and the payout cycle read
the classification that applied when the order was placed.

## What is stored

| Column | Meaning |
|---|---|
| `order_items.hsn_code` | HSN of the line when ordered (listing → master product) |
| `order_items.gst_rate_bp` | GST rate (basis points): listing → master product → dated `hsn_tax_rates`; null = no rate known |
| `order_items.cess_bp` | Cess rate: listing → dated `hsn_tax_rates` |
| `order_items.taxable_paise` | Value without GST and cess |
| `order_items.tax_paise` | GST + cess included in `line_total_paise` (`taxable + tax = line total`) |
| `orders.tax_included_paise` | Sum of the lines' `tax_paise`; null when any line's rate is unknown |

- A shop that charges no GST (no GSTIN, composition, or an unverified GSTIN)
  records `taxable = line total`, `tax = 0`.
- Cess is included only while rule `invoicing.applyCess` is on (as on invoices).
- The split uses the same maths as the invoice (`tax/split.ts`), so the parts
  always add up to the line total.
- Orders placed before 0183, and orders made outside checkout (subscriptions),
  keep null.

## What does not change

- `orders.total_paise`. The included GST is never added to it.
- `orders.tax_paise` (tax charged on top of prices) stays 0. Do not put the
  included GST there.

## Who reads it

- **Confirmation e-mail:** "Prices include GST — incl. GST ₹x" under the total,
  when every line's rate is known.
- **Shop invoice** (`services/invoices.ts`): the line's snapshot HSN, rate and
  cess first, then today's classification as before.
- **Payout cycle** (`payouts/cycle.ts`): with no tax invoice, the TCS / TDS base
  is the lines' taxable value (snapshot; a substituted or older line is worked
  out of today's rate). A line with no known rate adds nothing to the base and
  is reported in the TCS line's `meta.unratedGrossPaise`. The base is never the
  GST-inclusive goods value. `meta.taxableFrom` is `TAX_INVOICE`,
  `ORDER_SNAPSHOT` or `COMPUTED`.

## Related changes in the same release

- `tcsOn` / `tdsOn` (`statutory/rates.ts`): on gokesari.com a row not yet
  confirmed by the CA in `/admin/statutory` is not applied (logged once per
  row). test.gokesari.com and local builds use it as before.
- GSTR-8 download for a manual upload: Admin → Platform invoices → Exports,
  "GSTR-8" (portal-shaped JSON, or the same rows as CSV). Permission
  `platform-invoices:manage`; every download is audited.
- GST16 invoice numbers (`GK2627-000001`, at most 14 characters) are an option
  of the `documentNumbering` GST rule at `/admin/gst-config`. It stays on
  LEGACY until switched there.

Nothing here switches on invoicing, billing v2, the TCS / TDS engines or
payouts, and no statutory rate changes.

Rollback: `scripts/rollback-0183.sql` (after deploying the previous release).
