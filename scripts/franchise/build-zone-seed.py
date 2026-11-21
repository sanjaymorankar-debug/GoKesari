"""Builds drizzle/0157_franchise_pmr.sql from its DDL head, the ledger block and the Pune zone seed.

Sources (owner's final brief 21-Nov-2026 §5):
  docs/franchise/data/GoKesari_Pune_Franchise_Zones_Seed.csv  50 zones, provisional business index, tier, fee, reason
  docs/franchise/data/pune_clusters.csv                       "50 Clusters" sheet: the areas each cluster holds
  docs/franchise/data/pune_areas.csv                          "Pune Areas" sheet (196 areas) + approximate lat/lng/PIN

Checks before writing: every clustered area maps to exactly one known area (short names mapped to full names), the 7
listed areas stay unzoned, and the fee rule (§5.2) reproduces every fee and tier in the seed file.

Usage: python3 scripts/franchise/build-zone-seed.py <head.sql> <ledger_block.sql>   (writes the migration)
"""
import csv
import sys
import uuid
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "docs/franchise/data"
SET = "PUN"
STANDARD_FEE = Decimal(150000)
BATCH = "8a6f3c2e-0b1d-4c5e-9f7a-21b0c0de0157"
AS_OF = "2026-11-21"
UNZONED = {"Koregaon Bhima", "Sanaswadi", "Shikrapur", "Ranjangaon", "Saswad", "Khed Shivapur", "Rajgurunagar (Khed)"}

ALIASES = {
    "Camp": "Camp (Pune Cantonment)",
    "Ganeshkhind": "Ganeshkhind (University area)",
    "Pradhikaran": "Pradhikaran (Nigdi)",
    "Lohegaon (airport area)": "Lohegaon",
    "Ganj": "Ganj Peth (Mahatma Phule Peth)",
}
for p in ["Budhwar", "Raviwar", "Kasba", "Somwar", "Mangalwar", "Ganesh", "Nana", "Bhavani", "Guruwar", "Ghorpade"]:
    ALIASES[p] = f"{p} Peth"


def q(v):
    return "NULL" if v is None or v == "" else "'" + str(v).replace("'", "''") + "'"


def zone_id(n):
    return f"GKZ-{SET}-{int(n):02d}"


def tier_and_fee(index, average):
    diff = index / average - 1
    if diff > Decimal("0.1"):
        tier = "PREMIER"
    elif diff < Decimal("-0.1"):
        tier = "EMERGING"
    else:
        tier = "STANDARD"
    fee = STANDARD_FEE if tier == "STANDARD" else (STANDARD_FEE * (1 + diff) / 1000).quantize(Decimal(1), ROUND_HALF_UP) * 1000
    return tier, int(fee), int((diff * 10000).quantize(Decimal(1), ROUND_HALF_UP))


EXTRA_SETS = [
    # (code, name, file) — drafted 21-Nov-2026 from the standard local areas for the owner's review; every zone
    # Available at the launch offer, regular rate provisional (index 100 → Standard) until business data is published.
    ("MUM", "Mumbai (Konkan)", "mumbai_konkan_zones.csv"),
    ("NSK", "Nashik", "nashik_zones.csv"),
]


