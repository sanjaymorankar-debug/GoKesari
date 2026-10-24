"""
Keeps the test plan workbook (test-cases.xlsx) in step with the QA suite.

  python3 scripts/qa/plan_workbook.py add-qa-cases          # the QA-automation module (24 Oct 2026)
  python3 scripts/qa/plan_workbook.py statuses REGISTER.xlsx  # write each case's overall status back

add-qa-cases adds the cases and scenarios of the QA automation features
(QA-010 … QA-014) once — rows that already exist are left alone — and
extends the Run summary, Coverage and Change log sheets, the Status
drop-down and the filter to the new rows.

statuses copies the master register's Overall status and detail into the
plan's Status / Actual result / Defect / Run date columns (Pass (partial) is
written as Pass with the uncovered part in Actual result; Manual as Blocked),
so the workbook's own Run summary counts are live.

openpyxl keeps the workbook's formulas, styles and validations; run
scripts/qa/export-cases.ts afterwards so tests/qa/catalog matches.
"""
import re
import sys
from copy import copy

import openpyxl

PLAN = "test-cases.xlsx"
MODULE = "QA automation"

QA_CASES = [
    # id, features, title, type, priority, role, method, preconditions, steps, expected
    ("TC-QA-001", "QA-010, QA-003", "Every case of the plan is declared in the QA suite", "Positive", "P0", "All", "API",
     "tests/qa/catalog exported from this workbook",
     "1. List every TC and SC ID of the catalog\n2. Scan tests/qa/**/*.spec.ts for qa() and manual() declarations",
     "Every ID is declared at least once - automated as a check, or declared manual() with the reason. No ID of the plan is silently missing."),
    ("TC-QA-002", "QA-010", "Writing and local tiers never run on production", "Negative", "P0", "All", "API",
     "Suite pointed at https://gokesari.com",
     "1. Run the suite against gokesari.com\n2. Read the recorded rows of signed-in and local checks",
     "Every signed / local check is recorded 'skipped: not run on production'; the write helpers refuse production (assertWritable). Only GETs and requests the server must refuse reach gokesari.com."),
    ("TC-QA-003", "QA-010", "Each check records its case result", "Positive", "P1", "All", "API",
     "A finished run",
     "1. Read test-results/qa/<host>/*.jsonl\n2. Check one row per case per check",
     "Each row has the case ID, title, status (pass / fail / blocked / skipped), detail, tier, site, spec file and time; a failed or timed-out check is recorded as fail with its reason."),
    ("TC-QA-004", "QA-012", "Master register lists every case and scenario with a status per site", "Positive", "P0", "All", "API",
     "At least one collected run in docs/testing/qa-runs",
     "1. npx tsx scripts/qa/build-register.ts\n2. Open the workbook",
     "Test cases and E2E scenarios sheets hold every case and scenario of the plan once, each with Local, Staging, Production and Overall status, automation and spec file; Summary, Defects and Runs sheets are filled."),
    ("TC-QA-005", "QA-011", "Claude QA agent and skills are installed", "Positive", "P1", "All", "UI",
     "Repository checkout",
     "1. Open .claude/agents/gokesari-qa.md and .claude/skills/gokesari-qa-*/SKILL.md",
     "The agent and each skill have a name and description; the skills cover running the suite, signing the staging accounts in, writing a check and reporting."),
    ("TC-QA-006", "QA-013", "Scheduled QA workflow runs the production-safe tier on both sites", "Positive", "P1", "All", "UI",
     "Workflow .github/workflows/qa.yml on main",
     "1. Read the workflow's schedule and jobs\n2. Run it by hand once",
     "Scheduled weekly (Monday) and runnable by hand; runs tests/qa/guest against test.gokesari.com and gokesari.com and keeps the results as an artifact; never signs in or writes. By hand it can also run the whole suite on a server built from the commit."),
    ("TC-QA-007", "QA-014", "Local QA environment brings up the test data of the plan", "Positive", "P1", "Admin", "DB",
     "Local PostgreSQL and a built app",
     "1. bash scripts/qa/local-up.sh 3000 gk_qa\n2. Read test-results/qa/world-localhost_3000.json",
     "Database migrated and seeded; mail catcher and server up; the world file names every account of the Test data sheet (2 customers, 3 shop owners + a pending one, 2 riders, admin, operator, operator-limited, society admin), 4 shops and the listings the cases need."),
]

QA_SCENARIOS = [
    ("SC-36", "Release check on both sites", "QA-010, QA-012, QA-013", "P0",
     "1. The release reaches test.gokesari.com\n2. The production-safe and signed-in tiers run there; defects are fixed and re-deployed\n3. The release reaches gokesari.com\n4. The production-safe tier runs there\n5. The register is rebuilt",
     "The same suite commit has a staging run and a production run in docs/testing/qa-runs, and the register shows each case's status on both sites."),
    ("SC-37", "Signed-in test run by the Claude QA agent", "QA-011, QA-010", "P1",
     "1. The agent signs the staging test accounts in with the emailed codes (owner's mailbox)\n2. It runs the signed-in tier on test.gokesari.com\n3. It collects the results and rebuilds the register",
     "A staging run with signed-in checks that passed (so the sessions worked), collected into docs/testing/qa-runs."),
]

