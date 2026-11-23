"""
Builds version 2.0 of the owner's QA engagement hand-over deck (for the testing partner) from version 1.0.

    python3 docs/testing/manual/deck/build_handover_deck_v2.py <v1.pptx> <facts.json> <handover-text.json> <out.pptx> <add_slide.py>

v1.0 (20-Nov-2026) handed over the workbook of 20-Nov. v2.0 keeps every slide, brings each count up to the
workbook 2.0 / register / defect log of 23-Nov (facts.json from facts.py plus handover-text.json) and adds two
slides: version history (2) and the features to test that reached staging after v1.0 (7).
"""

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData

V1, FACTS, TEXT, OUT, ADD_SLIDE = sys.argv[1:6]
F = json.load(open(FACTS, encoding="utf-8"))
T = json.load(open(TEXT, encoding="utf-8"))


def n(x):
    return f"{x:,}"


# ── 1. Structure: two copies of slide 18 (title + 3-column table)
work = Path(tempfile.mkdtemp())
step = work / "s0.pptx"
step.write_bytes(Path(V1).read_bytes())


def dup(src_xml, after_xml, out_name):
    out = work / out_name
    res = subprocess.run([sys.executable, ADD_SLIDE, str(step), src_xml, "--after", after_xml, "-o", str(out)],
                         capture_output=True, text=True)
    if res.returncode:
        raise SystemExit(res.stdout + res.stderr)
    created = [w for w in res.stdout.split() if w.startswith("ppt/slides/slide")]
    return out, created[0].split("/")[-1]


step, history_xml = dup("slide18.xml", "slide1.xml", "s1.pptx")   # → slide 2
step, new_xml = dup("slide18.xml", "slide5.xml", "s2.pptx")       # → slide 7
prs = Presentation(str(step))
S = list(prs.slides)


def v1(k):
    """v1 slide number → slide in v2 (history after 1, new features after 5)."""
    return S[0] if k == 1 else S[k] if k <= 5 else S[k + 1]


def replace_in(slide, old, new):
    hits = 0
    for sh in slide.shapes:
        frames = [sh.text_frame] if sh.has_text_frame else []
        if sh.has_table:
            frames += [c.text_frame for row in sh.table.rows for c in row.cells]
        for tf in frames:
            for p in tf.paragraphs:
                for r in p.runs:
                    if old in r.text:
                        r.text = r.text.replace(old, new)
                        hits += 1
    if not hits:
        raise SystemExit(f"text not found on slide: {old!r}")


def notes_replace(slide, old, new):
    tf = slide.notes_slide.notes_text_frame
    if old not in tf.text:
        raise SystemExit(f"text not found in notes: {old!r}")
    tf.text = tf.text.replace(old, new)


def title(slide, text):
    for sh in slide.shapes:
        if sh.is_placeholder and sh.has_text_frame and sh.text_frame.text.strip():
            p = sh.text_frame.paragraphs[0]
            p.runs[0].text = text
            for r in p.runs[1:]:
                r._r.getparent().remove(r._r)
            return
    raise SystemExit("no title placeholder")


def fill_table(slide, header, rows, widths=None):
    """Rewrite the slide's table (any number of columns): header + rows, copying body rows for striping.
    widths: column widths in inches (the table keeps its total width)."""
    tbl = next(sh for sh in slide.shapes if sh.has_table).table
    if widths:
        for col, w in zip(tbl.columns, widths):
            col.width = int(w * 914400)
    trs = tbl._tbl.tr_lst
    tpl = [trs[1], trs[2] if len(trs) > 2 else trs[1]]
    for tr in trs[1:]:
        tbl._tbl.remove(tr)
    for i, _ in enumerate(rows):
        tbl._tbl.append(copy.deepcopy(tpl[i % 2]))
    for ci, text in enumerate(header):
        tbl.cell(0, ci).text_frame.paragraphs[0].runs[0].text = text
    for ri, row in enumerate(rows, start=1):
        for ci, text in enumerate(row):
            tf = tbl.cell(ri, ci).text_frame
            p0 = tf.paragraphs[0]
            if not p0.runs:
                p0.add_run()
            p0.runs[0].text = text
            for r in p0.runs[1:]:
                r._r.getparent().remove(r._r)
            for extra in tf.paragraphs[1:]:
                extra._p.getparent().remove(extra._p)


D = F["defects"]

# ── 2. Title slide, and the footer every content layout carries
replace_in(v1(1), "|  20-Nov-2026  |", f"|  Version {F['version']}, {F['versionDay']}  |")
footer_hits = 0
for layout in prs.slide_layouts:
    for sh in layout.shapes:
        if sh.has_text_frame:
            for p in sh.text_frame.paragraphs:
                for r in p.runs:
                    if "20-Nov-2026" in r.text:
                        r.text = r.text.replace("20-Nov-2026", f"v{F['version']}, {F['versionDay']}")
                        footer_hits += 1
if not footer_hits:
    raise SystemExit("footer date not found in the layouts")

# ── 3. New slide 2: version history
s = S[1]
title(s, "Version history: what changed in this deck")
fill_table(s, ["Version", "Date", "What changed"], [[r["version"], r["day"], r["change"]] for r in T["revisions"]],
           widths=T.get("historyWidths"))
s.notes_slide.notes_text_frame.text = (
    "Every issue of this deck gets a new version number and a new file name "
    "(GoKesari_QA_Engagement_Owner_Handover_v<version>_<date>.pptx) in Doc_GoKesari/Test_Cases_Tracking; older "
    "versions are kept unchanged. A major version adds slides or changes what is handed over; a minor version only "
    "refreshes numbers. The manual workbook and the training deck carry the same scheme.")

