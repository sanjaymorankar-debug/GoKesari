"""
Builds version 2.0 of the testing team's training deck from version 1.0.

    python3 docs/testing/manual/deck/build_training_deck_v2.py <v1.pptx> <facts.json> <out.pptx> <add_slide.py>

v1.0 (20-Nov-2026) was built on the manual test workbook of 20-Nov. v2.0 keeps every slide, brings each
count up to date from the plan (facts.json, written by facts.py from tests/qa/catalog, test-cases.xlsx,
docs/testing/qa-defects.json) and adds three slides: version history, what is new since v1.0, and how
to test a feature that sits behind a flag. Needs python-pptx; add_slide.py is the pptx skill's slide
duplicator (keeps every package reference right).
"""

import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from pptx import Presentation
from pptx.chart.data import CategoryChartData

V1, FACTS, OUT, ADD_SLIDE = sys.argv[1:5]
F = json.load(open(FACTS, encoding="utf-8"))


def n(x):
    """Indian-style thousands only matter above 99,999; the deck uses 1,234 style."""
    return f"{x:,}"


# ── 1. Structure first: duplicate three table slides (slide23 = 2-column table, slide6 = 2-column table)
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
    return out, created[0].split("/")[-1] if created else None


step, version_xml = dup("slide23.xml", "slide1.xml", "s1.pptx")      # → slide 2: version history
step, new_xml = dup("slide6.xml", "slide2.xml", "s2.pptx")           # → slide 4: what is new since v1.0
step, flags_xml = dup("slide23.xml", new_xml, "s3.pptx")             # → slide 5: testing behind a flag

prs = Presentation(str(step))
S = list(prs.slides)  # 32 slides; v1 slide k is now S[k+2] for k >= 3, S[0], S[2] for 1, 2


def v1(k):
    """v1 slide number → slide object in v2."""
    return S[k - 1] if k == 1 else S[k] if k == 2 else S[k + 2]


def shape(slide, name):
    for sh in slide.shapes:
        if sh.name == name:
            return sh
    raise KeyError(name)


def set_para(sh, i, text):
    """Replace a paragraph's text, keeping the first run's formatting."""
    p = sh.text_frame.paragraphs[i]
    runs = p.runs
    runs[0].text = text
    for r in runs[1:]:
        r._r.getparent().remove(r._r)


def replace_in(slide, old, new):
    hits = 0
    for sh in slide.shapes:
        frames = []
        if sh.has_text_frame:
            frames.append(sh.text_frame)
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


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


def notes_replace(slide, old, new):
    tf = slide.notes_slide.notes_text_frame
    if old not in tf.text:
        raise SystemExit(f"text not found in notes: {old!r}")
    tf.text = tf.text.replace(old, new)


def fill_table(slide, header, rows):
    """Rewrite a 2-column table: header + rows, adding or removing <a:tr> copies as needed."""
    tbl = next(sh for sh in slide.shapes if sh.has_table).table
    trs = tbl._tbl.tr_lst
    body_tpl = [trs[1], trs[2] if len(trs) > 2 else trs[1]]  # keep the zebra striping
    for tr in trs[1:]:
        tbl._tbl.remove(tr)
    for i, _ in enumerate(rows):
        tbl._tbl.append(copy.deepcopy(body_tpl[i % 2]))
    for ci, text in enumerate(header):
        cell = tbl.cell(0, ci)
        cell.text_frame.paragraphs[0].runs[0].text = text
    for ri, row in enumerate(rows, start=1):
        for ci, text in enumerate(row):
            tf = tbl.cell(ri, ci).text_frame
            lines = text.split("\n")
            tf.paragraphs[0].runs[0].text = lines[0]
            for extra in tf.paragraphs[1:]:
                extra._p.getparent().remove(extra._p)
            for line in lines[1:]:
                p = copy.deepcopy(tf.paragraphs[0]._p)
                tf._txBody.append(p)
                tf.paragraphs[-1].runs[0].text = line
    return tbl


# ── 2. Title (v1 slide 1)
s = v1(1)
sub = [sh for sh in s.shapes if sh.name == "Text 0"][1]  # the title itself is unchanged
set_para(sub, 0, f"Training for the GoKesari testing team, built on the manual test workbook of {F['workbookDay']}")
set_para(sub, 1, f"Version {F['version']} ({F['versionDay']})  |  Syllabus: 4.1 Software Testing Techniques and Tactics  |  4.3 Software Quality Assurance")
notes(s, "Purpose: teach the testing concepts of units 4.1 and 4.3 using our own product. Every example in this deck "
         f"comes from {F['workbookFile']} (docs/testing/manual), our code in src/, or our defect log "
         f"docs/testing/qa-defects.json. Version {F['version']} of {F['versionDay']}: the version history is on slide 2.")

