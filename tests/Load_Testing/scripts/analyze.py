"""Per-endpoint and per-interval statistics from a k6 CSV metrics file.

    python3 -I scripts/analyze.py reports/raw/test-load-metrics.csv.gz [bucket_seconds]

Writes <name>-analysis.json and <name>-analysis.md next to the input and
prints the Markdown.
"""
import csv
import gzip
import json
import os
import sys
from collections import defaultdict


def pct(values, p):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def main(path, bucket=30):
    dur = defaultdict(list)
    status = defaultdict(lambda: defaultdict(int))
    failed = defaultdict(int)
    buckets = defaultdict(lambda: {"dur": [], "fail": 0, "n": 0, "vus": 0})
    t0 = None
    with gzip.open(path, "rt") as f:
        for row in csv.DictReader(f):
            m = row["metric_name"]
            ts = int(float(row["timestamp"]))
            t0 = ts if t0 is None else min(t0, ts)
            if m == "vus":
                b = buckets[ts // bucket]
                b["vus"] = max(b["vus"], int(float(row["metric_value"])))
            elif m == "http_req_duration":
                name = row.get("name") or row.get("url")
                ms = float(row["metric_value"])
                dur[name].append(ms)
                status[name][row.get("status") or "0"] += 1
                b = buckets[ts // bucket]
                b["dur"].append(ms)
                b["n"] += 1
            elif m == "http_req_failed" and float(row["metric_value"]) >= 1:
                failed[row.get("name") or row.get("url")] += 1
                buckets[ts // bucket]["fail"] += 1

    endpoints = []
    for name, v in dur.items():
        endpoints.append({
            "endpoint": name, "requests": len(v), "failed": failed[name],
            "error_pct": round(100 * failed[name] / len(v), 2),
            "avg_ms": round(sum(v) / len(v)), "p50_ms": round(pct(v, 50)), "p90_ms": round(pct(v, 90)),
            "p95_ms": round(pct(v, 95)), "p99_ms": round(pct(v, 99)), "max_ms": round(max(v)),
            "status": dict(status[name]),
        })
    endpoints.sort(key=lambda e: -e["p95_ms"])

    timeline = []
    for k in sorted(buckets):
        b = buckets[k]
        if not b["n"]:
            continue
        timeline.append({
            "t_s": k * bucket - (t0 // bucket) * bucket, "vus": b["vus"], "rps": round(b["n"] / bucket, 1),
            "p50_ms": round(pct(b["dur"], 50)), "p95_ms": round(pct(b["dur"], 95)),
            "error_pct": round(100 * b["fail"] / b["n"], 1),
        })

    base = path.replace("-metrics.csv.gz", "")
    json.dump({"endpoints": endpoints, "timeline": timeline}, open(base + "-analysis.json", "w"), indent=1)

    md = ["| Endpoint | Requests | Errors % | p50 ms | p95 ms | p99 ms | Max ms | Status codes |",
          "|---|---:|---:|---:|---:|---:|---:|---|"]
    for e in endpoints:
        codes = ", ".join(f"{c}×{n}" for c, n in sorted(e["status"].items()))
        md.append(f"| {e['endpoint']} | {e['requests']} | {e['error_pct']} | {e['p50_ms']} | {e['p95_ms']} | {e['p99_ms']} | {e['max_ms']} | {codes} |")
    md += ["", f"| t (s) | VUs | req/s | p50 ms | p95 ms | Errors % |", "|---:|---:|---:|---:|---:|---:|"]
    for t in timeline:
        md.append(f"| {t['t_s']} | {t['vus']} | {t['rps']} | {t['p50_ms']} | {t['p95_ms']} | {t['error_pct']} |")
    open(base + "-analysis.md", "w").write("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 30)
