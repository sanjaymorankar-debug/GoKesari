"""Batch 2026-10 — builds the testing report (docs/test-reports/2026-10-batch.md + .html).

    python3 scripts/reports/batch-2026-10-test-report.py <evidence-dir> <out-dir>

<evidence-dir> holds the raw results of the run:
  vitest-batch.json        vitest --reporter=json of tests/**/batch-*  (cases TC-B26-<WS>-NNN)
  vitest-mobile.json       the same for mobile/src/__tests__/batch-*
  full-suite.json          {"files": n, "tests": n, "passed": n, "failed": n, "durationS": n, "commit": sha}
  ci.json                  {"runs": [{"name", "url", "conclusion", "commit"}]}
  remote-<host>.json       tests/e2e/batch-2026-10-remote.spec.ts output, one per site
  signed-in-<host>.json    tests/e2e/batch-2026-10-signed-in.spec.ts output (optional)
  meta.json                environments, commits, PRs, defects, sign-off text, screenshots
Every number in the report is computed from these files.
"""
import html
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict

STEPS = OrderedDict(
    [
        ("F1.1.2", "Identity verification by email OTP"),
        ("F1.4.3", "Online reference prices (dropped)"),
        ("F1.7.3/F1.8.4", "Online payment + payment state machine"),
        ("F3.3.2", "Rider broadcast offers + broadcast notifications"),
        ("F4.1.3", "Pickup by QR code"),
        ("F4.2.2", "In-app turn-by-turn navigation"),
        ("F6.1.3", "Cancellation after packing (fee)"),
        ("F6.2.3", "Refunds: breakdown, choice, timeline"),
        ("F6.3.3", "Help desk + grievance portal"),
        ("F8.4.2", "Operator-Limited shop onboarding"),
        ("F9.1.2", "GS1 / manufacturer / Open Food Facts sources"),
        ("F9.1.4", "Large ingestion, product browser, promote"),
        ("F9.2.6", "GST invoice per order; inventory sync off"),
        ("F10.2.4", "Automated 5-day payouts"),
        ("F10.2.5", "Platform invoice + statutory (TCS/TDS)"),
        ("F13.1.2", "Notification channels (email, push, in-app)"),
        ("F15.2.3", "Deep links + mobile app"),
        ("Platform", "Cross-cutting (DB split ownership, rollbacks, workflows)"),
    ]
)

# File → step; a few files cover two steps, split by keywords in the case name.
FILE_STEP = {
    "batch-a-otp": "F1.1.2",
    "batch-a-price-references": "F1.4.3",
    "batch-a-payments": "F1.7.3/F1.8.4",
    "batch-a-gateways": "F1.7.3/F1.8.4",
    "batch-b-dispatch-broadcast": "F3.3.2",
    "batch-b-pickup-qr": "F4.1.3",
    "batch-b-navigation": "F4.2.2",
    "batch-c-cancellation-fee": "F6.1.3",
    "batch-c-refunds": "F6.2.3",
    "batch-c-helpdesk": "F6.3.3",
    "batch-d-operator-limited": "F8.4.2",
    "batch-e-invoices": "F9.2.6",
    "batch-e-payouts": "F10.2.4",
    "batch-e-platform": "F10.2.5",
    "batch-f-push": "F13.1.2",
    "batch-f-mobile-bridge-push": "F13.1.2",
    "batch-f-broadcasts": "F3.3.2",
    "batch-f-centre": "F3.3.2",
    "batch-f-deep-links": "F15.2.3",
    "batch-f-push-and-links": "F15.2.3",
}
KEYWORD_STEP = [
    (re.compile(r"inventory|sync", re.I), "F9.2.6"),
    (re.compile(r"gs1|datakart|manufacturer|api key|open food|attribution|template|gtin|dedup", re.I), "F9.1.2"),
    (re.compile(r"ingest|resum|batch|error file|image|browser|promote|merge|bulk|progress|object ?store", re.I), "F9.1.4"),
    (re.compile(r"statutor|tcs|tds|194|9\(5\)|gstr", re.I), "F10.2.5"),
    (re.compile(r"payout|utr|bank file|settlement|maker", re.I), "F10.2.4"),
    (re.compile(r"invoice|credit note|qr|place of supply|igst|cgst", re.I), "F9.2.6"),
    (re.compile(r"operator|onboard|consent|registration fee", re.I), "F8.4.2"),
    (re.compile(r"refund", re.I), "F6.2.3"),
    (re.compile(r"cancel|fee", re.I), "F6.1.3"),
    (re.compile(r"ticket|grievance|sla|csat", re.I), "F6.3.3"),
]

