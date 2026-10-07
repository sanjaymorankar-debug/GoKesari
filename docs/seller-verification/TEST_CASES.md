# Seller verification — sandbox test cases (Deliverable 4)

Each document is tested for: valid, invalid format, expired / cancelled /
inactive, name mismatch, vendor timeout, and not found.

- **Automated against the mock vendor:**
  `tests/integration/seller-verification-sandbox-cases.test.ts` runs every row
  below on each CI run. Keep that file and this table in step.
- **Manual on test.gokesari.com:** use the numbers below while
  `KYC_PROVIDER=mock`. After switching to Gridlines sandbox keys, replace the
  "Mock number" column with Gridlines' published test values for the same
  scenarios, and record the actual results.

**Shop under test:** food shop (Dairy) at PIN 411001 (Pune, Maharashtra),
legal name "Shree Dairy". Tick the consent box for each check.

**How the mock decides:** for PAN, the four digits; for GSTIN, the four
digits of the PAN inside it; for the others, the last four digits.

| ID | Document | Scenario | Mock number | Expected status | Seller sees / reason code |
|---|---|---|---|---|---|
| PAN-1 | PAN | Valid, name matches | `ABCPE1234F` | Verified | — |
| PAN-2 | PAN | Invalid format (4th letter not a holder type) | `ABCZE1234F` | Refused before any call | "The 4th letter of a PAN…" |
| PAN-3 | PAN | Inactive at source | `ABCPE8888F` | Not verified | `document_inactive` |
| PAN-4 | PAN | Name mismatch | `ABCPE7777F` | Under review | `name_mismatch` |
| PAN-5 | PAN | Vendor timeout | `ABCPE9999F` | Checking (pending) | `vendor_timeout`; daily job retries |
| PAN-6 | PAN | Not found | `ABCPE0000F` | Not verified | `not_found_at_source` |
| GST-1 | GSTIN | Valid, active, state MH | `27AAPFU1234F1Z5` | Verified | — |
| GST-2 | GSTIN | Invalid check digit | `27AAPFU1234F1Z6` | Refused before any call | "fails its check digit" |
| GST-3 | GSTIN | Cancelled | `27AAPFU8888F1Z7` | Not verified | `document_cancelled` |
| GST-4 | GSTIN | Name mismatch | `27AAPFU7777F1ZD` | Under review | `name_mismatch` |
| GST-5 | GSTIN | Vendor timeout | `27AAPFU9999F1Z1` | Checking | `vendor_timeout` |
| GST-6 | GSTIN | Not found | `27AAPFU0000F1ZJ` | Not verified | `not_found_at_source` |
| GST-7 | GSTIN | PAN inside GSTIN ≠ shop's PAN (submit PAN-1 first, then GST-1) | `27AAPFU1234F1Z5` after PAN `ABCPE1234F` | Under review | `gstin_pan_mismatch` |
| GST-8 | GSTIN | "I'm not GST-registered" declaration | — | Under review → admin accepts → Declaration accepted | `gst_declaration_review` |
| UDY-1 | Udyam | Valid | `UDYAM-MH-26-0001234` | Verified | — |
| UDY-2 | Udyam | Invalid format | `UDYAM-MH-26-12345` | Refused | "Enter a Udyam number like…" |
| UDY-3 | Udyam | Cancelled | `UDYAM-MH-26-0008888` | Not verified | `document_cancelled` |
| UDY-4 | Udyam | Name mismatch | `UDYAM-MH-26-0007777` | Under review | `name_mismatch` |
| UDY-5 | Udyam | Vendor timeout | `UDYAM-MH-26-0009999` | Checking | `vendor_timeout` |
| UDY-6 | Udyam | Not found | `UDYAM-MH-26-0010000` | Not verified | `not_found_at_source` |
| FSS-1 | FSSAI | Valid, 2 years left | `11521001001234` | Verified | — |
| FSS-2 | FSSAI | Invalid (13 digits) | `1152100100123` | Refused | "exactly 14 digits" |
| FSS-3 | FSSAI | Expired | `11521001008888` | Expired | `document_expired` |
| FSS-4 | FSSAI | Name mismatch | `11521001007777` | Under review | `name_mismatch` |
| FSS-5 | FSSAI | Vendor timeout | `11521001009999` | Checking | `vendor_timeout` |
| FSS-6 | FSSAI | Not found | `11521001000000` | Not verified | `not_found_at_source` |
| FSS-7 | FSSAI | Expires in 20 days | `11521001006666` | Verified; the next daily run sends one expiry warning | — |
| SHA-1 | Shop Act | Maharashtra certificate (PDF), vendor can't check | `PMC/SHOP/12345` + PDF | Under review | `certificate_review` |
| SHA-2 | Shop Act | Vendor can check (mock stand-in) | `PMC/SHOP/12222` + PDF | Verified | — |
| SHA-3 | Shop Act | Placeholder number | `N/A` | Refused | "exactly as printed…" |
| SHA-4 | Shop Act | Vendor timeout | `PMC/SHOP/19999` + PDF | Checking | `vendor_timeout` |
| SHA-5 | Shop Act | Not found at source | `PMC/SHOP/10000` + PDF | Under review (certificate is the evidence) | `certificate_review` |
| SHA-6 | Shop Act | Admin rejects a mismatched certificate | SHA-1, then Reject with a reason | Not verified | `rejected_by_admin`; seller sees the reason |
| SHA-7 | Shop Act | Not a PDF or image (e.g. `.exe` renamed to `.pdf`) | any + bad file | Refused, no vendor call | "Upload the certificate as a PDF…" |
| AAD-1 | Any | Aadhaar number typed | `2341 2341 2346` | Refused | "That looks like an Aadhaar number…" |

**Scenarios outside the number table** (covered by
`tests/integration/seller-verification-flows.test.ts`):
- per-shop limit (11th paid check in an hour → "Too many document checks");
- double click (one vendor call);
- vendor outage → PENDING → daily job retries;
- GSTIN cancelled at re-check → shop suspended, orders held for review;
- FSSAI expiry → EXPIRED → shop suspended;
- an optional document lapsing → no suspension;
- erasure refused for a live shop and allowed for a closed one;
- retention-period erasure.

## With Gridlines sandbox keys

1. Set on test.gokesari.com: `KYC_PROVIDER=gridlines`, `KYC_ENV=sandbox`,
   `GRIDLINES_API_KEY=<sandbox key>` (plus `GRIDLINES_BASE_URL` if they give a
   sandbox host). Redeploy with "Settings and redeploy".
2. Run each row with Gridlines' test value for the scenario. For any row
   where the result differs, check `src/server/kyc/adapters/gridlines.ts`
   (`GRIDLINES_ENDPOINTS` and field lists). A response the adapter can't
   read shows as "Under review" with `config_unexpected_response`; nothing
   is ever wrongly verified.
3. **Timeout:** if the sandbox has no timeout scenario, set `KYC_TIMEOUT_MS=1000`
   temporarily and point `GRIDLINES_BASE_URL` at an address that doesn't
   answer. Expect "Checking" and `vendor_timeout`. Then restore both settings.
4. **Shop Act:** call the state list (if Gridlines offers one) and record
   whether Maharashtra appears. If it does, test with a real Form B number
   and a Form G receipt number.
