# GoKesari — manual test workbook

The workbook a person fills in while testing **test.gokesari.com** by hand:
every test scenario and test case, with columns for the actual result, status,
defect and evidence, and a live summary. First built 20-Nov-2026; **version 2.0 of 23-Nov-2026**
(`GOKESARI_MANUAL_TEST_WORKBOOK_2026-11-23.xlsx`: 383 scenarios, 1,631 cases, 63 journeys).

Owner's copy: `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking/GOKESARI_MANUAL_TEST_WORKBOOK_2026-11-23.xlsx`
(with an `Evidence/` folder next to it for screenshots and recordings). The 20-Nov file (version 1.1)
stays there unchanged.

## Versions

Each issue of the workbook has a version on its Cover sheet and a line in the Revision history, both
read from [`revisions.json`](revisions.json); the file name carries the build date. A major version
(2.0) adds cases or changes what is tested; a minor one (1.1) refreshes results or wording. To issue a
new version: add a line to `revisions.json`, then rebuild with `--date <today>`. The training deck for
the testing team follows the same scheme: [`deck/`](deck/) (`GoKesari_Testing_Techniques_Training_v<version>_<date>.pptx`,
version history on slide 2).

| Version | Date | Workbook |
|---|---|---|
| 1.0 | 20-Nov-2026 | First issue: 290 scenarios, 1,048 cases, 47 journeys |
| 1.1 | 22-Nov-2026 | 313 scenarios, 1,159 cases, 52 journeys (dealers, newspapers, consultants, Health, welcome kit) |
| 2.0 | 23-Nov-2026 | 383 scenarios, 1,631 cases, 63 journeys: features on staging 20 to 23 Nov (below) |

## Structure (ISO/IEC/IEEE 29119-3)

| Sheet | 29119-3 document | What it holds |
|---|---|---|
| Cover | Document control | ID, version, build and cycle under test, revision history, contents |
| How to use | — | Legend (amber = fill in), status and severity definitions, evidence rules and naming, worked example rows |
| Test Plan | Test plan | Scope, approach, environment, test accounts, test data, entry / exit / suspension criteria, risks, roles |
| Summary | Test status report | Live counts overall, by module, by priority; E2E; defects by severity; exit criteria Met / Not met |
| Test Scenarios | Test design specification (test conditions) | 383 scenarios (TS-…), each with its TC IDs and a live status |
| Test Cases | Test case specification + test procedure | 1,631 cases (TC-…): steps, data, expected; amber result and evidence columns |
| E2E Scenarios | Test procedure (journeys) | 63 end-to-end journeys (SC-01 … SC-63) |
| Execution Log | Test execution log | One row per run of a case, re-runs and retests included |
| Evidence Register | Test execution evidence | One row per evidence file, with a clickable link |
| Defect Log | Incident report | Severity, steps, expected / actual, evidence, fix reference, retest |
| Traceability | Requirements traceability | 409 features / decisions → scenarios → cases → live coverage status |
| Sign-off | Test completion report | Results, risks, Go / No-go recommendation, approvals |

## Where the content comes from

| Source | What |
|---|---|
| `tests/qa/catalog/cases.json`, `scenarios.json` | The plan, exported from `test-cases.xlsx`: 1,631 cases and 63 journeys — the 875 cases and 37 journeys of 08-Nov-2026 plus everything added on 20-Nov-2026 and 23-Nov-2026 (below) |
| `test-scenarios.json` (here) | Grouping of the cases into 313 test scenarios (TS-PRE-01 …; TS-…-12 onwards, TS-TERR-01 … 05, TS-SUB-07, TS-CON-01 … 08, TS-HLT-01 … 07 and TS-WKIT-01 for the 20-Nov cases) |
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

Added later on 20-Nov-2026, after PR #419 and #420 reached staging (record:
`cases-added-2026-11-20-dealers.json`, 36 cases, 6 scenarios, 2 journeys, 6 features):

