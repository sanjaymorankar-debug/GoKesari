"""
Counts for the training deck, read from the plan and the defect log (run from the repository root):

    python3 docs/testing/manual/deck/facts.py <deck-text.json> > facts.json

deck-text.json carries the words (version, revisions, feature groups, flag rules, next steps); every number
comes from tests/qa/catalog, docs/testing/manual/test-scenarios.json, test-cases.xlsx (Coverage) and
docs/testing/qa-defects.json, so the deck never disagrees with the workbook.
"""

import collections
import json
import re
import sys

import openpyxl

text = json.load(open(sys.argv[1], encoding="utf-8"))
cases = json.load(open("tests/qa/catalog/cases.json", encoding="utf-8"))
journeys = json.load(open("tests/qa/catalog/scenarios.json", encoding="utf-8"))
scenarios = json.load(open("docs/testing/manual/test-scenarios.json", encoding="utf-8"))
coverage = openpyxl.load_workbook("test-cases.xlsx", read_only=True)["Coverage"]
features = sum(1 for r in list(coverage.iter_rows(values_only=True))[1:] if r[0])
defects = json.load(open("docs/testing/qa-defects.json", encoding="utf-8"))
defects = defects if isinstance(defects, list) else defects["defects"]

day = text["versionDay"]


def origin(c):
    s = c.get("source") or ""
    if s.startswith(f"Added {day}"):
        return "new"
    if s.startswith("Added 20-Nov-2026"):
        return "nov20"
    if s.startswith("Planned"):
        return "planned"
    return "plan"


def method(m):
    m = (m or "").replace(" ", "")
    return m if m in ("UI", "UI+API", "API") else "other"


modules = []
for c in cases:
    if c["module"] not in modules:
        modules.append(c["module"])

status = collections.Counter(d.get("status", "") for d in defects)


def count(pred):
    return sum(v for k, v in status.items() if pred(k))


closed = count(lambda s: s.startswith("Fixed - retest passed") or s.startswith("Closed"))
waiting = count(lambda s: ("re-test pending" in s or "awaiting" in s) and not s.startswith("Open"))
not_defect = count(lambda s: s.startswith("Not a defect") or "by design" in s)
open_ = count(lambda s: s.startswith("Open"))
owner = count(lambda s: s.startswith("Open (owner"))
assert closed + waiting + not_defect + open_ == len(defects), status

sc_ids = sorted(int(m.group(1)) for j in journeys if (m := re.match(r"SC-(\d+)$", j["id"])))
facts = {
    **text,
    "cases": len(cases),
    "scenarios": len(scenarios),
    "journeys": len(journeys),
    "journeyRange": f"SC-01 to SC-{sc_ids[-1]:02d}" + (", SC-WKIT-01" if any(j["id"] == "SC-WKIT-01" for j in journeys) else ""),
    "modules": len(modules),
    "lastModule": modules[-1],
    # The workbook's Traceability sheet also lists feature IDs named only by cases; build-manual-workbook.ts prints
    # that count ("features"), which the deck text can pass as featuresOverride so the two agree.
    "features": text.get("featuresOverride", features),
    "origin": dict(collections.Counter(origin(c) for c in cases)),
    "methods": dict(collections.Counter(method(c.get("method")) for c in cases)),
    "types": dict(collections.Counter(c.get("type") or "Other" for c in cases)),
    "unitFiles": sum(1 for _ in __import__("pathlib").Path("tests/unit").rglob("*.test.ts")),
    "apiDb": sum(1 for c in cases if (c.get("method") or "").replace(" ", "") in ("API", "UI+DB", "DB")),
    "defects": {
        "total": len(defects),
        "dCount": sum(1 for d in defects if d["id"].startswith("D-")),
        "eCount": sum(1 for d in defects if d["id"].startswith("E-")),
        "severity": dict(collections.Counter(d.get("severity") for d in defects)),
        "closed": closed,
        "waiting": waiting,
        "open": open_,
        "ownerDecision": owner,
        "notDefect": not_defect,
    },
}
for k in ("plan", "nov20", "new", "planned"):
    facts["origin"].setdefault(k, 0)
for k in ("UI", "UI+API", "API", "other"):
    facts["methods"].setdefault(k, 0)
json.dump(facts, sys.stdout, ensure_ascii=False, indent=1)