def extra_sets():
    out = []
    for code, name, fname in EXTRA_SETS:
        rows = list(csv.DictReader(open(DATA / fname, encoding="utf-8")))
        names = set()
        zrows, arows, frows = [], [], []
        n_area = 0
        for r in rows:
            zid = f"GKZ-{code}-{int(r['zone_no']):02d}"
            zrows.append(f"\t({q(zid)}, '{code}', {int(r['zone_no'])}, {q(r['zone_name'])}, {q(r['region'])}, {q(r['civic_body'])}, {q(r['reason'])}, 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST); zone list drafted for review')")
            frows.append(f"\t({q(zid)})")
            for a in r["areas"].split(";"):
                an, lat, lng, pin = a.split("|")
                assert an not in names, (code, an)
                names.add(an)
                n_area += 1
                arows.append(f"\t('{code}', {n_area}, {q(an)}, {q(r['region'])}, {q(r['civic_body'])}, NULL, {q(zid)}, {lat}, {lng}, ARRAY[{q(pin)}]::text[], '{{}}'::text[])")
        out.append(f"-- Zone set {code} ({name}): {len(rows)} zones, {n_area} areas.")
        out.append(f"INSERT INTO \"franchise_zone_sets\" (\"code\", \"name\", \"state\") VALUES ('{code}', {q(name)}, 'Maharashtra') ON CONFLICT DO NOTHING;")
        out.append("--> statement-breakpoint")
        out.append("INSERT INTO \"franchise_zones\" (\"zone_id\", \"zone_set_code\", \"cluster_no\", \"name\", \"region\", \"civic_body\", \"reason\", \"status\", \"status_reason\") VALUES\n" + ",\n".join(zrows) + "\nON CONFLICT DO NOTHING;")
        out.append("--> statement-breakpoint")
        out.append("INSERT INTO \"franchise_areas\" (\"zone_set_code\", \"area_no\", \"name\", \"region\", \"civic_body\", \"notes\", \"zone_id\", \"lat\", \"lng\", \"pincodes\", \"aliases\") VALUES\n" + ",\n".join(arows) + "\nON CONFLICT DO NOTHING;")
        out.append("--> statement-breakpoint")
        vals = ",\n".join(frows)
        out.append(
            "INSERT INTO \"franchise_zone_business\" (\"zone_id\", \"batch_id\", \"metric\", \"value\", \"source\", \"as_of\", \"provisional\", \"status\", \"published_at\")\n"
            f"SELECT v.zone_id, '{BATCH[:-4]}{'a001' if code == 'MUM' else 'a002'}'::uuid, 'INDEX', 100, 'Provisional (no business data yet)', DATE '{AS_OF}', true, 'PUBLISHED', now()\nFROM (VALUES\n{vals}\n) AS v(zone_id)\n"
            "WHERE NOT EXISTS (SELECT 1 FROM \"franchise_zone_business\" b WHERE b.zone_id = v.zone_id);"
        )
        out.append("--> statement-breakpoint")
        out.append(
            "INSERT INTO \"franchise_zone_fee_versions\" (\"zone_id\", \"business_id\", \"tier\", \"value\", \"average\", \"diff_bp\", \"fee_paise\", \"reason\", \"provisional\")\n"
            f"SELECT z.zone_id, b.id, 'STANDARD', 100, 100, 0, {int(STANDARD_FEE) * 100}, z.reason, true FROM \"franchise_zones\" z JOIN \"franchise_zone_business\" b ON b.zone_id = z.zone_id AND b.status = 'PUBLISHED'\n"
            f"WHERE z.zone_set_code = '{code}' AND NOT EXISTS (SELECT 1 FROM \"franchise_zone_fee_versions\" f WHERE f.zone_id = z.zone_id);"
        )
        out.append("--> statement-breakpoint")
        print(f"{code}: {len(rows)} zones, {n_area} areas")
    return out