REMOTE_STEP = {
    "TC-B26-R-001": "Platform", "TC-B26-R-002": "Platform", "TC-B26-R-003": "F1.1.2",
    "TC-B26-R-004": "F15.2.3", "TC-B26-R-005": "F15.2.3", "TC-B26-R-006": "F1.7.3/F1.8.4",
    "TC-B26-R-007": "F10.2.4", "TC-B26-R-008": "Platform", "TC-B26-R-009": "Platform",
    "TC-B26-R-010": "F6.3.3", "TC-B26-R-011": "F1.4.3", "TC-B26-R-012": "F1.7.3/F1.8.4",
}


def step_for(file: str, name: str) -> str:
    base = os.path.basename(file).split(".")[0]
    if base in FILE_STEP:
        return FILE_STEP[base]
    for rx, step in KEYWORD_STEP:
        if rx.search(name):
            return step
    return "Platform"


def load(path, default=None):
    try:
        with open(path) as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default


def vitest_cases(report):
    out = []
    if not report:
        return out
    for file in report.get("testResults", []):
        for t in file.get("assertionResults", []):
            m = re.search(r"TC-B26-[A-F]-\d+", t.get("title", "") + " " + " ".join(t.get("ancestorTitles", [])))
            if not m:
                continue
            status = {"passed": "pass", "failed": "fail", "skipped": "blocked", "pending": "blocked", "todo": "blocked"}.get(t.get("status"), "blocked")
            out.append({"id": m.group(0), "title": t.get("title"), "file": file.get("name", ""), "status": status,
                        "step": step_for(file.get("name", ""), t.get("title", ""))})
    return out


def counts(rows):
    c = {"run": 0, "pass": 0, "fail": 0, "blocked": 0}
    for r in rows:
        if r["status"] in ("pass", "fail"):
            c["run"] += 1
        c[r["status"]] = c.get(r["status"], 0) + 1
    return c


