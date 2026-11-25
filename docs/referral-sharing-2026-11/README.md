# Referral sharing — audit, gap report and build (25-Nov-2026)

Owner brief: 25-Nov-2026 17.10 IST — "Referral Sharing (Dealer, Shop Owner, Customer)".
Additive only: no referral, reward, commission or registration rule was changed. All times are IST.

## 1. Audit — what exists today

| Area | Where | What it does |
|---|---|---|
| Codes (dealer / team lead / agent / franchise / GoKesari) | `referral_codes` (+ `dealer_codes`, `franchise_codes`) | One table for every partner code. Prefixes: `GKD-` dealer, `GKT-` team lead, `GKA-` agent, `GKF-` franchise (`src/server/franchise/prefixed-code.ts`); GoKesari / distributor codes are 4–8 letters and digits. Status ACTIVE / INACTIVE / EXPIRED, optional `expires_at`, `max_uses`. |
| Dealer hierarchy | `dealers` (level 1), `dealer_salespeople` (`team_role` TEAM_LEAD depth 2, AGENT depth 3) | A fourth level is impossible in the database. |
| Shop attribution | `shops.referral_code_id`, `referral_redemptions` (one per shop), `shop_attributions`, `franchise_shop_attributions` | `attributeShopToCode` + `recordShopAttribution` (dealer code → dealer; GKF → franchise owner; else GoKesari Direct). |
| Commission 20 / 4 / 3 % | rule `dealerTieredCommission` (`directBp 2000`, `leadOverrideBp 400`, `mainOverrideBp 300`), `src/server/dealers/tiered.ts` | Matches the agreed free-dealership policy. Rule is admin-switchable. |
| Franchise 25 % + recurring | `src/server/franchise/config.ts` (`ownerSelfBp 2500`, overrides 400 / 300, `recurringBaseBp 2000`) | Matches the agreed paid-franchise policy. Expired franchise → codes closed (`closeAllocationCodes`). |
| Customer referral (friend) | `customer_referral_codes` (GK + 6), `customer_referrals`, rule `customerReferrals` | Self-referral refused (also a DB check), one referrer per customer (unique), new customers only, duplicate-account checks, reward after first delivered order. |
| Customer code at sign-up | `customer_signup_referrals`, `/api/me/signup-referral` | A GoKesari / partner code or a friend's code, once, before the first order. |
| Shop refers shop | `shop_referral_codes` (SHOP + 5), `shop_referrals`, rule `shopReferrals` | Own code refused, same-business checks, reward after approval + first delivery. |
| Mandatory / optional toggle | `referral_settings` (`referral_required_customer`, `referral_required_shop`, default OPTIONAL), Admin → Referral settings | Enforced in the shop wizard, Add my shop, `/shop/join`, operator flows and the customer's first order. Read live; logged. |
| Referral link | `/r/<code>` → cookie `gk_ref` (30 days) → `/signin`; SHOP codes → `/shop/register?ref=` | Pre-fills customer first-time setup. |
| Dealer sharing | `/dealer` (QR, WhatsApp, Copy link), `/franchise/my` (QR, link, WhatsApp) | Link was `/shop/register?ref=CODE`. |
| Mobile app | Expo WebView app; App Links / Universal Links for `/r/`, `/refer`, `/dealer`, `/shop/register`, `/franchise`…; `navigator.share` bridged to the native share sheet | Association files need `MOBILE_ANDROID_CERT_SHA256` / `MOBILE_IOS_APP_IDS` (Android set 20-Nov). |

## 2. Agreed policy vs code

| Policy | Code | Verdict |
|---|---|---|
| Free dealership: Dealer → Team Lead → Agent, 20 % / 4 % / 3 % | `dealerTieredCommission` 2000 / 400 / 300 bp | Matches (rule on in production since 21-Nov). |
| Paid territory franchise: 25 % onboarding + recurring | franchise config 2500 bp own shops + 2000 bp recurring | Matches. |
| Shop-owner and customer referral benefit unchanged | `shopReferrals`, `customerReferrals` rules | Unchanged by this work. |
| Admin mandatory / optional toggle | `referral_settings` | Matches; respected by every registration path; the share link only pre-fills. |

## 3. Gap report

