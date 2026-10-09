# Staging vs main (production): comparison, 9 Oct 2026

Read-only comparison of the two branches on GitHub at 9 Oct 2026, about 12:10
UTC. Nothing was merged or deployed for this report.

| | `main` → gokesari.com | `staging` → test.gokesari.com |
|---|---|---|
| Head | `a13d287` (PR #107, 9 Oct) | `b3884df` (PR #113, 9 Oct) |
| Database migrations | 56 (newest **0055** order_completion) | 73 (newest **0072** customer_referral_requests) |
| Commits the other side lacks | 17 | 82 (54 excluding merges) |
| Source (`src/`) difference | | 389 files, +36,716 / −1,320 lines; 62 pages differ |

The branches last met at `06a1014`, the merge of release PR #86 into main on
8 Oct.

## 1. Production is behind staging by 17 migrations and about 8 feature releases

**Release #86 was reverted on main.** It was merged on 8 Oct, then reverted
the same day by PR #87, because the shop pages failed: the production
database did not have migrations 0056/0057 yet. Production therefore runs
the code from before #86 (migrations up to 0055).

On staging only (all tested on test.gokesari.com):

| # | What | Migrations |
|---|---|---|
| #86 (content kept on staging) | Items A–E: business limits as rules; customers see only the shop's own contact/WhatsApp; open-order prompt before paying; voucher-code visibility; only verified societies list riders; rider photo/KYC files behind access checks and rider ID card; cancellation before packing with full refund | 0056, 0057 |
| #89, #90 | Event layer: real-time workflows, cron only as a safety net | 0058 |
| #91, #93, #94, #98 | Shop prepaid wallet; OTP-confirmed delivery; ₹5/km delivery charge; no checkout below the wallet minimum; commission back on refunds | 0059, 0060 |
| #95–#97, #99 | Test wallet credits for test shops (test data only) | — |
| #102–#104 | Four features: delivery options & scheduling (pickup, own delivery staff, GoKesari partner, pickup OTP); mandatory legal documents by shop type with grace period; bank accounts with ₹1 verification; mandatory shop referral code + "request a code" | 0061–0064 |
| #106, #108 | Owner's decisions round 1: pickup refunds the delivery fee; refunds to a customer's bank; referral code at customer registration | 0065–0067 |
| #92 | Three modules: shop product media (photos/descriptions), accounting integration (Tally, Odoo, Zoho Books) & GST, shop self-registration | 0068–0071 |
| #109–#111 | Owner's decisions round 2: blocked shops show "not taking new orders"; mandatory customer referral code + customer code requests; invite links in the menu; approved refunds-to-bank wording | 0072 |
| #112 | Tile Board home screens for customer, shop owner, admin and operator | — |
| #113 | Docs: Cashfree sandbox test data | — |

Most of the four-features work is behind business rules that are **off by
default in code**. Production behaves as before until each rule is switched
on there. The other releases change behaviour directly once deployed.

## 2. Main has work that staging does not have

| PR | What | Files |
|---|---|---|
| #101 | **Mobile app**: Android and iPhone shell for gokesari.com (`mobile/`); Google sign-in hand-off and deep links on the website (`src/app/mobile-auth/*`, `src/app/.well-known/*`, `src/server/mobile-auth.ts`, `src/lib/mobile-app.ts`, sign-in page); CI and docs; Android APK workflow | `mobile/` (28 files), website routes, `ci.yml`, `mobile-apk.yml` |
| #100 | **iPhone home-screen app**: the site opens full-screen from Safari ("Add to Home Screen"): web app manifest, icons, standalone back button | `src/app/manifest.ts`, `layout.tsx`, `site-header.tsx`, `public/pwa/*` |
| #88 | Runbook: row-count checks no longer go stale | docs |
| #105, #107 | Feature/process-flow/PR status workbooks (8 and 9 Oct); `CLAUDE.md` rule on where reports are saved | docs, `CLAUDE.md` |
| #87 | The revert of release #86 | — |

**The mobile app and the iPhone home-screen support exist only in
production.** test.gokesari.com does not have them, so the app cannot be
tested against staging yet.

## 3. What happens when they are merged

The next release (staging → main), dry-run with `git merge-tree`:

- **A plain merge conflicts in 14 files:** `CLAUDE.md`, the migration
  journal, `migrate-on-build.mjs`, `schema.ts`, `rules.ts`, `orders.ts`,
  `serviceability.ts`, `delivery-assignment.ts`, `finance.ts`, `risk.ts`,
  `shops.ts`, the images route and two tests. The cause is the #86 revert:
  git treats #86 as already merged and keeps it reverted.
- **Revert the revert first, then merge staging:** `git revert e16dd6d` on
  a release branch from main. Only **`CLAUDE.md`** then conflicts (main's
  "where reports are saved" section and staging's Cashfree section; keep
  both). Everything else merges cleanly, including the mobile app files.
- **The other direction needs care too.** Bringing the mobile app into
  staging by merging main would also bring the #86 revert and strip items
  A–E from staging. Cherry-pick the mobile commits instead (`4c0a367`,
  `3ad4d20`, `1284b0e`, `478b264`, `81e3c1f`, `7e674d1`), or merge after
  reverting the revert.

## 4. Before promoting staging to production

1. **Database first:**
   - Back up production, then apply migrations 0056–0072 (17 migrations;
     "Production database" workflow or `npm run db:migrate`), then deploy.
     This is the step whose absence caused the #86 revert.
   - All 17 are additive, and each has a rollback script in `scripts/`.
2. **Release branch from main:** `git revert e16dd6d`, merge staging,
   resolve `CLAUDE.md` (keep both sections), run CI, then merge into main.
3. **Environment on gokesari.com:**
   - Cashfree **live** keys (`CASHFREE_ENV=production`).
   - `PAN_ENCRYPTION_KEY` (used for bank accounts and legal-document copies).
   - Email settings, and a sending limit high enough.
   - The daily cron.
   - Details: `docs/four-features-2026-10/README.md` §5 and
     `docs/three-modules-2026-10/`.
4. **Business rules:**
   - Switch them on one at a time in Admin → Business rules.
   - Set `customerSignupReferral.requiredFrom` to the launch day.
   - Create the referral codes before `shopReferral.required`.
   - Make the finance lead an Administrator before turning on
     `bankRefunds`.
5. **Test data:** test wallet credits (#95–#99) and the E2E accounts are
   test-database only and are not in the code release.

## 5. Not checked here

- The production database itself (only the code and the migration files were
  compared).
- Whether the mobile app works against staging's newer API (it has not run
  there).