COVERAGE = [
    ("QA-010", "QA", "Automated QA suite: the 791-case plan as UI + API checks (tests/qa), tiers guest / signed / local", "COMPLETED (24-Oct)", "TC-QA-001, TC-QA-002, TC-QA-003, SC-36, SC-37"),
    ("QA-011", "QA", "Claude QA agent and skills (.claude/agents/gokesari-qa.md, .claude/skills/gokesari-qa-*)", "COMPLETED (24-Oct)", "TC-QA-005, SC-37"),
    ("QA-012", "QA", "Master test register with execution status per site (docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx)", "COMPLETED (24-Oct)", "TC-QA-004, SC-36"),
    ("QA-013", "QA", "Scheduled QA workflow (weekly + by hand): production-safe tier on test.gokesari.com and gokesari.com; whole suite on a local build by hand", "COMPLETED (24-Oct)", "TC-QA-006, SC-36"),
    ("QA-014", "QA", "Local QA environment: seeded test data, local mail catcher, one-command setup", "COMPLETED (24-Oct)", "TC-QA-007"),
]


def copy_style(src, dst):
    if src.has_style:
        dst.font = copy(src.font)
        dst.fill = copy(src.fill)
        dst.border = copy(src.border)
        dst.alignment = copy(src.alignment)
        dst.number_format = src.number_format


def append_like(ws, values, template_row):
    row = ws.max_row + 1
    for col, value in enumerate(values, start=1):
        cell = ws.cell(row=row, column=col, value=value)
        copy_style(ws.cell(row=template_row, column=col), cell)
    return row


def ids_in(ws):
    return {ws.cell(row=r, column=1).value for r in range(2, ws.max_row + 1)}


def add_qa_cases():
    wb = openpyxl.load_workbook(PLAN)
    tc = wb["Test cases"]
    have = ids_in(tc)
    template = tc.max_row
    added = 0
    for case in QA_CASES:
        if case[0] in have:
            continue
        cid, features, title, typ, prio, role, method, pre, steps, expected = case
        append_like(tc, [cid, MODULE, features, title, typ, prio, role, method, pre, steps, expected,
                         "QA automation, 24 Oct 2026 (tests/qa/README.md)", "Not run", None, None, None], template)
        added += 1
    last = tc.max_row
    # Status drop-down and filter reach the new rows.
    for dv in tc.data_validations.dataValidation:
        if "M2:M" in str(dv.sqref):
            dv.sqref = openpyxl.worksheet.cell_range.MultiCellRange(f"M2:M{last}")
    tc.auto_filter.ref = f"A1:P{last}"

    sc = wb["E2E scenarios"]
    have = ids_in(sc)
    template = sc.max_row
    for s in QA_SCENARIOS:
        if s[0] in have:
            continue
        append_like(sc, [s[0], s[1], s[2], s[3], s[4], s[5], "Not run", "Added 24-Oct (QA automation)"], template)
        added += 1
    for dv in sc.data_validations.dataValidation:
        m = re.match(r"G2:G\d+", str(dv.sqref))
        if m:
            dv.sqref = openpyxl.worksheet.cell_range.MultiCellRange(f"G2:G{sc.max_row}")
    if sc.auto_filter.ref:
        sc.auto_filter.ref = re.sub(r"\d+$", str(sc.max_row), sc.auto_filter.ref)

    # Run summary: ranges reach the last case row; a row for the new module before Total.
    rs = wb["Run summary"]
    total_row = next(r for r in range(2, rs.max_row + 1) if rs.cell(row=r, column=1).value == "Total")
    modules = [rs.cell(row=r, column=1).value for r in range(2, total_row)]
    if MODULE not in modules:
        rs.insert_rows(total_row)
        for col in range(1, 9):
            copy_style(rs.cell(row=total_row - 1, column=col), rs.cell(row=total_row, column=col))
        rs.cell(row=total_row, column=1, value=MODULE)
        total_row += 1
    # Every module row and the Total row, written in the sheet's own formula pattern over all case rows.
    rng = lambda c: f"'Test cases'!${c}$2:${c}${last}"
    for r in range(2, total_row):
        rs.cell(row=r, column=2, value=f"=COUNTIF({rng('B')},A{r})")
        for col, status in zip(range(3, 7), ["Pass", "Fail", "Blocked", "Not run"]):
            rs.cell(row=r, column=col, value=f'=COUNTIFS({rng("B")},$A{r},{rng("M")},"{status}")')
        rs.cell(row=r, column=7, value=f'=COUNTIFS({rng("B")},$A{r},{rng("F")},"P0")')
        rs.cell(row=r, column=8, value=f'=G{r}-COUNTIFS({rng("B")},$A{r},{rng("F")},"P0",{rng("M")},"Pass")')
    for col in range(2, 9):
        letter = chr(64 + col)
        rs.cell(row=total_row, column=col, value=f"=SUM({letter}2:{letter}{total_row - 1})")

    cov = wb["Coverage"]
    have = ids_in(cov)
    template = cov.max_row
    for fid, mod, feature, status, tcs in COVERAGE:
        if fid in have:
            continue
        append_like(cov, [fid, mod, feature, status, len(tcs.split(", ")), tcs, ""], template)

    readme = wb["Read me"]
    for r in range(1, readme.max_row + 1):
        v = readme.cell(row=r, column=2).value
        if isinstance(v, str) and v.startswith("791 cases across 28 modules (P0 306, P1 325, P2 160)."):
            readme.cell(row=r, column=2, value=v.replace("791 cases across 28 modules (P0 306, P1 325, P2 160).",
                                                         "798 cases across 29 modules (P0 309, P1 329, P2 160; the QA automation module TC-QA-001 to 007 added 24 Oct)."))
        if isinstance(v, str) and v.startswith("35 end-to-end journeys") and "SC-36" not in v:
            readme.cell(row=r, column=2, value=v.replace("35 end-to-end journeys", "37 end-to-end journeys").rstrip(".") +
                        "; SC-36 and SC-37 (24 Oct) are the QA release check and the Claude QA agent's signed-in run.")

    log = wb["Change log"]
    if not any(log.cell(row=r, column=1).value == "QA-AUTO 24-Oct" for r in range(2, log.max_row + 1)):
        append_like(log, ["QA-AUTO 24-Oct", "New module",
                          "QA automation (QA-010 to QA-014): TC-QA-001 to TC-QA-007 and scenarios SC-36, SC-37. "
                          "Status, Actual result, Defect / evidence and Run date are now written from the automated runs "
                          "(docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx is the full record per site)."], log.max_row)
    wb.save(PLAN)
    print(f"plan_workbook: {added} rows added; Test cases now {last - 1} cases, scenarios {sc.max_row - 1}")