# ── 4. About GoKesari (v1 slide 3)
s = v1(3)
replace_in(s, "(149 migrations)", f"({T['migrations']} migrations)")
replace_in(s, "37 modules: ordering, wallet and payments, shop onboarding and KYC, dispatch, delivery, returns, GST billing, dealer commission, subscriptions and more",
           f"{F['modules']} modules: ordering, wallet and payments, shop onboarding and KYC, dispatch, delivery, returns, GST billing, dealers and franchise, Health, Puja Samagri and more")
notes_replace(s, "Payments: Cashfree (sandbox on staging).",
              "Payments: Cashfree (sandbox on staging). Since v1.0, RBAC v2 adds staff roles (accountant, CA approvals, support, "
              "operations) behind flags that are on for staging and off on gokesari.com.")

# ── 5. What I am handing over (v1 slide 4)
s = v1(4)
replace_in(s, "1,048", n(F["cases"]))
replace_in(s, "822", n(T["automated"]))
replace_in(s, "83 + 194", f"{F['unitFiles']} + {T['integrationFiles']}")
replace_in(s, "137", str(D["total"]))
replace_in(s, "test cases in the manual workbook (20-Nov), with 290 scenarios and 47 journeys",
           f"test cases in the manual workbook ({F['versionShort']}, v{F['version']}), with {F['scenarios']} scenarios and {F['journeys']} journeys")
replace_in(s, "(261 features)", f"({n(F['features'])} features)")
replace_in(s, "Testing techniques training deck for your testers", f"Testing techniques training deck v{F['version']} for your testers")
replace_in(s, "docs/testing/manual", "docs/testing/manual/deck")

# ── 6. Where we stand (v1 slide 5)
s = v1(5)
ch = next(sh for sh in s.shapes if sh.has_chart).chart
cd = CategoryChartData()
cd.categories = [k for k, _ in T["staging"]]
cd.add_series("Cases", [v for _, v in T["staging"]])
ch.replace_data(cd)
ch.chart_title.text_frame.paragraphs[0].runs[0].text = f"Last automated result on staging, {n(F['cases'])} cases"
replace_in(s, "so 441 checks are skipped on staging", f"so {T['notRunRule']} checks are skipped on staging")
replace_in(s, "173 new cases have no automation", f"{T['newNotAutomated']} new cases have no automation")
replace_in(s, "Features added after 08-Nov", "Features added 20 to 23 Nov")
s.notes_slide.notes_text_frame.text = (
    f"Last automated result on staging per the master register of {F['versionDay']} (runs collected up to 22-Nov). "
    "'Not run (rule)' means the check exists but needs a signed-in or local tier that the scheduled staging run cannot do: "
    f"signed-in runs need the e-mailed sign-in codes. 'Not run yet' is mostly the {F['origin']['new']} cases added on "
    f"{F['versionDay']} for the features on staging 20 to 23 Nov ({T['newNotAutomated']} of them have no automated check yet), "
    "plus planned and retired cases.")

# ── 7. New slide 7: features added since v1.0
s = S[6]
title(s, f"New since v1.0: {len(T['features'])} feature groups, {n(F['origin']['new'])} cases to test")
fill_table(s, ["Feature (pull requests)", "What it does", "Switch on staging · cases"], T["features"],
           widths=T.get("featureWidths"))
s.notes_slide.notes_text_frame.text = (
    "These reached test.gokesari.com between 20 and 23 Nov 2026, after v1.0 of this deck. Each has cases in workbook "
    f"{F['version']} (Case origin 'New ({F['versionDay']})'); every Expected result was checked against the code on staging. "
    "75 places where the code differs from the brief are listed in docs/testing/manual/code-check-2026-11-23.json, and "
    "119 results other sessions already recorded in evidence-2026-11-23.json. Features behind a flag are tested twice: "
    "hidden or refused while off, then their functions with the flag on, on staging only.")

# ── 8. Counts on the remaining slides
replace_in(v1(9), "The 1,048 workbook cases and 47 journeys", f"The {n(F['cases'])} workbook cases and {F['journeys']} journeys")
replace_in(v1(9), "The 20-Nov workbook,", f"The {F['versionShort']} workbook (v{F['version']}),")
notes_replace(v1(9), "runs the 20-Nov workbook first", f"runs the {F['versionShort']} workbook first")
notes_replace(v1(9), "the 149 new cases", f"the {n(F['origin']['new'])} new cases of 23-Nov")
replace_in(v1(11), "(31 waiting today)", f"({D['waiting']} waiting today)")
notes_replace(v1(11), "today 31 defects", f"today {D['waiting']} defects")
replace_in(v1(15), "The 120 security cases in the workbook", f"The {F['types'].get('Security', 0)} security cases in the workbook")
notes_replace(v1(15), "120 security-type cases", f"{F['types'].get('Security', 0)} security-type cases")
replace_in(v1(18), "20-Nov workbook (Excel)", f"{F['versionShort']} workbook v{F['version']} (Excel)")
replace_in(v1(18), "the 173 new cases", f"the {T['newNotAutomated']} new cases")
replace_in(v1(18), "120 security cases", f"{F['types'].get('Security', 0)} security cases")
replace_in(v1(27), "Manual cycle 1 + 31 retests", f"Manual cycle 1 + {D['waiting']} retests")
replace_in(v1(27), "Automate 173 new cases", f"Automate {T['newNotAutomated']} new cases")

prs.core_properties.subject = f"QA engagement hand-over, version {F['version']} ({F['versionDay']})"
prs.core_properties.revision = int(F["version"].split(".")[0])
prs.save(OUT)
print(json.dumps({"out": OUT, "slides": len(prs.slides._sldIdLst), "added": [history_xml, new_xml]}))
