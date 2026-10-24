---
name: gokesari-qa-report
description: Turn GoKesari QA runs into the record — collect results into docs/testing/qa-runs, log defects in docs/testing/qa-defects.json, rebuild the master test register (every case and scenario with its status per site), write statuses back into test-cases.xlsx, update the feature tracker, and deliver the reports to the owner's folders. Use after any QA run or when asked for test results, a register or a status report.
---

# Report a GoKesari QA run

## 1. Collect each run

```bash
npx tsx scripts/qa/collect.ts --host <host> --label <short-name> [--note "what this run was"]
#   host: localhost:3000 | test.gokesari.com | gokesari.com
```

Writes `docs/testing/qa-runs/<date>-<site>-<label>.json` (latest row per case
and check, plus totals and the suite commit). Collect only clean runs (the
results folder was emptied before the run), so stale rows of renamed checks
do not leak in.

## 2. Defects

`docs/testing/qa-defects.json` — one entry per defect:
`id` (D-nn; E-nn for environment / host issues), `title`, `cases` (TC IDs),
`severity` (Blocker/High/Medium/Low/Info), `found`, `actual`, `expected`,
`fix`, `status` (Open → Fixed (re-test pending) → Fixed - retest passed;
or Not a defect / Deferred), `fixedIn` (PR), `retest` (run and result).
Evidence is the failing check's detail, screenshot and trace — quote the
request/response, never a secret or a code.

## 3. Master register

```bash
npx tsx scripts/qa/build-register.ts      # → docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx
python3 scripts/qa/plan_workbook.py statuses docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx
```

The register holds every case and scenario with automation, spec file, tier,
Local / Staging / Production / Overall status, defect and detail; sheets
Summary, Defects, Runs, Automation. `plan_workbook.py statuses` writes the
overall status into `test-cases.xlsx` (Status, Actual result, Defect, Run date)
so its Run summary is live.

## 4. Feature tracker

New features and their status go into a new dated feature status report
(`docs/gokesari-audit/GOKESARI_FEATURE_STATUS_REPORT_<YYYY-MM-DD>.xlsx`, copied
from the newest one): rows in "Feature Register" and the matching step in
"Process Flow Tree" (QA is F14.1), the PRs in "PR Register", blockers in
"Blockers & Decisions".

## 5. Where the files go (CLAUDE.md — the standard)

| What | Owner's Mac folder |
|---|---|
| Feature status report / trackers | `/Users/agtci/Documents/Doc_GoKesari/Devlopment_Trackers` |
| Test results, register, test-case workbook | `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking` |

* On the owner's Mac (the folder exists): save there (new dated file for a
  status report; update the existing tracker for test results) and keep the
  repo copy under `docs/`.
* In a cloud session: commit them under `docs/` (register in `docs/testing/`,
  status report in `docs/gokesari-audit/`), send them to the owner as files and
  say which Mac folder each belongs in. Never claim a file was saved to the Mac.

## 6. The summary for the owner

Totals per site (pass / partial / fail / blocked / manual / not run), P0
not passed, the defects (fixed and open) with their cases, what was not run on
production and why, and the next step for each open item. Plain language.
