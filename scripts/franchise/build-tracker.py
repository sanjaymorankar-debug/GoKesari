"""Builds the franchise feature tracker (brief §16) as an .xlsx: one row per feature, status, environment,
evidence and last updated (IST). Usage: /usr/bin/python3 scripts/franchise/build-tracker.py <out.xlsx> "<DD-Mmm-YYYY HH.MM IST>"
Status values: COMPLETED · IN PROGRESS · BLOCKED · NOT STARTED (never COMPLETED without evidence)."""
import sys
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

out, stamp = sys.argv[1], sys.argv[2]
L = "Built + tested locally (gk_franchise_test); waiting for the staging queue"
E = "tests/integration/franchise-pmr.test.ts"
rows = [
    ("Model A", "Free dealer registration (OTP, PAN, bank penny-drop, KYC)", "COMPLETED", "Production (existing)", "Existed before the brief; regression suite", "No change needed (gap A1)"),
    ("Model A", "Dealer → Team Lead → Agent team management (add / move / promote / deactivate; TL deactivated → agents under the dealer; one mobile / bank per team; admin transfer)", "IN PROGRESS", "Local", E + " (Model A sections)", L),
    ("Model A", "20 / 4 / 3 commission by level distance (4 cases, ₹1,000 and ₹2,500)", "IN PROGRESS", "Local", E + " — the four cases × 2 fees", L + "; rule field overrideByDistance (F-07)"),
    ("Model A", "GKD- / GKT- / GKA- codes for new codes", "IN PROGRESS", "Local", E + " — code prefixes", L + "; old codes keep working (F-01)"),
    ("Model B", "Territory master import (91 zones, 7 clusters, totals)", "IN PROGRESS", "Local", "scripts/franchise/build-zone-seed.py output (ALL PASS) + " + E, L),
    ("Model B", "Area booking UI (clusters, search, filters, sort, list / map, cart)", "IN PROGRESS", "Local", "docs/franchise/evidence/01-book-desktop.jpg, 02-book-phone-c5-cart.jpg", L),
    ("Model B", "Launch-offer counters (25 owners / 25 areas, close rules, no future price)", "IN PROGRESS", "Local", E + " — launch offer", L),
    ("Model B", "Boundary editor (reference point, circle / polygon, 5 km, overlap, GeoJSON, split)", "IN PROGRESS", "Local", E + " — boundaries", L + "; real boundaries must be drawn / imported by an admin (no coordinates in the workbook)"),
    ("Model B", "Capacity locking (2 slots in the DB, 10 parallel → 2, one owner one slot, all-or-nothing)", "IN PROGRESS", "Local", E + " — capacity", L),
    ("Model B", "Payments (FRANCHISE_FEE intent, signed webhook, idempotent, release on failure)", "IN PROGRESS", "Local", E + " — capture / failure", L + "; staging run uses the Sandbox payment page"),
    ("Model B", "Renewal (30-day window, same slot, +12 months, no auto-charge)", "IN PROGRESS", "Local", E + " — renewal", L),
    ("Model B", "Expiry reminders 30 / 15 / daily + CEO copy, 09:00 IST digest, admin alerts", "IN PROGRESS", "Local", E + " — reminders, digest", L + "; e-mail delivery itself verified on staging (EMAIL_REDIRECT_TO)"),
    ("Model B", "Auto-disable at expiry (renewal off, code closed for the zone, slot released)", "IN PROGRESS", "Local", E + " — at expiry", L),
    ("Model B", "3-year tail (fixed_end_of_year_3 / years_after_lapse)", "IN PROGRESS", "Local", "tests/unit/franchise-lib.test.ts + " + E + " — tail", L),
    ("Model B", "One-time 25% and monthly 25% of GoKesari's actual 2% (net of refunds)", "IN PROGRESS", "Local", E + " — commission", L),
    ("Model B", "Rating engine (bonus 0% until a formula is published; 0–5 pp)", "IN PROGRESS", "Local", E + " — bonus", L + "; formula itself is owner decision D2"),
    ("Model B", "Payouts on the 5th, TDS, statements (existing dealer payout)", "IN PROGRESS", "Local", "Existing close / batch / TDS reused; franchise statement lines added", L),
    ("Both", "Dashboards (owner /franchise/my, admin /admin/franchise, dealer upgrade link)", "IN PROGRESS", "Local", "Browser check on localhost:3720 (guest redirects, 401s)", L),
    ("Both", "Admin configuration (versioned, effective dates, super-admin max owners)", "IN PROGRESS", "Local", E + " — config used by every test", L),
    ("Both", "Migration (existing dealers → Model A; pincode territories)", "IN PROGRESS", "Local", "scripts/franchise/migrate-model-a.ts dry run", "Production run needs the owner's go-ahead (F-04); pincode territories not migrated (F-05)"),
    ("Apps", "Android app (franchise pages via WebView, /franchise deep links, 1.11.0 / versionCode 12)", "BLOCKED", "Code only", "mobile/app.config.ts, mobile/src/deep-links.ts; mobile tests 59/59", "Signed build + Play Console upload need the owner's EAS / Play access"),
    ("Apps", "iOS app (same, build 12)", "BLOCKED", "Code only", "mobile/app.config.ts; mobile tests 59/59", "TestFlight / App Store Connect need the owner's access"),
    ("Testing", "Test server (test.gokesari.com) run", "IN PROGRESS", "Local", "docs/testing/franchise-pmr/TESTING_REPORT.md (local run)", "Staging run after the queue merges the PR"),
    ("Testing", "Production (gokesari.com) run", "NOT STARTED", "—", "—", "Release needs the owner's OK (one release at a time; 23.00 IST window)"),
]
wb = Workbook()
ws = wb.active
ws.title = "Tracker"
ws.append(["GoKesari Franchise — Model A (free) and Model B (Pune PMR paid areas)"])
ws.append([f"Brief 20-Nov-2026 22.50 IST · last updated {stamp} · statuses: COMPLETED · IN PROGRESS · BLOCKED · NOT STARTED"])
ws.append(["No.", "Area", "Feature", "Status", "Environment", "Evidence", "Notes / next step", "Last updated (IST)"])
fills = {"COMPLETED": "C6EFCE", "IN PROGRESS": "FFEB9C", "BLOCKED": "FFC7CE", "NOT STARTED": "D9D9D9"}
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
