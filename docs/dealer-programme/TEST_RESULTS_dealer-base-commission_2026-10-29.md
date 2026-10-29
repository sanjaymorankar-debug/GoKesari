# Test results — Dealer commission: base %, moved by rating, per dealer

- Date: 29 Oct 2026
- Branch: `claude/dealer-base-commission` (from `origin/staging` 47b3cfd), commit f62c75d
- PR: https://github.com/sanjaymorankar-debug/GoKesari/pull/280 (into `staging`)
- Database: local PostgreSQL 18.6 (throwaway), all migrations incl. 0116

## Owner decisions (29 Oct 2026)

- An admin sets the base commission as a % of the registration fee paid (before GST, after any coupon).
- The whole base % is earned when the shop is approved.
- Only the % counts; the fixed ₹ amounts per milestone are dropped.
- Each rating point above 5.0 adds 1 percentage point (configurable), and each point below 5.0 takes one off. The commission never goes below 0%.
- The base % and the step can be set for each dealer.

## New tests — tests/integration/dealer-base-commission.test.ts

| Case | Result |
|---|---|
| 40% of ₹1,000 fee = ₹400, all at approval; nothing at fee payment or verification; no fixed amounts | Pass |
| Rating 6.0 → 41% (₹410); rating 4.0 → 39% (₹390), rating part −1% | Pass |
| Admin's new default 25% and step 2 points: rating 6.5 → 28%; with the rating flag off → base 25% only | Pass |
| Never below 0%: a 1% base at rating 4.0 with a 2-point step records nothing | Pass |
| Per-shop cap still applies: ₹999 earned, the rest waits for an admin override | Pass |
| One dealer's own 25% and 0.5 points → 25.5%; another dealer keeps the default; clearing returns to the default | Pass |
| Only an admin sets a dealer's rates (operator gets 403); a reason is required and the change is audited; out-of-range values are refused | Pass |
| Default settings are changed by an admin only; 200% is refused | Pass |
| Rating card shows the signed rating part (4.5 → −0.5%); the dealer's rate view | Pass |
| The amount splits into the base part and the rating part | Pass |

## Existing tests

- `dealer-step5-commission` and `dealer-all-india` now select the milestone rules model in their setup. 27/27 pass.
- **Full suite:** 2,947 passed.
- **Still failing:** the 3 spreadsheet-import tests that also fail on unchanged `staging`.
- **Timeouts under load:** `db-split` and `split-migrate` timed out during the full run, then passed 13/13 when run alone.
- **Typecheck and lint:** clean.

## Manual check (375 px, local dev server)

- **Commission settings:** the Settings tab opens with base 40% and step 1. The worked example updates as the admin types (30% → ₹299.70 / ₹309.69 / ₹289.71 at ratings 5.0 / 6.0 / 4.0). Saving shows "Settings saved." and is stored.
- **Dealer page:** the "Commission for this dealer" card shows the defaults as placeholders. Typing 25% and 0.5 shows "At rating 6.0: 25.5%". Saving shows "Saved. It applies to commission earned from now on."
- **Audit log:** both changes are recorded with their reasons.

## Not verified

- The dealer's own portal view in a browser (the rate view is covered by the API test).
- test.gokesari.com after deploy. The dealer programme flag is off there.

## Check before switching the programme on

The cap per shop is ₹999. With the turnover slabs, 40% of ₹4,999 or ₹9,999 goes over it, and the part above waits for an admin override.