# ── 3. New slide 2: version history
s = S[1]
set_para(shape(s, "Text 0"), 0, "Version history: what changed in this deck")
fill_table(s, ["Version and date", "What changed"], [[f"{r['version']}  ({r['day']})", r["change"]] for r in F["deckRevisions"]])
notes(s, "Every issue of this deck gets a new version number and a new file name "
         "(GoKesari_Testing_Techniques_Training_v<version>_<date>.pptx) in Doc_GoKesari/Test_Cases_Tracking; older versions "
         "are kept unchanged. A major version (2.0) adds slides or changes what we teach; a minor version (2.1) only refreshes "
         "numbers. The workbook carries the same scheme on its Cover sheet (Revision history).")

# ── 4. v1 slide 2: the workbook in numbers
s = v1(2)
set_para(shape(s, "Text 0"), 0, f"What we are testing: the {F['workbookShort']} workbook in numbers")
set_para(shape(s, "Text 2"), 0, n(F["cases"]))
set_para(shape(s, "Text 5"), 0, n(F["scenarios"]))
set_para(shape(s, "Text 8"), 0, n(F["journeys"]))
set_para(shape(s, "Text 9"), 0, f"end-to-end journeys ({F['journeyRange']})")
set_para(shape(s, "Text 11"), 0, n(F["modules"]))
set_para(shape(s, "Text 12"), 0, f"modules, from Preflight to {F.get('lastModuleLabel', F['lastModule'])}")
set_para(shape(s, "Text 14"), 0, n(F["features"]))
src = shape(s, "Text 17")
set_para(src, 0, f"{n(F['origin']['plan'])} cases from the 08-Nov plan, already in the automated suite (tests/qa)")
set_para(src, 1, f"{n(F['origin']['nov20'])} cases added 20-Nov and {n(F['origin']['new'])} added {F['versionShort']} for features that reached test.gokesari.com")
set_para(src, 2, f"{n(F['origin']['planned'])} cases for planned features (Wave 2/3, R3); they start as Not Applicable")
tbl = next(sh for sh in s.shapes if sh.has_table).table
for ri, key in enumerate(["UI", "UI+API", "API", "other"], start=1):
    tbl.cell(ri, 1).text_frame.paragraphs[0].runs[0].text = n(F["methods"][key])
notes(s, f"Source: docs/testing/manual/{F['workbookFile']}, built {F['workbookDay']}. It follows ISO/IEC/IEEE 29119-3. "
         f"{n(F['cases'])} cases = {n(F['origin']['plan'])} from the 08-Nov plan + {n(F['origin']['nov20'])} added on 20-Nov "
         f"+ {n(F['origin']['new'])} added on {F['versionDay']} + {n(F['origin']['planned'])} planned (Not Applicable). "
         f"v1.0 of this deck showed 1,048: the first build of 20-Nov, before the dealer, newspaper, consultant, Health and "
         f"welcome-kit cases were added the same day.")

# ── 5. New slide 4: what is new since v1.0
s = S[3]
set_para(shape(s, "Text 0"), 0, f"New since v1.0: {n(F['origin']['new'])} cases for features on staging 20 to 23 Nov")
fill_table(s, ["Feature (pull requests)", "What to test  ·  flag  ·  cases"], [[g["group"], g["what"]] for g in F["groups"]])
notes(s, "Each row is a feature group that reached test.gokesari.com after v1.0. The cases are in the workbook with Case "
         f"origin 'New ({F['versionDay']})' and in the master register; each Expected result was checked against the code on "
         "staging before it was added. Flags: a feature that is off by default is tested twice: first that it is hidden or "
         "refused while off, then its functions with the flag on (staging only). " + F.get("groupsNote", ""))

# ── 6. New slide 5: testing a feature behind a flag
s = S[4]
set_para(shape(s, "Text 0"), 0, "Testing a feature that sits behind a flag")
fill_table(s, ["Step", "What the tester does"], F["flagRules"])
notes(s, "Most features built since 20-Nov reached staging with their flag off, so they can go to production dark. "
         "Testers never switch a flag on gokesari.com. On test.gokesari.com the flag is switched by an admin (or the owner) "
         "and switched back after the cycle; the Build / release column of each result row records the flag state.")

# ── 7. Counts on the remaining slides
replace_in(v1(5), "This workbook (1,048 cases)", f"This workbook ({n(F['cases'])} cases)")
replace_in(v1(6), "Workbook rebuilt 20-Nov: 173 cases added, 6 wrong expected results corrected",
           f"Workbook {F['version']} ({F['versionShort']}): {n(F['origin']['new'])} cases added, {F['overrides']} expected results corrected")