| # | Gap | Kind | Action |
|---|---|---|---|
| G-1 | No share by SMS, email or the phone's share sheet for dealers, franchise owners and customers (WhatsApp + copy only) | Missing | **Built**: one Share component (WhatsApp, SMS, Email, share sheet, Copy link) on `/refer`, the shop's Registration page, `/dealer` (own and employees' codes) and `/franchise/my`. |
| G-2 | `/r/GKD-…` did not work: the route stripped the hyphen, so dealer / team / agent / franchise codes never matched, and non-SHOP codes went to customer sign-in | Broken | **Fixed** (rule `referralSharing` on): hyphen kept; partner codes open Add my shop with the code filled in. |
| G-3 | No log of shares or link opens; no "My referrals"; no report by channel | Missing | **Built**: `referral_link_events` (0202), `/referrals`, Admin → Referral sharing report. |
| G-4 | A closed / expired franchise code showed the generic "Referral code … is inactive." in the wizard (the franchise message was checked after) | Broken message | **Fixed**: `assertRegistrationReferralCode` asks the franchise check first. |
| G-5 | Replacing a team lead's code issued a `GKA-` (agent) code | Bug | **Fixed**: team leads get `GKT-`. |
| G-6 | No deferred deep link (link opened before the app is installed is lost) | Missing | **Built**: app 1.15.0 opens `/app-open` once after install; the server matches the phone's recent click (same network, 24 h, unclaimed, usable, not the account's own) and pre-fills the code. |
| G-7 | No "Referred by <name>" on registration | Missing | **Built**: banner on sign-in, first-time setup and Add my shop. |
| G-8 | Expired / closed / unknown links ended in a generic error later in the form | Missing | **Built**: `/invite/<code>` explains why at the click. |
| G-9 | A later link overwrote the earlier one (last link won) | Mismatch with "first valid link wins" | **Fixed** (rule on): the first valid link is kept; a later one is logged `KEPT_FIRST`. |
| G-10 | Admin pages for customer / shop referrals and commission have no date, dealer or code filters | Missing (reports) | Not changed here; the new sharing report has referrer / role / channel / date filters. |

Not changed (policy not defined — **open questions for the owner**):

1. **Customer codes from dealers.** A customer can enter a dealer code at sign-up; it is recorded, but no dealer commission exists for customers. Should dealers earn anything for customers they bring?
2. **Referral code at dealer application.** Should a new dealer / team lead / agent apply with a referrer's code (and should that count anywhere)?
3. **Deferred-link window.** 24 hours, same network (rule `referralSharing.deferredMatchHours`, admin-editable). Shorter or longer?
4. **Play Store / App Store install referrer.** The app is installed from gokesari.com today (no store listing), so the network match is used. Once on the stores: add Google Play Install Referrer (exact match) — needs a native module and a store build.
5. **Rewards for shares.** Nothing is paid for a share or a click (only for sign-ups under the existing rules). Confirm.

## 4. What was built

- **Link** `https://gokesari.com/r/<CODE>?c=<wa|sms|em|sh|cp|qr>` for every referrer.
  - Customer codes → `/signin` (or `/refer` when signed in), cookie `gk_ref` as before.
  - Dealer / team lead / agent / franchise / shop codes → `/shop/register?ref=<CODE>`.
  - Closed / expired / unknown → `/invite/<CODE>` with the reason (e.g. "Referral code X expired on …", "This franchise code closed when the franchise in zone … expired on …").
  - Own link → nothing applied, logged `SELF`.
  - Cookie `gk_ref_link` = first valid link (30 days).
- **Message** English + Hindi (Marathi for Marathi users), with the link: "Register your shop on GoKesari with <name>'s referral code <CODE>: <link>" / "<name> invited you to GoKesari … Use code <CODE>: <link>".
- **Attribution** is unchanged: the code is only pre-filled where the existing flows take one; every existing check applies (self-referral, one referrer per account, mandatory / optional, expired / closed, max uses, franchise expiry). Role and level come from the code itself (dealer / team lead / agent / franchise / shop / customer).
- **Logging** `referral_link_events`: SHARE (owner only; a main dealer may share his employees' codes), CLICK (channel, outcome OK / SELF / KEPT_FIRST / EXPIRED / CLOSED / INVALID, in-app or browser), APP_OPEN, CLAIM. No IP stored — only a salted hash for the deferred match.
- **My referrals** `/referrals` (Profile → My referrals): per code — shared (by channel), link opens, signed up, pending, earned (wallet rewards or commission from `dealer_commission_ledger`), commission pending.
- **Admin / operator report** `/admin/referral-links` (Admin → More → Referral sharing report): referrer (code / name / e-mail), role, channel, From / To (IST); totals and the latest 200 events.
- **Switch** rule `referralSharing` (Admin → Settings): `enabled` (default **on**), `deferredMatchHours` (24). Off = the original `/r/` route and buttons, nothing logged.
- **Mobile 1.15.0** (Android versionCode 16, iPhone build 16): first-open page `/app-open` (deferred link); `/invite/` and `/app-open` open in the app. Share inside the app uses the existing native share bridge; WhatsApp / SMS / e-mail links open those apps (navigation policy).

## 5. Deploy

- Migration `0202_referral_link_events.sql` (the staging queue renumbers it on a clash). Rollback: `scripts/rollback-0202-referral-link-events.sql`.
- No new environment variables. For the "Google Play" / "App Store" buttons the existing `MOBILE_APP_ANDROID_URL` / `MOBILE_APP_IOS_URL` are used; without them the banner links to `/app` (the website APK).
- Production: run the prod-db migrate before the deploy (25-Nov sign-in outage lesson).

## 6. Tests

- `tests/integration/referral-sharing.test.ts` (14 cases), `tests/unit/referral-share.test.ts`, `tests/unit/referral-link.test.ts` (both rule states), `mobile/src/__tests__/first-open.test.ts`.
- Regression run locally 25-Nov-2026 17.30–17.36 IST: unit 1,702 / 1,702; referral, dealer, franchise and registration integration suites 343 / 343; mobile 63 / 63.
- Staging / production test report: `TEST_REPORT.md` in this folder (also in the owner's `Test_Cases_Tracking` folder).