def main(head, ledger):
    seed = list(csv.DictReader(open(DATA / "GoKesari_Pune_Franchise_Zones_Seed.csv", encoding="utf-8")))
    clusters = {int(r["cluster_no"]): r for r in csv.DictReader(open(DATA / "pune_clusters.csv", encoding="utf-8"))}
    areas = list(csv.DictReader(open(DATA / "pune_areas.csv", encoding="utf-8")))
    names = {a["area"] for a in areas}
    assert len(seed) == 50 and len(clusters) == 50 and len(areas) == 196

    area_zone, area_aliases = {}, {}
    for n, c in clusters.items():
        for raw in [x.strip() for x in c["areas_included"].split(",")]:
            name = ALIASES.get(raw, raw)
            assert name in names, f"cluster {n}: unknown area {raw!r}"
            assert name not in area_zone, f"{name} is in two clusters"
            area_zone[name] = zone_id(n)
            if raw != name:
                area_aliases.setdefault(name, []).append(raw)
    unzoned = names - set(area_zone)
    assert unzoned == UNZONED, unzoned
    assert len(area_zone) == 189

    indexes = [Decimal(r["business_index_provisional"]) for r in seed]
    average = sum(indexes) / len(indexes)
    out = []
    out.append(f"INSERT INTO \"franchise_zone_sets\" (\"code\", \"name\", \"state\") VALUES ('{SET}', 'Pune', 'Maharashtra') ON CONFLICT DO NOTHING;")
    out.append("--> statement-breakpoint")
    out.append("INSERT INTO \"franchise_campaigns\" (\"code\") VALUES ('LAUNCH') ON CONFLICT DO NOTHING;")
    out.append("--> statement-breakpoint")
    out.append("-- The 50 Pune franchise zones (one cluster each), Available at the launch offer (owner, 21-Nov-2026 09.20 IST).")
    rows = []
    for r in seed:
        n = int(r["zone_no"])
        c = clusters[n]
        assert c["cluster_name"] == r["zone_name"], (n, c["cluster_name"], r["zone_name"])
        rows.append(f"\t({q(zone_id(n))}, '{SET}', {n}, {q(r['zone_name'])}, {q(r['region'])}, {q(c['civic_body'])}, {q(r['fee_reason'])}, 'AVAILABLE', 'On sale at the launch offer (owner, 21-Nov-2026 09.20 IST)')")
    out.append("INSERT INTO \"franchise_zones\" (\"zone_id\", \"zone_set_code\", \"cluster_no\", \"name\", \"region\", \"civic_body\", \"reason\", \"status\", \"status_reason\") VALUES\n" + ",\n".join(rows) + "\nON CONFLICT DO NOTHING;")
    out.append("--> statement-breakpoint")
    out.append("-- The area master: 196 areas; zone_id null = Unzoned. Coordinates and PIN codes are approximate (for the")
    out.append("-- registration suggestion only, which the user confirms) until an admin corrects them.")
    rows = []
    for a in areas:
        name = a["area"]
        aliases = area_aliases.get(name, [])
        alias_sql = "ARRAY[" + ", ".join(q(x) for x in aliases) + "]::text[]" if aliases else "'{}'::text[]"
        pins = [p for p in a["pincodes"].split(";") if p]
        pin_sql = "ARRAY[" + ", ".join(q(p) for p in pins) + "]::text[]" if pins else "'{}'::text[]"
        rows.append(f"\t('{SET}', {int(a['area_no'])}, {q(name)}, {q(a['region'])}, {q(a['civic_body'])}, {q(a['notes'] or None)}, {q(area_zone.get(name))}, {a['lat']}, {a['lng']}, {pin_sql}, {alias_sql})")
    out.append("INSERT INTO \"franchise_areas\" (\"zone_set_code\", \"area_no\", \"name\", \"region\", \"civic_body\", \"notes\", \"zone_id\", \"lat\", \"lng\", \"pincodes\", \"aliases\") VALUES\n" + ",\n".join(rows) + "\nON CONFLICT DO NOTHING;")
    out.append("--> statement-breakpoint")
    out.append(f"-- Provisional business index (average {average.normalize()}) and the tier / fee it gives (§5.3), all marked provisional.")
    rows = []
    for r in seed:
        rows.append(f"\t({q(zone_id(r['zone_no']))}, {r['business_index_provisional']})")
    values = ",\n".join(rows)
    out.append(
        "INSERT INTO \"franchise_zone_business\" (\"zone_id\", \"batch_id\", \"metric\", \"value\", \"source\", \"as_of\", \"provisional\", \"status\", \"published_at\")\n"
        f"SELECT v.zone_id, '{BATCH}'::uuid, 'INDEX', v.value, 'Provisional estimate', DATE '{AS_OF}', true, 'PUBLISHED', now()\nFROM (VALUES\n{values}\n) AS v(zone_id, value)\n"
        "WHERE NOT EXISTS (SELECT 1 FROM \"franchise_zone_business\" b WHERE b.zone_id = v.zone_id);"
    )
    out.append("--> statement-breakpoint")
    rows = []
    counts = {"PREMIER": 0, "STANDARD": 0, "EMERGING": 0}
    for r, idx in zip(seed, indexes):
        tier, fee, diff_bp = tier_and_fee(idx, average)
        assert fee == int(r["annual_fee_inr"]), (r["zone_no"], fee, r["annual_fee_inr"])
        assert tier == r["tier"].upper(), (r["zone_no"], tier, r["tier"])
        counts[tier] += 1
        rows.append(f"\t({q(zone_id(r['zone_no']))}, '{tier}', {idx}, {diff_bp}, {fee * 100}, {q(r['fee_reason'])})")
    assert counts == {"PREMIER": 20, "STANDARD": 12, "EMERGING": 18}, counts
    values = ",\n".join(rows)
    out.append(
        "INSERT INTO \"franchise_zone_fee_versions\" (\"zone_id\", \"business_id\", \"tier\", \"value\", \"average\", \"diff_bp\", \"fee_paise\", \"reason\", \"provisional\")\n"
        f"SELECT v.zone_id, b.id, v.tier, v.value, {average}, v.diff_bp, v.fee, v.reason, true\nFROM (VALUES\n{values}\n) AS v(zone_id, tier, value, diff_bp, fee, reason)\n"
        "JOIN \"franchise_zone_business\" b ON b.zone_id = v.zone_id AND b.status = 'PUBLISHED'\n"
        "WHERE NOT EXISTS (SELECT 1 FROM \"franchise_zone_fee_versions\" f WHERE f.zone_id = v.zone_id);"
    )
    out.append("--> statement-breakpoint")
    out.extend(extra_sets())
    out.append("INSERT INTO \"franchise_zone_status_history\" (\"zone_id\", \"old_status\", \"new_status\", \"reason\", \"applied_at\")\nSELECT z.zone_id, NULL, z.status, 'Zone created (seed, 21-Nov-2026)', now() FROM \"franchise_zones\" z\nWHERE NOT EXISTS (SELECT 1 FROM \"franchise_zone_status_history\" h WHERE h.zone_id = z.zone_id);")
    sql = Path(head).read_text() + Path(ledger).read_text() + "\n".join(out) + "\n"
    (ROOT / "drizzle/0157_franchise_pmr.sql").write_text(sql)
    print(f"zones 50, areas 196 (189 zoned, 7 unzoned), average {average}, tiers {counts}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
