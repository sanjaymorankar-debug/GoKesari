"""Builds GOKESARI_ONBOARDING_V2_TRACKER_<date>.xlsx (docs/onboarding-v2-2026-11).

Usage: python3 tracker.py <out.xlsx> "<stamp IST>" <status.json>
status.json maps feature id -> {"status": "...", "test": "...", "prod": "...", "notes": "..."}; missing ids keep the defaults below.
Status is one of: Not started / In progress / Done / Blocked.
"""
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

OUT, STAMP, STATUS_FILE = sys.argv[1], sys.argv[2], sys.argv[3]
status = json.load(open(STATUS_FILE))

FEATURES = [
    ("F0.1", "Foundation", "Feature flag onboarding_v2 (Test ON by migration, Prod OFF)"),
    ("F0.2", "Foundation", "Migration 0215: role history, team invitations, franchise plans, licence entries"),
    ("F0.3", "Foundation", "Data migration: wallet for shop owners without one; existing roles recorded"),
    ("F0.4", "Foundation", "Multi-role accounts (customer, shop_owner, dealer_free, franchisee_paid, team_lead, agent, admin, operator)"),
    ("F1.0", "Flow 1 Customer", "Guest mode: browse, search, nearby, shop pages, QR links, add to cart without sign-in"),
    ("F1.1", "Flow 1 Customer", "Cart kept in browser and merged into account after login"),
    ("F1.2", "Flow 1 Customer", "Login sheet at Place order (and account-only actions), cart kept"),
    ("F1.3", "Flow 1 Customer", "Step 1: T&C + Privacy checkbox, version + IST timestamp stored"),
    ("F1.4", "Flow 1 Customer", "Step 2: verify email (Google or magic link), no referral here"),
    ("F1.5", "Flow 1 Customer", "Step 3: mobile OTP; account + wallet auto-created; returning users skip"),
    ("F1.6", "Flow 1 Customer", "Step 4: back to checkout, order to chosen shop, ONLINE / COD mandatory choice"),
    ("F1.7", "Flow 1 Customer", "Delivery fee estimate before payment (GPS / saved address / base fee)"),
    ("F1.8", "Flow 1 Customer", "Step 5: delivery location after payment (GPS + pin or saved); optional name, address, referral"),
    ("F1.9", "Flow 1 Customer", "Step 6: confirmation + real-time tracking"),
    ("F2.1", "Flow 2 Shop", "Identity: T&C + mobile OTP + email (skip if verified customer)"),
    ("F2.2", "Flow 2 Shop", "Referral code (admin toggle) + Request a referral code email"),
    ("F2.3", "Flow 2 Shop", "GST/PAN verified online, shop + owner name auto-filled"),
    ("F2.4", "Flow 2 Shop", "Registration fee after verification (₹1,000 shop / ₹2,500 wholesale from config), online only"),
    ("F2.5", "Flow 2 Shop", "Pending payment saved; owner can resume; customer side still usable"),
    ("F2.6", "Flow 2 Shop", "Shop type + required licences from config"),
    ("F2.7", "Flow 2 Shop", "Licence option: Enter details (online verify / operator)"),
    ("F2.8", "Flow 2 Shop", "Licence option: Upload file (mobile + desktop)"),
    ("F2.9", "Flow 2 Shop", "Licence option: Scan (camera / OCR prefill)"),
    ("F2.10", "Flow 2 Shop", "Licence option: Upload later (checkbox) + existing reminder policy"),
    ("F2.11", "Flow 2 Shop", "Seller SLA personalised, digital acceptance, signed copy EN/MR/HI + banner"),
    ("F2.12", "Flow 2 Shop", "Address + map pin mandatory"),
    ("F2.13", "Flow 2 Shop", "Go live automatically (GST/PAN + fee) else operator review; welcome email + QR"),
    ("F2.14", "Flow 2 Shop", "Background customer account + wallet for shop owner"),
    ("F3.1", "Flow 3 Franchise", "Become a franchisee button; /franchise and /franchise/book route after login"),
    ("F3.2", "Flow 3 Franchise", "No shop, no franchise: redirect to shop onboarding and back"),
    ("F3.3", "Flow 3 Franchise", "Free dealer: no area, instant dealer code, live at once"),
    ("F3.4", "Flow 3 Franchise", "Paid: zones with tiers, max 2 per zone, availability"),
    ("F3.5", "Flow 3 Franchise", "Paid: subscription plan (admin plans table), optional coupon, 100% online pay"),
    ("F3.6", "Flow 3 Franchise", "Paid: live on payment, franchise code, expiry / renewal / reminders"),
    ("F3.7", "Flow 3 Franchise", "KYC reuse; PAN + bank before first payout; 30-day KYC refund rule removed"),
    ("F4.1", "Flow 4 Team", "My team: search by mobile / email"),
    ("F4.2", "Flow 4 Team", "Invite unregistered person (WhatsApp / SMS / email link)"),
    ("F4.3", "Flow 4 Team", "Assign role team lead / agent (+ parent)"),
    ("F4.4", "Flow 4 Team", "Team leads add agents (admin toggle, on)"),
    ("F4.5", "Flow 4 Team", "Member accepts / declines; role added only on accept"),
    ("F4.6", "Flow 4 Team", "Member KYC: PAN + bank before first payout"),
    ("F4.7", "Flow 4 Team", "Upgrade / downgrade (reassign agents first) / remove role, IST audit trail"),
    ("F4.8", "Flow 4 Team", "Commission chain (20/4/3) fed by the new hierarchy"),
    ("A.1", "Admin", "See and override roles (with history)"),
    ("A.2", "Admin", "Change zone status"),
    ("A.3", "Admin", "Manage subscription plans"),
    ("A.4", "Admin", "Licence status and reminders per shop; operator licence queue"),
    ("M.1", "Mobile", "Android app: all four flows (WebView app shows the live site)"),
    ("M.2", "Mobile", "iOS app: all four flows (WebView app shows the live site)"),
    ("M.3", "Mobile", "Camera scanning for licences in the apps"),
    ("M.4", "Mobile", "Deep links /franchise/start, /dealer/team, /team/*"),
    ("T.1", "Testing", "Full test pass on test.gokesari.com"),
    ("T.2", "Testing", "Deploy to gokesari.com (flag OFF)"),
    ("T.3", "Testing", "Full test pass on gokesari.com + flag ON"),
]

wb = Workbook()
ws = wb.active
ws.title = "Features"
head = ["ID", "Area", "Feature", "Status", "Test (test.gokesari.com)", "Prod (gokesari.com)", "Notes", "Updated (IST)"]
ws.append(head)
colours = {"Done": "DCFCE7", "In progress": "FEF9C3", "Blocked": "FEE2E2", "Not started": "F3F4F6"}
for fid, area, name in FEATURES:
    s = status.get(fid, {})
    st = s.get("status", "Not started")
    ws.append([fid, area, name, st, s.get("test", ""), s.get("prod", ""), s.get("notes", ""), STAMP])
    ws.cell(row=ws.max_row, column=4).fill = PatternFill("solid", fgColor=colours.get(st, "FFFFFF"))
fill = PatternFill("solid", fgColor="F97316")
for c in ws[1]:
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = fill
for col, w in zip("ABCDEFGH", (7, 16, 60, 13, 34, 34, 70, 22)):
    ws.column_dimensions[col].width = w
for row in ws.iter_rows(min_row=2):
    for c in row:
        c.alignment = Alignment(wrap_text=True, vertical="top")
ws.freeze_panes = "A2"
wb.save(OUT)
print("saved", OUT)
