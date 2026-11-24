# Tax register (migration 0185, flag `tax_register`)

One place where the tax settings are kept under maker-checker. The **Accountant** proposes, and the **CA** approves (never their own proposal). Approved changes are applied at once through each setting's own service, so there is still one copy of every value.

## Screens

`/staff/tax` is open to the Accountant, the CA and admins. It is on the staff board under "Tax and statutory" and in the admin menu.

| Tab | What it shows |
|---|---|
| Settings | Every tax setting, its value in force and whether the CA approved that value. The Accountant can send current values for approval, or propose a change. |
| Changes | The proposals. The CA approves and applies, or sends back with a note. The proposer can submit again after a send-back, or withdraw. |
| CA items | Questions for the CA. The Accountant writes the answer from the CA's advice and sends it; the CA approves or sends back. Each item has a notes thread. |
| Switches | The switches the CA items hold back. A switch is "cleared by CA" once all its items are approved. |

## What it covers

| Change kind | Applied through |
|---|---|
| `STATUTORY_ROW`, `STATUTORY_CONFIRM` | `statutory/rates.ts` (TCS s.52, TDS 194-O, s.9(5), unregistered-seller rules, GST on fees). The new row is confirmed by the CA. |
| `COMMISSION_TDS_ROW`, `COMMISSION_TDS_CONFIRM` | `tax/commission-tds.ts`. The new row is confirmed by the CA. |
| `GST_RULE` | `gst/config.ts` (`setGstRule`) |
| `HSN_RATES` | `gst/config.ts` (`setHsnRate`), from a CSV |
| `PRODUCT_GST` | `gst/product-rates.ts` (`setProductGst`), from a CSV of product id, HSN and GST % |
| `RULE_FIELDS` | The tax fields of the admin settings (`tax-register/rules.ts` `TAX_RULE_FIELDS`): invoicing default GST and cess, rider TDS 194C, composition rates and the billing switches, GoKesari's GSTIN / PAN / state / SAC codes, Prime-plan GST, dealer TDS on/off |
| `FRANCHISE_GST` | `franchise/config.ts` |
| `APPROVE_CURRENT` | The CA approves current values as they are. Statutory and TDS rows are confirmed; the other settings get an approval record. |

Settings kept in the admin settings apply on approval. Dated settings keep their own effective dates.

## Approval

- **Statutory and TDS rows** use their `confirmed_by_ca` flag.
- **Other settings** use `tax_param_approvals`. A value is approved while it equals the last approved value; changing it anywhere needs a new approval.

## Rules

- **Who decides:** only the CA role approves or sends back, never on their own proposal or answer. Admins can propose but cannot approve.
- **If applying fails:** the request becomes `APPLY_FAILED` with the reason. The CA can approve it again, or send it back.
- **Audit:** every step is audited (`tax_change.event`, `ca_item.changed`).
- **Flag `tax_register` OFF (default):** the register works, and the admin screens still edit directly as before.
- **Flag `tax_register` ON:** the admin screens refuse direct edits of these settings and point to the register:
  - statutory settings, TDS rows, GST rules and HSN rates;
  - product GST;
  - the tax fields of the settings;
  - franchise GST.

## Loading CA items

The question wording is kept outside the repository and loaded with:

```bash
npx tsx scripts/tax-register/load-ca-items.ts <items.json> <accountant-or-admin-user-id>
```

New refs are added; existing refs are left as they are.

## Rollback

`scripts/rollback-0185.sql`, after deploying the previous release. Values already changed through the register stay, since they live in their own tables.
