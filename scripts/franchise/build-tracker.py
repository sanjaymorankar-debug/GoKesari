"""Builds the franchise feature tracker (brief §16) as an .xlsx: one row per feature, status, environment,
evidence and last updated (IST). Usage: /usr/bin/python3 scripts/franchise/build-tracker.py <out.xlsx> "<DD-Mmm-YYYY HH.MM IST>"
Status values: COMPLETED · IN PROGRESS · BLOCKED · NOT STARTED (never COMPLETED without evidence)."""
import sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

out, stamp = sys.argv[1], sys.argv[2]
L = "Live on gokesari.com 21-Nov-2026 11.22 IST (release #453); staging verified 11.13 IST (#446); automated tests local"
E = "tests/integration/franchise-pmr.test.ts"
U = "tests/unit/franchise-zones.test.ts"
rows = [
    ("Team", "Roles: top person adds Team Leads and Agents; TL adds Agents only; own codes; PAN / mobile / bank once per team; moves by admin; TL deactivated → agents under the top person (§2)", "DONE", "Production", E + " — team rules", L),
    ("Commission", "One-time Model A cases A1–A4 (20 / 4 / 3; dealer 4% one level up) (§3.1)", "DONE", "Production", E + " — 8 cases × ₹1,000 / ₹2,500; " + U, L),
    ("Commission", "One-time Model B cases B1–B4 (owner 25% / 5%, agent 20%, TL 4%), GoKesari pays each person directly (§3.2)", "DONE", "Production", E + " — 8 cases × ₹1,000 / ₹2,500", L),
    ("Commission", "Hierarchy snapshot on every commission record (model, case, franchise, zone, rates)", "DONE", "Production", "dealer_tier_shop_plans.model / case_code / franchise_* ; " + E, L),
    ("Commission", "Parity rule: one agent and one TL rate for both models; owner rates never below the free dealer's (§3.4)", "DONE", "Production", E + " — parity", L),
    ("Commission", "Recurring 25% of 2% on delivered orders, cancellations / refunds netted (§4)", "DONE", "Production", E + " — recurring", L),
    ("Commission", "Monthly bonus: baseline, base points, 100 points = 1%, one decimal, cap 30% (§4.1)", "DONE", "Production", "tests/unit/franchise-bonus.test.ts", L),
    ("Commission", "Free teams in a paid zone: no owner override, attached for recurring, 2-owner split, attaches to a later franchise (§6)", "DONE", "Production", E + " — zone attachment", L),
    ("Commission", "Upgrade Free → Paid: team rates unchanged, earlier shops attach, new shops Model B (§7)", "DONE", "Production", E + " — upgrade", L),
    ("Franchise", "Renewal at the current fee, 2 per zone, reminders 30 / 15 / daily with CEO copy, code closed at expiry (§4.2)", "DONE", "Production", E + " — reminders, tail", L),
    ("Franchise", "Tail: own-team shops 2 more years; free-team shops move to the next owner; buy-back does not restore (§4.2)", "DONE", "Production", E + " — tail", L),
    ("Zones", "50 zones GKZ-PUN-01…50, area master 196 areas, 189 mapped, 7 Unzoned, short names mapped (§5.1)", "DONE", "Production", "scripts/franchise/build-zone-seed.py checks; " + E, L),
    ("Zones", "Shop → area at registration (suggested by PIN / location, confirmed); admin / operator correction audited (§5.1)", "DONE", "Production", E + " — areas", L + "; area coordinates / PINs are approximate (G-03)"),
    ("Zones", "Tier and fee rule, ±10% Standard, nearest ₹1,000, min / max option, tier names and colours (§5.2)", "DONE", "Production", U, L),
    ("Zones", "Provisional seed (20 / 12 / 18), import → preview → publish, provisional-sale switch off (§5.3)", "DONE", "Production", E + " — fees; " + U, L + "; owner to import actual business"),
    ("Zones", "Zone description text, positive for every tier (§5.4)", "DONE", "Production", U, L),
    ("Booking", "Booking page: map coloured by tier, list filters, cart, 15-min hold, 100% upfront, fee locked (§5.5)", "IN PROGRESS", "Production", E + " — booking", L + "; signed-in booking / payment on production not yet run (owner)"),
    ("Zones", "Zone status: Available / Coming Soon / Reserved / On Hold / Sold Out / Inactive, bulk, scheduled, logged, notified, max 1–2 (§5.6)", "DONE", "Production", E + " — zone status", L),
    ("Coupons", "Coupons on franchise fees: %, flat, cap, scope, public / private, limits, first purchase, launch only, renewal, GST after discount, release on failure / refund, report (§5.7)", "IN PROGRESS", "Production", E + " — coupons; " + U, L + "; signed-in booking / payment on production not yet run (owner)"),
    ("Payouts", "Payout on the 5th, TDS, statements, reversals deducted from next payout (§8)", "IN PROGRESS", "Production", E + " — month end", L + "; uses the existing dealer payout batches"),
    ("Screens", "Dealer / owner, TL, agent dashboards; public Commission Chart; Admin zones, status, fees, areas, coupons (§9)", "DONE", "Production", "src/app/dealer/commission-chart, src/components/franchise/admin/*", L),
    ("Mobile", "Android app from the website: gokesari.com/app serves the APK (1.12.0); iPhone via Add to Home Screen (owner, 21-Nov 09.20)", "DONE", "Production", "https://gokesari.com/app/download/android 200, 42,147,603 bytes, sha256 205eb69f…", L),
    ("Mobile", "Play Store / App Store submission (§12.1)", "BLOCKED", "—", "—", "Owner has no store access yet; push later"),
    ("Launch", "Launch fee Rs 1,50,000 for every zone with the regular (tier) rate shown beside it (owner, 21-Nov 09.20)", "DONE", "Production", "gokesari.com/api/franchise/zones: GKZ-PUN-02 fee 1,50,000, regular 2,26,000", L),
    ("Launch", "Zones on sale: Pune 50, Mumbai (Konkan) 38, Nashik 11 — all Available, booking open (owner, 21-Nov 09.20)", "DONE", "Production", "99 zones AVAILABLE, bookingOpen true, 25 launch places", L + "; Mumbai / Nashik zone lists drafted — owner to review"),
    ("Testing", "Testing on test.gokesari.com (§12.3)", "DONE", "Staging", "Staging queue 21-Nov 11.13 IST: CI, migration 0157, deploy, post-deploy check, guest QA tier", "Signed-in franchise checks on staging not yet automated"),
    ("Testing", "Testing on gokesari.com (§12.3)", "IN PROGRESS", "Production", "21-Nov 11.31 IST: post-deploy check 5/5; /franchise, /franchise/book, zone pages, /dealer/commission-chart, /app all 200; zones API 99 Available", "Signed-in booking + real payment pending (owner). Pages returned 500 from 11.22 to 11.26 IST (migration ran after the deploy — fixed)"),
]
wb = Workbook()
ws = wb.active
ws.title = "Tracker"
ws.append(["GoKesari Franchise — final brief 21-Nov-2026 08.06 IST: dealer charging, commission and Pune franchise zones"])
ws.append([f"Last updated {stamp} · statuses: DONE · IN PROGRESS · BLOCKED · NOT STARTED"])
ws.append(["No.", "Area", "Feature", "Status", "Environment", "Evidence", "Notes / next step", "Last updated (IST)"])
fills = {"DONE": "C6EFCE", "IN PROGRESS": "FFEB9C", "BLOCKED": "FFC7CE", "NOT STARTED": "D9D9D9"}
for i, r in enumerate(rows, 1):
    ws.append([i, r[0], r[1], r[2], r[3], r[4], r[5], stamp])
    ws.cell(row=ws.max_row, column=4).fill = PatternFill("solid", fgColor=fills[r[2]])
ws["A1"].font = Font(bold=True, size=14)
for c in ws[3]:
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor="C2410C")
widths = [5, 10, 60, 14, 18, 50, 60, 22]
for i, w in enumerate(widths, 1):
    ws.column_dimensions[get_column_letter(i)].width = w
for row in ws.iter_rows(min_row=4):
    for c in row:
        c.alignment = Alignment(wrap_text=True, vertical="top")
ws.freeze_panes = "A4"
s = wb.create_sheet("Summary")
s.append(["Status", "Features"])
for k in fills:
    s.append([k, sum(1 for r in rows if r[2] == k)])
s.append(["Total", len(rows)])
wb.save(out)
print(out, len(rows))