- **Territory dealers** (DT-24 … DT-27, PR #419, rule `territoryDealer` off by default):
  TC-TERR-001 … 026 in TS-TERR-01 … 05 — giving a territory and its exclusive pincodes,
  the yearly fee (online / offline, renewal window, lapse, grace and release), the daily
  rating and the 20–25 % share, order income at month close, access and the dealer's card;
  journey SC-48.
- **Team leads add agents; the main dealer promotes an agent** (DT-28, DT-29, PR #420):
  TC-TIER-033 … 042 in TS-DLR-18; journey SC-49.
- Added with `plan_workbook.py add-json docs/testing/manual/cases-added-2026-11-20-dealers.json`
  and automated as local-tier checks (`tests/qa/local/dealer-territory-2026-11.spec.ts`,
  `dealer-team-2026-11.spec.ts`, `tests/qa/scenarios/SC-48-*`, `SC-49-*`). Automating them
  showed 11 fields to correct against the code (`code-check-2026-11-20-dealers.json`, one
  Change log line each) and 5 defects (D-154 … D-158).

Also on staging on 20-Nov-2026, added to the plan by their own PRs:

- **Newspaper and periodical subscriptions** (PR #423, `cases-added-2026-11-20-newspapers.json`):
  TC-SUB-020 … 027 in TS-SUB-07.
- **Consultant appointments** (PR #425, fix #433, `cases-added-2026-11-20-consult.json`):
  TC-CON-001 … 026 in TS-CON-01 … 08; journeys SC-50 and SC-51.
- **GoKesari Health** (PR #429, `cases-added-2026-11-20-health.json`): TC-HLT-001 … in
  TS-HLT-01 … 07 (28 cases, 13 features HLT-01 … 13, no journeys); its PR also added its
  scenarios here.
- **Shop welcome kit and QR banner** (PR #431, `cases-added-2026-11-20-welcome-kit.json`):
  TC-WKIT-001 … 013 in TS-WKIT-01; journey SC-WKIT-01. Its scenario was copied in here from
  that file (the PR added the cases to the plan only).
- Those PRs added the cases to the plan but not their scenarios to `test-scenarios.json`,
  so this builder stopped ("cases without a scenario"); the 9 scenarios were copied in
  from the two files, each with the cases that name it.

## Added on 23-Nov-2026 (version 2.0)

Record: `cases-added-2026-11-23.json` (472 cases, 70 scenarios, 11 journeys SC-53 … SC-63, 97 features,
36 overrides). The features, their functions and the main code findings are in
[`FEATURES_AND_CASES_2026-11-23.md`](FEATURES_AND_CASES_2026-11-23.md). In short:

- **Features on staging 20 to 23 Nov that had no cases** (PRs #427 … #503): Puja Samagri (TC-PUJA), admin
  menu (TC-ADM-023 …), banner wording (TC-WKIT-014 …), mailbox rotation (TC-NTF-021 …), shop documents and
  FSSAI (TC-DOC), Health specialties (TC-HLT-033 …), franchise zones (TC-FRN), referral moves (TC-REFM),
  dealership platform (TC-DPLT), smart shopping (TC-SMART), voice price assistant (TC-VPA), shop logo
  (TC-LOGO), society join requests (TC-SOC-018 …), staff roles RBAC v2 (TC-STAFF).
- Written by reading each PR and the code on `origin/staging` (d9cef71e); where the code differs from the
  PR or the brief, the case follows the code and the note is in `code-check-2026-11-23.json` (75).
  Results other sessions already recorded for these cases: `evidence-2026-11-23.json` (119).
- **Overrides:** the territory cases (TC-TERR-003 … 024, 026 retired: territory = franchise, 21-Nov; a case
  whose Expected result starts "Not applicable since" starts Not Applicable in the workbook), the FSSAI
  onboarding cases (DF-08), TC-CON-019 / 020, TC-CAT-093, TC-TIER-010. Journey SC-39 now uses a pharmacy.
- The welcome-kit journey is **SC-52** in the plan as well (fix #431 had renamed it in the catalog only).
- Added with `python3 scripts/qa/plan_workbook.py add-json docs/testing/manual/cases-added-2026-11-23.json`,
  exported with `scripts/qa/export-cases.ts`, and declared as manual in
  `tests/qa/signed-in/features-2026-11-23.spec.ts` until they are automated.

## Rebuild

```bash
node --import tsx scripts/qa/build-manual-workbook.ts --date 2026-11-23
```

(`npx tsx` also works outside the Claude sandbox.) Rebuilding gives an **empty**
template — copy results from a filled workbook by TC ID if you rebuild mid-cycle.
