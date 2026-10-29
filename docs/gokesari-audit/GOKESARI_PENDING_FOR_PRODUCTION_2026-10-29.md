# GoKesari: what is not yet on production (29 Oct 2026, 16:10 IST)

Production (`main`) is at `6f161fa`, release #281 (dealer monthly payout). Its post-deploy check
passed at 10:27 UTC. No other release is in flight: there is no open PR into `main`.

## A. On staging, waiting for the next production release

| Item | Commit | State |
|---|---|---|
| Seller verification follow-ups: one source for GST/PAN; GSTIN one business (another owner refused, the same owner's branch allowed); Shop Act one shop; verified PAN / Udyam / Shop Act copied onto the shop; Udyam and Shop Act on the shop's GST/PAN card; 3 months (reminders every 15 days) for waived or promised shops; the promise reads 90 days | `32da8e5`, `1132782` | Staging check passed (duplicate Shop Act refused for another owner's and the same owner's shop; card shows the new rows). CI running. Release prepared next, owner asked for it |

## B. Open pull requests into staging (not on staging yet)

| PR | What | Notes |
|---|---|---|
| #280 `claude/dealer-base-commission` | Dealer commission: admin-set base % of the fee, moved up or down by the dealer's rating, per dealer | Has test results; needs merge into staging, staging check, then a release |
| #279 `perf/home-quick-fixes` | Home page: database reads run together; the logo link no longer prefetches home | Small; needs review and merge into staging |
| #278 `claude/peaceful-pascal-jai8w2` (draft) | Shop documents: staging QA run 29 Oct (SD-01 to SD-06), QA spec, defects D-106 and E-04 | Docs and a QA test only, no app code |

## C. Open defects and gaps

| # | What | Impact | Fix |
|---|---|---|---|
| D-106 (fixed in this release) | Onboarding wizard flag off, but its step-1 routes (`registration-draft/gstin` and `/pan`) still answer a signed-in non-admin. The later steps check the flag (#274) | On production (flag off), a signed-in user can still call the GSTIN / PAN checks directly, so paid government lookups are reachable without the wizard | Two lines: `requireWizardAvailable(user)` in both routes, as in the later steps |
| E-04 | test.gokesari.com: the registration-fee checkout uses the app's in-process SANDBOX gateway, not the Cashfree sandbox | Payment tests on staging can't use the Cashfree sandbox workflow | Owner decision (staging environment setting) |
| — | 3 staging shops have a verified PAN that isn't copied onto the shop row yet (verified before today's change); production not checked (reads are not allowed) | The shop's GST/PAN card shows PAN "Not verified" until the next check | A one-time catch-up script, if wanted |
| — | Preview builds and migrations: #276 (migrations only through the GitHub workflows) is now on production | Fixed; preview builds no longer migrate the staging databases | — |

## D. Built and on production, but switched off (feature flags)

All released with their flag off. Turning one on is the owner's decision. They can be switched on
for all of India, chosen states or chosen districts.

| Flag | Switches on |
|---|---|
| `dealer_programme_enabled` | Dealer application and portal, codes, attribution, commission, analytics, all-India add dealer |
| `gov_verification_auto_approval_enabled` | Instant shop approval on GST/PAN verification + online fee |
| `dealer_rating_bonus_enabled` | Rating bonus on dealer commission |
| `paid_support_services_enabled` | Paid Support services page for shops |
| `shop_onboarding_wizard_enabled` | The new shop onboarding wizard |

On staging, `dealer_programme_enabled` is on for Karnataka (whole state) and Pune; the other dealer
flags are on for Pune. Production values could not be read from here: production database reads
are not allowed to this session. They were off at release and change only through
Admin → Feature flags.

## E. Branches deleted (owner, 29 Oct)

| Branch | Last commit (to restore: `git push origin <sha>:refs/heads/<branch>`) |
|---|---|
| `release/2026-10-29-waived-fee` | `6475bdde5defa8847e1899c8a6ce18d23b65f735`. Its change was already on production (`f2756b6`) |
| `claude/festive-ride-udspyl` | `d83c91fa7ffc8497111f3a7ada0f3f2ce5adb9e0`. "Driving Simulator" placeholder page (25 Oct) |