STATUS_MAP = {"Pass": "Pass", "Pass (partial)": "Pass", "Fail": "Fail", "Blocked": "Blocked", "Manual": "Blocked",
              "Not run (rule)": "Not run", "Not run": "Not run"}


def statuses(register):
    reg = openpyxl.load_workbook(register, read_only=True)
    rows = {}
    for sheet in ("Test cases", "E2E scenarios"):
        ws = reg[sheet]
        header = [c.value for c in next(ws.iter_rows(min_row=1, max_row=1))]
        idx = {h: i for i, h in enumerate(header)}
        for r in ws.iter_rows(min_row=2, values_only=True):
            if r[0]:
                rows[r[0]] = {"overall": r[idx["Overall"]], "detail": r[idx["Result detail (latest, per site)"]] or "",
                              "defect": r[idx["Defect"]] or "", "last": r[idx["Last run (UTC)"]] or "",
                              "local": r[idx["Local"]], "staging": r[idx["Staging (test.gokesari.com)"]],
                              "production": r[idx["Production (gokesari.com)"]]}
    wb = openpyxl.load_workbook(PLAN)
    tc = wb["Test cases"]
    n = 0
    for r in range(2, tc.max_row + 1):
        cid = tc.cell(row=r, column=1).value
        if cid not in rows:
            continue
        x = rows[cid]
        tc.cell(row=r, column=13, value=STATUS_MAP.get(x["overall"], "Not run"))
        sites = f"Local {x['local']} · Staging {x['staging']} · Production {x['production']}"
        prefix = "Passed, partly covered. " if x["overall"] == "Pass (partial)" else "Manual (not automatable): " if x["overall"] == "Manual" else ""
        tc.cell(row=r, column=14, value=f"{prefix}{sites}\n{x['detail']}"[:1500] if x["overall"] != "Not run" else None)
        tc.cell(row=r, column=15, value=x["defect"] or None)
        tc.cell(row=r, column=16, value=x["last"] or None)
        n += 1
    sc = wb["E2E scenarios"]
    for r in range(2, sc.max_row + 1):
        sid = sc.cell(row=r, column=1).value
        if sid not in rows:
            continue
        x = rows[sid]
        sc.cell(row=r, column=7, value=STATUS_MAP.get(x["overall"], "Not run"))
        note = sc.cell(row=r, column=8).value or ""
        note = re.sub(r"\n?\[Run .*\]$", "", note, flags=re.S)
        sc.cell(row=r, column=8, value=f"{note}\n[Run {x['last']}: Local {x['local']} · Staging {x['staging']} · Production {x['production']}. {x['detail'][:600]}]".strip())
        n += 1
    wb.save(PLAN)
    print(f"plan_workbook: statuses written for {n} cases and scenarios")


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "add-qa-cases":
        add_qa_cases()
    elif len(sys.argv) >= 3 and sys.argv[1] == "statuses":
        statuses(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(2)
