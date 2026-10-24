---
name: gokesari-qa-signin
description: Sign GoKesari's staging test accounts (customer, customer2, shop owner, rider, admin, operator, operator-limited) in on test.gokesari.com with the normal emailed sign-in code, read from the owner's Gmail, and save the sessions the signed-in QA tier uses. Use before a signed-in run on staging or when a run reports "no saved … session".
---

# Sign the staging test accounts in

The signed-in tier on test.gokesari.com uses the real staging accounts of
`tests/qa/worlds/staging.json` (plus-aliases of the owner's mailbox,
`sanjaymorankar+gk-*@gmail.com`). Nothing is forged: each account signs in
with the code GoKesari emails, exactly as a person would. Owner approval:
decision D-041 (18 Oct), renewed 24 Oct 2026. Staging only — never production.

## Steps

1. Start the tool once, detached (it keeps a session that is still signed in
   and asks codes only for the others):

   ```bash
   (CHROMIUM_PATH=/opt/pw-browsers/chromium setsid nohup npx tsx scripts/qa/signin-staging.ts --wait 600 \
      > test-results/qa/signin-staging.log 2>&1 < /dev/null &)
   until grep -q "code requested\|still signed in" test-results/qa/signin-staging.log; do sleep 3; done
   ```

   Each account it needs a code for gets `test-results/qa/codes/<role>.request`.

2. Read the codes in Gmail — **only** these messages:

   `from:support@gokesari.com to:(sanjaymorankar+gk-lc14@gmail.com OR sanjaymorankar+gk-cust@gmail.com OR sanjaymorankar+gk-shop@gmail.com OR sanjaymorankar+gk-rider@gmail.com OR sanjaymorankar+gk-admin@gmail.com OR sanjaymorankar+gk-ops@gmail.com OR sanjaymorankar+gk-oplim@gmail.com) newer_than:1h`

   The subject is "<code> is your Gokesari sign-in code". Take the newest
   message per address, sent after the `requestedAt` in its request file.

3. Write each code to `test-results/qa/codes/<role>.code` (role → address:
   customer → gk-lc14, customer2 → gk-cust, shop → gk-shop, rider → gk-rider,
   admin → gk-admin, ops → gk-ops, oplim → gk-oplim). Codes expire in 5 minutes.

4. Wait for `signin-staging: <role>: signed in → .e2e-auth/staging-<role>.json`
   for every role. On failure the log names the reason and a screenshot is in
   `test-results/qa/codes/<role>-failed.png`.

## Limits — do not lock the accounts

* one code per account every 60 s; 5 per account per hour;
* **20 code requests per hour from one IP** — one round for seven accounts uses 7;
* so run the tool once; if a round fails, wait for the hour window before the next.

## Never

* read, label, archive or delete any other mail; never send mail;
* print, commit or report a code or a session file (`.e2e-auth/` is git-ignored);
* sign in on gokesari.com.
