# GoKesari — manual test workbook

The workbook a person fills in while testing **test.gokesari.com** by hand:
every test scenario and test case, with columns for the actual result, status,
defect and evidence, and a live summary. Built 20-Nov-2026.

Owner's copy: `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking/GOKESARI_MANUAL_TEST_WORKBOOK_2026-11-20.xlsx`
(with an `Evidence/` folder next to it for screenshots and recordings).

## Structure (ISO/IEC/IEEE 29119-3)

| Sheet | 29119-3 document | What it holds |
|---|---|---|
| Cover | Document control | ID, version, build and cycle under test, revision history, contents |
| How to use | — | Legend (amber = fill in), status and severity definitions, evidence rules and naming, worked example rows |
| Test Plan | Test plan | Scope, approach, environment, test accounts, test data, entry / exit / suspension criteria, risks, roles |
| Summary | Test status report | Live counts overall, by module, by priority; E2E; defects by severity; exit criteria Met / Not met |
| Test Scenarios | Test design specification (test conditions) | 290 scenarios (TS-…), each with its TC IDs and a live status |
| Test Cases | Test case specification + test procedure | 1,048 cases (TC-…): steps, data, expected; amber result and evidence columns |
| E2E Scenarios | Test procedure (journeys) | 47 end-to-end journeys (SC-01 … SC-47) |
| Execution Log | Test execution log | One row per run of a case, re-runs and retests included |
| Evidence Register | Test execution evidence | One row per evidence file, with a clickable link |
| Defect Log | Incident report | Severity, steps, expected / actual, evidence, fix reference, retest |
| Traceability | Requirements traceability | 261 features / decisions → scenarios → cases → live coverage status |
| Sign-off | Test completion report | Results, risks, Go / No-go recommendation, approvals |

## Where the content comes from

| Source | What |
|---|---|
| `tests/qa/catalog/cases.json`, `scenarios.json` | The plan, exported from `test-cases.xlsx`: 1,048 cases and 47 journeys — the 875 cases and 37 journeys of 08-Nov-2026 plus everything added on 20-Nov-2026 (below) |
| `test-scenarios.json` (here) | Grouping of the cases into 290 test scenarios (TS-PRE-01 …; TS-…-12 onwards for the 20-Nov cases) |
| `docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx` | Automation status and latest automated staging result (grey reference columns) |
| `test-cases.xlsx` → Coverage | Feature list for the Traceability sheet |

Added on 20-Nov-2026 (record: `cases-added-2026-11-20.json`, 173 cases, 46 scenarios, 10 journeys
SC-38 … SC-47 and 6 corrections):

- **Features on staging after the 08-Nov plan** (Case origin "New"): identity-first shop
  registration (DI-11 … DI-14, P2-D1 … D6), KYC provider outcomes, licence grace and
  auto-suspension, registration reminders, guided product set-up and listing statuses,
  the product-import template (PU-01 … 05), setup Excel, starter shelf, barcode scan,
  how-you-deliver, rider DigiLocker, bank-account check and rider payouts / TDS 194C,
  Billing v2, Seller Central, gateway checks, manufacturer portal, referral requests,
  and retests of the 09–20 Nov fixes.
- **Dealer commission, current structure incl. work under build**: 20 / 4 / 3 %
  (DT-13 … DT-23; the 3% main-dealer share is PR #417, in the staging queue on 20-Nov),
  renewals, target bonus, promotion and development bonus, team management, live
  dashboard and team reports, month close, payouts, holds and reversals
  (TC-TIER-012 … 032, SC-41, SC-45). TC-TIER-012 … 014 note that they need PR #417.
- **Planned features, not built yet** (Case origin "Planned"): onboarding Wave 2 / 3
  (WP6 referral help by PIN, WP7 assisted mode, WP8 Hindi / Marathi, WP9 SMS OTP,
  WP10 scan-first + DigiLocker) and R3 (D-130, D-136, D-138, D-141, D-144). They start
  as **Not Applicable** with the release in Remarks; set them to Not Run when the
  feature reaches staging, and check the Expected result against the built screens.
- **Corrections** (`overrides`) to plan cases written for the earlier dealer structure:
  TC-TIER-002, 005, 006, 007, 011 (now DT-13 … DT-23) and TC-SREF-003 (10% off ₹999 is
  ₹899.10). Case origin says what changed.

Before they went into the plan, every Expected result (and the labels, routes and
numbers in Steps / Preconditions) was checked against the code on `origin/staging`
(with PR #417): 173 fields of 106 cases and journeys were reworded to match the code, and 15
places where the code itself looks wrong were noted — all in
`code-check-2026-11-20.json` (old / new text, reason, file and line). The plan's
Change log has one line per corrected case.

How they reached the plan and the suite:

- `python3 scripts/qa/plan_workbook.py add-json docs/testing/manual/cases-added-2026-11-20.json docs/testing/manual/code-check-2026-11-20.json`
  adds them to `test-cases.xlsx` (Test cases, E2E scenarios with Preconditions / Origin,
  Coverage, Run summary, Change log) and applies the overrides; `scripts/qa/export-cases.ts`
  then writes `tests/qa/catalog`.
- A case's Source in the plan starts "Added 20-Nov-2026" (on staging) or "Planned - …"
  (not built yet; journeys say the same in Origin). This builder reads that back for
  Case origin and the Not Applicable start; it no longer reads `cases-added-*.json`, so
  nothing is counted twice.
- Every new ID is automated in `tests/qa` or declared `manual()` with its reason;
  planned ones are declared in `tests/qa/guest/planned-features.spec.ts`
  ("feature not on staging yet (R4 – WP6)" …) and show as "Planned (not built)" in the
  master register.

## Rebuild

```bash
node --import tsx scripts/qa/build-manual-workbook.ts --date 2026-11-20
```

(`npx tsx` also works outside the Claude sandbox.) Rebuilding gives an **empty**
template — copy results from a filled workbook by TC ID if you rebuild mid-cycle.
