"""Builds GOKESARI_DUAL_AUTH_TRACKER_<date>.xlsx (docs/dual-auth-2026-11).

Usage: python3 tracker.py <out.xlsx> "<stamp IST>" <status.json>
status.json maps feature id -> {"status": "...", "test": "...", "prod": "...", "at": "<IST>", "notes": "..."};
missing ids keep "Not started". Status is one of: Not started / In progress / Done / Blocked.
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

OUT, STAMP, STATUS_FILE = sys.argv[1], sys.argv[2], sys.argv[3]
status = json.load(open(STATUS_FILE))

FEATURES = [
    ("D0.1", "Foundation", "Feature flag dual_auth (Test ON by migration, Prod OFF until Prod pass)"),
    ("D0.2", "Foundation", "Migration 0219: needs_second_factor, trusted_devices, reminder column"),
    ("D0.3", "Foundation", "Rule dualAuth (lifetimes, resend, lockout, trust days, step-up minutes)"),
    ("D1.1", "DualVerify", "Shared module (policy, verify, devices, step-up) + /account/verify page"),
    ("D1.2", "DualVerify", "A. Terms tick with version + IST time (existing ticks reused)"),
    ("D1.3", "DualVerify", "B. Mobile +91, 6-digit SMS code, autofill (one-time-code / WebOTP)"),
    ("D1.4", "DualVerify", "C. E-mail: code (new) / link (existing) / Google only if email_verified"),
    ("D1.5", "DualVerify", "D. Account check after both codes; different-accounts stop + operator log"),
    ("D2.1", "Flows", "Customer: guest browse, Place order -> DualVerify -> cart kept, no referral"),
    ("D2.2", "Flows", "Shop onboarding step 1 through DualVerify (skip if dual-verified)"),
    ("D2.3", "Flows", "Mobile-only shop registration removed (Module 3 closed)"),
    ("D2.4", "Flows", "On-behalf shops not live until owner verifies both; auto-release after"),
    ("D2.5", "Flows", "Franchise / team inherit; dealer, team, franchise pages gated"),
    ("D3.1", "Returning", "Customer: one factor on trusted device, both on new device (30 days)"),
    ("D3.2", "Returning", "Shop owner / dealer / team: both on new device (30 days)"),
    ("D3.3", "Returning", "Admin / operator / staff: both on every sign-in"),
    ("D3.4", "Sensitive", "Mobile / e-mail change: both codes + new one verified; devices revoked"),
    ("D3.5", "Sensitive", "Bank / payout account add or change: both codes"),
    ("D3.6", "Sensitive", "Wallet withdrawal / refund to bank: both codes"),
    ("D3.7", "Sensitive", "My team role changes: both codes"),
    ("D3.8", "Sensitive", "Shop ownership transfer: guard ready (no transfer flow exists)"),
    ("D4.1", "Migration", "One-factor accounts marked needs_second_factor; can browse"),
    ("D4.2", "Migration", "Missing factor asked before order / shop / dealer / withdrawal"),
    ("D4.3", "Migration", "Mobile-only shops: e-mail asked at sign-in, banner, SMS reminder, stay live"),
    ("D4.4", "Migration", "Admin report: mobile-only shops, conflicts, IST audit (/admin/dual-auth)"),
    ("D5.1", "Security", "Lifetimes 5 / 10 / 15 min; resend 30 s, 3 resends per 15 min"),
    ("D5.2", "Security", "Lockout 15 min after 5 wrong codes; rate limits by number, e-mail, IP"),
    ("D5.3", "Security", "Hashed OTPs, never logged; IST audit trail; no registration leak"),
    ("D6.1", "Apps", "Android + iOS (WebView shells): same DualVerify, shipped with website deploy"),
    ("D6.2", "Apps", "Android native SMS Retriever (needs app hash in DLT template + store build)"),
    ("D7.1", "Testing", "Integration tests (29) + regression suites"),
    ("D7.2", "Testing", "Test pass on test.gokesari.com"),
    ("D7.3", "Testing", "Production deploy + Prod pass"),
    ("D7.4", "Release", "Flag dual_auth ON in Prod (needs real SMS on gokesari.com)"),
]

FILL = {
    "Done": PatternFill("solid", fgColor="C6EFCE"),
    "In progress": PatternFill("solid", fgColor="FFEB9C"),
    "Blocked": PatternFill("solid", fgColor="FFC7CE"),
    "Not started": PatternFill("solid", fgColor="EDEDED"),
}

wb = Workbook()
ws = wb.active
ws.title = "Dual auth"
ws.append([f"GoKesari — Dual authentication (flag dual_auth) — status at {STAMP}"])
ws["A1"].font = Font(bold=True, size=13)
ws.append([])
headers = ["ID", "Area", "Feature", "Status", "Test (test.gokesari.com)", "Prod (gokesari.com)", "Updated (IST)", "Notes"]
ws.append(headers)
for c in ws[3]:
    c.font = Font(bold=True)
for fid, area, feature in FEATURES:
    s = status.get(fid, {})
    st = s.get("status", "Not started")
    ws.append([fid, area, feature, st, s.get("test", ""), s.get("prod", ""), s.get("at", STAMP), s.get("notes", "")])
    ws.cell(ws.max_row, 4).fill = FILL.get(st, FILL["Not started"])
for col, width in zip("ABCDEFGH", [7, 12, 70, 12, 24, 24, 22, 70]):
    ws.column_dimensions[col].width = width
for row in ws.iter_rows(min_row=4):
    for c in row:
        c.alignment = Alignment(wrap_text=True, vertical="top")
wb.save(OUT)
print(OUT)
