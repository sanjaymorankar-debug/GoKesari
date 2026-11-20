"""Builds docs/franchise/pune_pmr_91_zones_seed.csv from the owner's territory workbook
(Pune_PMR_Restructured_Zones_Max_5K_Cr.xlsx) and prints the validation report.

The workbook's own formulas are not trusted (row-3 headers, TOTAL row and the
cluster summary are broken, see the brief section 5): only the input columns
are read (A zone, B cluster, C name, D pins, E profile, F shops, G GMV/shop
lakh, J status) and the money columns are computed here:
monthly (Rs Cr) = shops x GMV per shop (Rs lakh) / 100; annual = monthly x 12.

Usage: /usr/bin/python3 scripts/franchise/build-zone-seed.py <workbook.xlsx> <out.csv>
"""
import csv, re, sys
from decimal import Decimal, ROUND_HALF_UP
import openpyxl

CLUSTERS = {
    "Central Core & Peth Areas": "C1",
    "East Corridor (Nagar Rd & Hadapsar)": "C2",
    "South-East & South Corridor": "C3",
    "West Corridor (Kothrud & Baner)": "C4",
    "North-West IT & Residential Belt": "C5",
    "PCMC Core & Industrial Belt": "C6",
    "Outer PMR Growth Corridors": "C7",
}

def r2(x):
    return Decimal(x).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def natural_key(zid):
    m = re.match(r"^(\d+)([A-Z]?)$", zid)
    return (int(m.group(1)), m.group(2))

def main(src, out):
    ws = openpyxl.load_workbook(src, data_only=False).worksheets[0]
    rows = []
    for r in ws.iter_rows(min_row=6, max_row=ws.max_row, values_only=True):
        if r[0] is None:
            continue
        zid = str(r[0]).strip()
        cluster = str(r[1]).strip()
        status_text = str(r[9]).strip()
        m = re.search(r"Split.*from Zone (\d+)", status_text, re.I)
        split_from = m.group(1) if m else ""
        shops = int(r[5])
        gmv = Decimal(str(r[6]))
        monthly = r2(Decimal(shops) * gmv / Decimal(100))
        annual = r2(monthly * 12)
        rows.append({
            "zone_id": zid,
            "cluster_code": CLUSTERS[cluster],
            "macro_cluster": cluster,
            "zone_name": str(r[2]).strip(),
            "pin_codes": ", ".join(p.strip() for p in str(r[3]).split(",")),
            "commercial_profile": str(r[4]).strip(),
            "est_shop_count": shops,
            "est_monthly_gmv_per_shop_lakh": str(gmv.normalize()) if gmv == gmv.to_integral() else str(gmv),
            "est_monthly_area_revenue_cr": str(monthly),
            "est_annual_area_revenue_cr": str(annual),
            "territory_status": "Split" if split_from else "Original",
            "split_from_zone": split_from,
            "_raw_status": status_text,
        })
    rows.sort(key=lambda z: (z["cluster_code"], natural_key(z["zone_id"])))
    cols = [k for k in rows[0] if not k.startswith("_")]
    with open(out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    # ---- validation report (brief section 5) ----
    ids = [z["zone_id"] for z in rows]
    ok = True
    def check(label, cond, detail=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"{'PASS' if cond else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    check("91 rows", len(rows) == 91, str(len(rows)))
    check("91 unique Zone IDs", len(set(ids)) == 91, str(len(set(ids))))
    check("7 clusters", len({z['cluster_code'] for z in rows}) == 7)
    orig = sum(1 for z in rows if not z["split_from_zone"])
    check("52 original + 39 split", orig == 52 and len(rows) - orig == 39, f"{orig} + {len(rows) - orig}")
    total_shops = sum(z["est_shop_count"] for z in rows)
    check("total 2,49,900 shops", total_shops == 249900, str(total_shops))
    mx = max(rows, key=lambda z: Decimal(z["est_annual_area_revenue_cr"]))
    mn = min(rows, key=lambda z: Decimal(z["est_annual_area_revenue_cr"]))
    check("max annual Rs 4,914 Cr (Zone 43)", mx["zone_id"] == "43" and Decimal(mx["est_annual_area_revenue_cr"]) == 4914, f"{mx['zone_id']} {mx['est_annual_area_revenue_cr']}")
    check("min annual Rs 1,188 Cr (Zone 68)", mn["zone_id"] == "68" and Decimal(mn["est_annual_area_revenue_cr"]) == 1188, f"{mn['zone_id']} {mn['est_annual_area_revenue_cr']}")
    check("no zone >= Rs 5,000 Cr", all(Decimal(z["est_annual_area_revenue_cr"]) < 5000 for z in rows))
    expected = {"C1": (22, 49400, 80958, 4608), "C2": (15, 42800, 50556, 4692), "C3": (10, 35900, 35412, 4446),
                "C4": (10, 27700, 32598, 4554), "C5": (7, 24300, 26496, 4914), "C6": (18, 47800, 57383, 4428),
                "C7": (9, 22000, 18252, 2958)}
    print("\nCluster | Zones | Est. shops | Annual (Rs Cr) | Largest (Rs Cr)")
    grand = Decimal(0)
    for code in sorted(expected):
        zs = [z for z in rows if z["cluster_code"] == code]
        annual = sum(Decimal(z["est_annual_area_revenue_cr"]) for z in zs)
        grand += annual
        largest = max(Decimal(z["est_annual_area_revenue_cr"]) for z in zs)
        e = expected[code]
        got = (len(zs), sum(z["est_shop_count"] for z in zs), int(annual.quantize(Decimal(1), rounding=ROUND_HALF_UP)), int(largest.quantize(Decimal(1), rounding=ROUND_HALF_UP)))
        print(f"{code} | {got[0]} | {got[1]} | {annual} | {largest}")
        check(f"{code} matches brief", got == e, f"got {got} expected {e}")
    check("total annual Rs 3,01,655 Cr", int(grand.quantize(Decimal(1), rounding=ROUND_HALF_UP)) == 301655, str(grand))
    odd = [z for z in rows if not re.match(r"^(Original|Split.*from Zone \d+)", z["_raw_status"])]
    check("status text understood", not odd, ", ".join(z["zone_id"] for z in odd))
    print("\nRESULT:", "ALL PASS" if ok else "FAILURES")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