replace_in(v1(9), "261 features", f"{n(F['features'])} features")
replace_in(v1(9), "the 47 end-to-end journeys (SC-01 to SC-47)", f"the {F['journeys']} end-to-end journeys ({F['journeyRange']})")
replace_in(v1(10), "120 security cases", f"{n(F['types'].get('Security', 0))} security cases")
replace_in(v1(14), "37 modules", f"{F['modules']} modules")
replace_in(v1(16), "Workbook cases with Method API, UI+DB or DB: 133", f"Workbook cases with Method API, UI+DB or DB: {n(F['apiDb'])}")
replace_in(v1(23), "(261 features to cases)", f"({n(F['features'])} features to cases)")
replace_in(v1(23), "(137 defects)", f"({F['defects']['total']} defects)")
replace_in(v1(28), "SC-01 to SC-47", F["journeyRange"])
replace_in(v1(5), "Vitest: 83 files", f"Vitest: {F['unitFiles']} files")
replace_in(v1(16), "Vitest unit tests, 83 files", f"Vitest unit tests, {F['unitFiles']} files")
notes_replace(v1(9), "traced to the 261 features", f"traced to the {n(F['features'])} features")
notes_replace(v1(10), "120 security-type cases", f"{n(F['types'].get('Security', 0))} security-type cases")
notes_replace(v1(16), "(133 cases)", f"({n(F['apiDb'])} cases)")

# Chart: cases by type (v1 slide 19)
s = v1(19)
ch = next(sh for sh in s.shapes if sh.has_chart).chart
order = sorted(F["types"].items(), key=lambda kv: -kv[1])
cd = CategoryChartData()
cd.categories = [k for k, _ in order]
cd.add_series("Cases", [v for _, v in order])
ch.replace_data(cd)
ch.chart_title.text_frame.paragraphs[0].runs[0].text = f"Workbook cases by type ({n(F['cases'])})"
notes(s, "Black-box (behavioural) testing designs cases from the requirement without looking at code. It finds incorrect or "
         "missing functions, interface errors, data errors, behaviour and performance errors, and start-up and end errors. "
         f"The chart shows the Type column of the {F['workbookShort']} workbook. Most black-box technique lives in the "
         "Negative and Boundary cases.")

# Chart and counts: defects (v1 slide 27)
s = v1(27)
D = F["defects"]
ch = next(sh for sh in s.shapes if sh.has_chart).chart
cd = CategoryChartData()
cd.categories = ["Blocker", "High", "Medium", "Low", "Info"]
cd.add_series("Defects", [D["severity"].get(k, 0) for k in ["Blocker", "High", "Medium", "Low", "Info"]])
ch.replace_data(cd)
ch.chart_title.text_frame.paragraphs[0].runs[0].text = f"Defects by severity ({D['total']} logged)"
set_para(shape(s, "Text 2"), 0, str(D["closed"]))
set_para(shape(s, "Text 5"), 0, str(D["waiting"]))
set_para(shape(s, "Text 8"), 0, str(D["open"]))
set_para(shape(s, "Text 9"), 0, f"still open, {D['ownerDecision']} waiting on an owner decision")
set_para(shape(s, "Text 11"), 0, str(D["notDefect"]))
sev = ", ".join(f"{k} {D['severity'].get(k, 0)}" for k in ["Blocker", "High", "Medium", "Low", "Info"])
notes(s, f"Source: docs/testing/qa-defects.json, {D['total']} records as of {F['versionDay']} ({D['dCount']} product defects "
         f"D-…, {D['eCount']} environment / host issues E-…). Severity: {sev}. Status: {D['closed']} closed after a passed "
         f"retest; {D['waiting']} fixed and waiting for retest; {D['open']} open ({D['ownerDecision']} waiting on an owner "
         f"decision); {D['notDefect']} not a defect or by design. The {D['waiting']} waiting for retest are a priority for "
         "this cycle: set Cycle = Retest.")

# Next steps (v1 slide 29)
s = v1(29)
set_para(shape(s, "Text 0"), 0, "Your next steps for Cycle 2")
body = [sh for sh in s.shapes if sh.name == "Text 0"][1]
for i, line in enumerate(F["nextSteps"]):
    set_para(body, i, line)
notes(s, f"Workbook location: docs/testing/manual in the GoKesari repository; owner's copy in Doc_GoKesari/Test_Cases_Tracking "
         f"({F['workbookFile']}) with an Evidence folder next to it. Planned-feature cases stay Not Applicable until the "
         "feature reaches test.gokesari.com. Flagged features: hidden-while-off case first, then the functions with the "
         "flag on, staging only.")

prs.core_properties.title = "Testing gokesari.com: techniques, tactics and quality assurance"
prs.core_properties.subject = f"Testing team training, version {F['version']} ({F['versionDay']})"
prs.core_properties.revision = int(F["version"].split(".")[0])
prs.save(OUT)
print(json.dumps({"out": OUT, "slides": len(prs.slides._sldIdLst), "added": [version_xml, new_xml, flags_xml]}))
