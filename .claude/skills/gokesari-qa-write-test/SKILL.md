---
name: gokesari-qa-write-test
description: Automate a GoKesari test case or scenario as a Playwright UI or API check in tests/qa (qa()/manual(), tiers, world data, flows helpers), including UI automation by role and label on desktop and phone. Use when a feature is added or changed, when a case is "Not run" or "Not automated" in the register, or when asked to automate test cases.
---

# Automate a GoKesari test case

## 0. The case first

* Find or add the case in `test-cases.xlsx` (new features get new rows in
  their module — keep the columns, the Status drop-down and the Run summary
  working: `python3 scripts/qa/plan_workbook.py` shows how), then
  `npx tsx scripts/qa/export-cases.ts` so `tests/qa/catalog/cases.json` has it.
* Read its **Steps** and **Expected result** — the check must assert the
  expected result, not merely "no error".

## 1. Where it goes

| The case… | Tier | File |
|---|---|---|
| only reads public pages, or sends requests the server must refuse | `guest` | `tests/qa/guest/<area>.spec.ts` |
| signs in test accounts, uses their own data, writes test data | `signed` | `tests/qa/signed-in/<area>-*.spec.ts` |
| needs `db()`, AUTH_SECRET, the mail catcher, a rule change, a suspension, ageing data, new sign-ups | `local` | `tests/qa/local/<area>-*.spec.ts` |
| is an end-to-end journey (SC-xx) | as its steps need | `tests/qa/scenarios/SC-*.spec.ts` |

Prefer `signed` over `local` when the API allows it: signed checks also run on
test.gokesari.com.

## 2. The check

```ts
import { as, pageAs } from "../lib/actors";
import { placeOrder, packOrder, deliver, sellable, walletBalance } from "../lib/flows";
import { call, expectStatus, stash, unstash, RUN } from "../lib/http";
import { blocked, expect, manual, need, qa } from "../lib/record";
import { world } from "../lib/world";

qa("TC-XXX-001", "what the check proves, in the case's words", async ({ page, browser }) => {
  const { context, page: shopPage } = await pageAs(browser, "shop");   // UI as a role
  try {
    await shopPage.goto("/shop/orders");
    await shopPage.getByRole("button", { name: "Accept" }).first().click();
    await expect(shopPage.getByText(/accepted/i)).toBeVisible();
  } finally {
    await context.close();
  }
  return "short note of what was seen";
}, { tier: "signed", mobile: true, partial: "what of the Expected result is not covered" });

manual("TC-XXX-002", "SMS code to a real handset", "needs an SMS provider in test mode and a handset");
```

* **UI**: locate by role, label or test id (`getByRole`, `getByLabel`,
  `getByTestId`) — never by CSS classes or text positions. Wait on state
  (`expect(...).toBeVisible()`), not on time. `{ mobile: true }` repeats it at
  Pixel 7 size; check there is no sideways scroll on phone layouts.
* **API**: `call(await as("customer"), "POST", "/api/…", body)` returns
  `{ status, body, text }` and never throws on a status; `expectStatus(res, 201, "what")`.
* **Data**: `world()` (accounts, shops A/B/C, listings, society — see
  `tests/qa/lib/world.ts`); missing pieces → `need(world().shops.B, "a second shop")`
  so the case is **blocked** where they do not exist (e.g. staging), not failed.
* **Sharing between checks** of one file: `stash(key, value)` / `unstash(key)`
  (on disk; a failure restarts the worker). Names unique per run with `RUN`.
* **Writes**: helpers in `flows.ts` refuse production (`assertWritable`);
  restore any rule you change in a `finally`.
* **IDs**: an ID may be covered by several checks — all must pass; one check
  may prove several closely related IDs.

## 3. Prove it

```bash
source test-results/qa/local-3000.env   # skill gokesari-qa-run §2
npx playwright test -c playwright.qa.config.ts tests/qa/<file> --project=desktop --reporter=line
npx tsc -p tsconfig.qa.json && npx eslint tests/qa
```

A failing check is either a wrong test (fix it) or a real defect (leave it
failing and log it — skill `gokesari-qa-report`). Never loosen an assertion
to make it pass.
