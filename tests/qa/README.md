# GoKesari QA suite — the 791-case plan, automated

Every case of `test-cases.xlsx` ("Test cases" and "E2E scenarios") is either
automated here as a Playwright UI / API check tagged with its TC or SC ID, or
declared with the reason it cannot be (`manual()`), so the master register
(`docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx`) shows a status for every
case on every site.

```
tests/qa/
  catalog/      cases.json, scenarios.json — the plan, exported by scripts/qa/export-cases.ts
  worlds/       staging.json — the staging test accounts and shop (no secrets)
  lib/          target, record (qa/manual), http, actors, world, flows, db, mail, routes
  guest/        production-safe checks (run on gokesari.com too)
  signed-in/    signed-in checks (test.gokesari.com and the local server)
  local/        checks that need the local server's database or secret
  scenarios/    the 35 end-to-end journeys (SC-01 … SC-35)
```

## Where each check runs — the tier

| Tier | Runs on | What it may do |
|---|---|---|
| `guest` (default) | local, staging, **production** | GET public pages; send requests the server must refuse. Nothing that signs in, writes, pays or sends a message. |
| `signed` | local, staging | Sign in a test account and write **test data** (orders on the test shop, sandbox payments). Never changes `/admin/settings`, never suspends a real shop or user. |
| `local` | local only | Needs the local database (`db()`) or `AUTH_SECRET`: arranging data a person would arrange, reading audit rows, changing business rules, suspending, time-based cases, codes from the local mail catcher. |

`tierRefusal()` enforces it: on gokesari.com every non-guest case is recorded
`skipped` ("not run on production …"), and every writing helper calls
`assertWritable()` again.

## Writing a check

```ts
import { qa, manual, blocked, need, expect } from "../lib/record";

qa(["TC-CART-009"], "wallet checkout: one CONFIRMED order, wallet debited by the total", async ({ page }) => {
  …
  return "what was seen";            // kept as the result's detail
}, { tier: "signed", mobile: true, partial: "what of the Expected result is NOT covered" });

manual("TC-AUTH-046", "SMS sign-up code", "needs an SMS provider in test mode and a real handset");
```

* **IDs**: the case IDs from `catalog/cases.json`. One check may prove several
  cases; one case may be proven by several checks (all must pass).
* **Assert the Expected result**, not just "no error". When a check proves only
  part of it, say what is missing in `partial` — the register shows
  "Pass (partial)".
* **Blocked, not failed**, when a precondition is missing on this site
  (`blocked("no rider online")`, `need(world().shops.B, "a second shop")`).
* A **fail** must be a real difference from the Expected result. Fix the test
  when the test is wrong; leave a real defect failing and log it in
  `docs/testing/qa-defects.json`.
* **Order inside a file**: checks run in file order, one worker. Hand data on
  with `stash()` / `unstash()` (kept on disk — a failed test restarts the worker).
* **UI first** where the case says UI: drive the page by role and label
  (`getByRole`, `getByLabel`, `getByTestId`). Use the API for setup and for
  the API half of a case. `{ mobile: true }` also runs it at Pixel 7 size.
* Helpers: `as(role)` (API context), `pageAs(browser, role)`, `me(role)`,
  `world()`, `flows.ts` (cart, checkout, fulfilment, delivery), `db()` (local only),
  `waitForCode(email, since)` (local mail catcher).

## Running

```bash
# Local: database, mail catcher, server, seed (see scripts/qa/local-up.sh)
bash scripts/qa/local-up.sh            # prints the env to source
npx playwright test -c playwright.qa.config.ts

# Staging: sign the test accounts in first (emailed codes), then run
npx tsx scripts/qa/signin-staging.ts
E2E_BASE_URL=https://test.gokesari.com npx playwright test -c playwright.qa.config.ts

# Production: guest tier only (the rest is recorded "skipped")
E2E_BASE_URL=https://gokesari.com npx playwright test -c playwright.qa.config.ts tests/qa/guest

# Results → docs/testing/qa-runs/, then the master register
npx tsx scripts/qa/collect.ts --label <run-name>
npx tsx scripts/qa/build-register.ts
```

The Claude QA agent (`.claude/agents/gokesari-qa.md`) and the skills under
`.claude/skills/gokesari-qa-*` run these steps end to end.
