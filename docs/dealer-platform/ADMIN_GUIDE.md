# Dealer platform: admin guide

Where to start:
- **Admin → Dealers.** The links at the top go to **Dashboard**, **Schemes**, Commission, Franchise, Referral moves, Claims and Analytics.
- **Staff in a dealer role** (Business Admin, Dealership Manager, Finance Admin, Regional Admin, Auditor, Read-only) land on `/admin/dealers/dashboard`.

## Who can do what

| Role | Can |
|---|---|
| Admin | Everything. The Super Admin (`SUPER_ADMIN_EMAIL`) may approve alone while fewer than two admins exist. |
| Business Admin | Schemes (edit, publish), approve and suspend dealers, move dealers between schemes, territories, commission rules. Not payouts or refunds. |
| Dealership Manager | Scheme drafts (not publishing), approve and suspend dealers, territories |
| Finance Admin | Payouts, closing the commission month, refunds, commission adjustments, TDS |
| Regional Admin | Approve and suspend dealers in his own states / districts only |
| Auditor | Read everything on the dealer platform, including the audit log |
| Read-only | Read the dealer platform's screens |

- **Assigning a role:** Admin → Users → the person → Privileges. Choose the role there.
- **A Regional Admin's areas:** set by an admin through `setRegionScope` (a screen for this is a follow-up).
- **Second approver:** turn on the flag `dealer_platform_four_eye` (Admin → Feature flags). Then these actions wait in Admin → Approvals for a different admin:
  - publishing or scheduling a scheme;
  - changing a scheme's status;
  - moving a dealer to another scheme;
  - refunding a franchise booking.

## Schemes (Admin → Dealers → Schemes)

1. **Create a scheme.** Give a code (e.g. `SILVER_PARTNER`), a name and a category, then start from blank terms or a copy of any version.
2. **Open the scheme** to edit its draft section by section:
   - basic information;
   - the joining charge and GST (added on top or included);
   - commission: one-time, monthly, team (levels 1 and 2), referral, target and performance bonus. Each one is based on the shop fee, GoKesari's commission, sales, a fixed amount or a formula. Set how long each is paid;
   - team building and the commission budget;
   - geography and exclusivity, dealers per territory, zone booking;
   - validity and renewal;
   - eligibility, benefits and payment conditions;
   - **custom fields** (asked on the application) and **eligibility rules**.
3. **Preview** shows the terms as applicants see them. **Simulator** shows GMV, platform revenue, dealer payout and GoKesari's net for your assumptions, using the live calculation.
4. **Save draft**, then **Publish now** or **Schedule launch**. Every change needs a reason, which goes into the audit log.
   - New applicants get the published version.
   - Dealers on an older version keep it.
5. **New version:** edit while a version is published, then save; this starts the next draft. **Compare versions** lists every changed field.
6. **Suspend** stops new applicants, and existing dealers are unaffected. **Reopen**, **Expire** and **Archive** do what they say. Free Dealership can only be suspended.

### Formulas

- **Variables:**
  - `shopRegistrationFeePaise`, `shopActivationFeePaise`, `platformCommissionPaise`;
  - `transactionValuePaise`, `netTransactionValuePaise`;
  - `shopsThisMonth`, `activeShops`, `monthsSinceActivation`, `dealerRating`;
  - numeric custom fields as `cf_<key>`: amounts in paise, % in basis points, yes = 1.
- **Functions:** `IF`, `MIN`, `MAX`, `ROUND`, `FLOOR`, `CEIL`, `ABS`, `CLAMP`, `PERCENT(base, bp)`, plus `and`, `or`, `not` and comparisons.
- **Example:** `IF(shopsThisMonth >= 50, PERCENT(platformCommissionPaise, 700), PERCENT(platformCommissionPaise, 500))`.
- **Safety:** formulas run in a safe engine, never as code. An invalid formula is refused when you save.

## Dealers

- **A dealer's page** shows:
  - his **Scheme** (version, start date, terms) and his scheme history;
  - his answers to the scheme's questions, with downloadable files;
  - the existing documents, codes, team and commission rates.
- **Approve or reject** as before.
  - Approval puts him on the version he accepted.
  - Rejection refunds a paid joining charge through the gateway.
- **Move a dealer to another scheme:** only to a version he has accepted from his dealer page in the last 30 days, and with any joining charge paid (`POST /api/admin/dealers/{id}/scheme`).

## Dashboard (Admin → Dealers → Dashboard)

- **Filters:** date, scheme, dealer status, state, district, city, shop status.
- **Figures:** dealers (free / paid / franchise, by status and scheme, registrations by month, earning in the last 90 days); shops onboarded and activated; GMV; platform revenue; commission accrued, monthly, paid and liability; pending settlements; net revenue; territory utilisation; scheme performance; dealer-wise shops.
- **Export:** "Download CSV" exports the same figures.

## Commission and payouts

- **Commission runs by itself.**
  - One-time lines are written when a shop activates.
  - Monthly lines are written in the month close (day 5 by default), and approval and payouts follow as before.
- **Unchanged screens:** Commission, rating & payouts; Franchise; TDS.