def main(evidence: str, out_dir: str) -> None:
    meta = load(os.path.join(evidence, "meta.json"), {})
    batch = vitest_cases(load(os.path.join(evidence, "vitest-batch.json")))
    mobile = vitest_cases(load(os.path.join(evidence, "vitest-mobile.json")))
    full = load(os.path.join(evidence, "full-suite.json"), {})
    ci = load(os.path.join(evidence, "ci.json"), {"runs": []})
    remotes = {}
    signed = {}
    for name in sorted(os.listdir(evidence)):
        if name.startswith("remote-") and name.endswith(".json"):
            remotes[name[7:-5]] = load(os.path.join(evidence, name))
        if name.startswith("signed-in-") and name.endswith(".json"):
            signed[name[10:-5]] = load(os.path.join(evidence, name))

    automated = batch + mobile
    by_step = defaultdict(list)
    for r in automated:
        by_step[r["step"]].append(r)
    remote_by_step = defaultdict(lambda: defaultdict(list))
    for host, rep in remotes.items():
        for row in (rep or {}).get("rows", []):
            remote_by_step[REMOTE_STEP.get(row["id"], "Platform")][host].append(
                {"status": row["status"], "id": row["id"], "title": row["title"], "detail": row.get("detail", "")}
            )
    signed_by_step = defaultdict(lambda: defaultdict(list))
    for host, rep in signed.items():
        for row in (rep or {}).get("rows", []):
            signed_by_step[row.get("step", "Platform")][host].append(row)

    md = []
    w = md.append
    w("# Testing report — build & integrate batch (18 Oct 2026)")
    w("")
    w(f"**Date:** {meta.get('date', '')} · **Branch / PR:** {meta.get('pr', '')} · **Build (commit):** `{meta.get('commit', '')}`")
    w("")
    for env in meta.get("environments", []):
        w(f"- **{env['name']}** — {env['url']} · {env['what']}")
    w("")
    w("## 1. Summary")
    w("")
    tot = counts(automated)
    w("| Layer | Run | Passed | Failed | Blocked |")
    w("|---|---:|---:|---:|---:|")
    w(f"| New batch cases (TC-B26-A…F, unit + integration on PostgreSQL 16, mobile) | {tot['run']} | {tot['pass']} | {tot['fail']} | {tot['blocked']} |")
    if full:
        w(f"| Whole suite incl. all existing tests (`npx vitest run`, {full.get('files')} files) | {full.get('tests')} | {full.get('passed')} | {full.get('failed')} | {full.get('blocked', 0)} |")
    for host, rep in remotes.items():
        c = counts([{"status": r["status"]} for r in (rep or {}).get("rows", [])])
        w(f"| Remote checks on **{host}** (`batch-2026-10-remote.spec.ts`, production-safe) | {c['run']} | {c['pass']} | {c['fail']} | {c['blocked']} |")
    for host, rep in signed.items():
        c = counts([{"status": r["status"]} for r in (rep or {}).get("rows", [])])
        w(f"| Signed-in journeys on **{host}** (`batch-2026-10-signed-in.spec.ts`) | {c['run']} | {c['pass']} | {c['fail']} | {c['blocked']} |")
    w("")
    if ci.get("runs"):
        w("CI on GitHub Actions (same commits):")
        w("")
        for run in ci["runs"]:
            w(f"- {run['name']}: **{run['conclusion']}** — [{run['url'].rsplit('/', 1)[-1]}]({run['url']}) (`{run['commit'][:7]}`)")
        w("")

    w("## 2. Results by feature")
    w("")
    hosts = list(remotes) + [f"{h} (signed in)" for h in signed]
    head = "| Flow step | Feature | Automated run / pass / fail / blocked | " + " | ".join(hosts) + " |"
    w(head)
    w("|" + "---|" * (3 + len(hosts)))
    for step, label in STEPS.items():
        c = counts(by_step.get(step, []))
        cells = []
        for host in remotes:
            rows = remote_by_step[step].get(host, [])
            cc = counts(rows)
            cells.append(f"{cc['pass']}/{cc['run']} pass" + (f", {cc['fail']} fail" if cc["fail"] else "") if rows else "—")
        for host in signed:
            rows = signed_by_step[step].get(host, [])
            cc = counts(rows)
            cells.append((f"{cc['pass']}/{cc['run']} pass" + (f", {cc['fail']} fail" if cc["fail"] else "") + (f", {cc['blocked']} blocked" if cc["blocked"] else "")) if rows else "—")
        w(f"| {step} | {label} | {c['run']} / {c['pass']} / {c['fail']} / {c['blocked']} | " + " | ".join(cells) + " |")
    w("")
    for step in ("F4.2.6",):
        w(f"- **{step}** signature capture — DEFERRED to Phase 2, not built, not tested.")
    w("- **F15.1.3 / F15.1.4** store publishing — ON HOLD (owner decision); internal builds below.")
    w("")

    w("## 3. Mobile builds (internal, not published)")
    w("")
    for line in meta.get("mobile_builds", []):
        w(f"- {line}")
    w("")

    w("## 4. Defects found and fixed during the batch")
    w("")
    w("| # | Found in | Defect | Fix | Verified by |")
    w("|---|---|---|---|---|")
    for i, d in enumerate(meta.get("defects_fixed", []), 1):
        w(f"| {i} | {d['where']} | {d['defect']} | {d['fix']} | {d['verified']} |")
    w("")
    w("## 5. Open defects and limitations")
    w("")
    w("| # | Severity | Item | Owner / next step |")
    w("|---|---|---|---|")
    for i, d in enumerate(meta.get("defects_open", []), 1):
        w(f"| {i} | {d['severity']} | {d['item']} | {d['next']} |")
    w("")

    w("## 6. Critical paths — evidence")
    w("")
    for e in meta.get("evidence", []):
        w(f"- **{e['title']}** — {e['text']}" + (f" ![{e['title']}]({e['image']})" if e.get("image") else ""))
    w("")
    for host, rep in list(remotes.items()) + [(f"{h} (signed in)", r) for h, r in signed.items()]:
        w(f"<details><summary>Case log — {host}</summary>")
        w("")
        w("| Case | Result | Detail |")
        w("|---|---|---|")
        for row in (rep or {}).get("rows", []):
            w(f"| {row['id']} {row['title']} | {row['status'].upper()} | {str(row.get('detail', '')).replace('|', '/')[:180]} |")
        w("")
        w("</details>")
        w("")
    w("<details><summary>Every automated batch case</summary>")
    w("")
    w("| Case | Step | Result | Test |")
    w("|---|---|---|---|")
    for r in sorted(automated, key=lambda r: (r["id"][:8], int(r["id"].rsplit("-", 1)[1]))):
        w(f"| {r['id']} | {r['step']} | {r['status'].upper()} | {r['title'].replace('|', '/')} |")
    w("")
    w("</details>")
    w("")
    w("## 7. Sign-off")
    w("")
    for line in meta.get("signoff", []):
        w(line)
    w("")

    os.makedirs(out_dir, exist_ok=True)
    text = "\n".join(md)
    with open(os.path.join(out_dir, "2026-10-batch.md"), "w") as fh:
        fh.write(text)
    with open(os.path.join(out_dir, "2026-10-batch.html"), "w") as fh:
        fh.write(to_html(text))
    print(f"report: {tot['run']} automated cases ({tot['pass']} pass, {tot['fail']} fail), {len(remotes)} remote site(s), {len(signed)} signed-in run(s)")


def to_html(text: str) -> str:
    """A small, dependency-free Markdown → HTML for this report's own constructs."""
    out, in_table, in_list = [], False, False
    def inline(s):
        s = html.escape(s)
        s = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r'<img alt="\1" src="\2" style="max-width:100%">', s)
        s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        return s
    for line in text.split("\n"):
        if line.startswith("|"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if all(re.fullmatch(r"-+:?|:?-+:?|-+", c or "-") for c in cells):
                continue
            if not in_table:
                out.append("<table>")
                in_table = True
                out.append("<tr>" + "".join(f"<th>{inline(c)}</th>" for c in cells) + "</tr>")
            else:
                out.append("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in cells) + "</tr>")
            continue
        if in_table:
            out.append("</table>")
            in_table = False
        if line.startswith("- "):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline(line[2:])}</li>")
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        if line.startswith("<details>") or line.startswith("</details>"):
            out.append(line.replace("<summary>", "<summary>").replace("</summary>", "</summary>"))
        elif line.startswith("# "):
            out.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("## "):
            out.append(f"<h2>{inline(line[3:])}</h2>")
        elif line.strip():
            out.append(f"<p>{inline(line)}</p>")
    if in_table:
        out.append("</table>")
    if in_list:
        out.append("</ul>")
    style = (
        "body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;color:#1f2328;background:#fff}"
        "table{border-collapse:collapse;margin:12px 0;width:100%;font-size:13px}th,td{border:1px solid #d0d7de;padding:4px 8px;vertical-align:top}"
        "th{background:#fff4e5}code{background:#f6f8fa;padding:0 3px}h1{color:#c2410c}h2{border-bottom:2px solid #f59e0b;padding-bottom:4px}"
    )
    return f"<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>GoKesari batch test report</title><style>{style}</style></head><body>{''.join(out)}</body></html>"


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
