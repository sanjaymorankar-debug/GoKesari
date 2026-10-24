---
name: gokesari-qa-run
description: Run GoKesari's automated QA suite (tests/qa — the 798-case plan as Playwright UI + API checks) against the local server, test.gokesari.com or gokesari.com, and read the results. Use when asked to test a release, run the regression, smoke-test production, or re-run failed checks.
---

# Run the GoKesari QA suite

Read `tests/qa/README.md` once for the tiers. In short: **guest** checks run
everywhere (production-safe), **signed** checks run on staging and local,
**local** checks only on a local server. The suite refuses the wrong tier by
itself and records it as `skipped`.

## 1. Pick the site

| Site | `E2E_BASE_URL` | What runs | Before you start |
|---|---|---|---|
| Local | `http://localhost:3000` | everything | §2 below |
| Staging | `https://test.gokesari.com` | guest + signed | sessions: skill `gokesari-qa-signin` |
| Production | `https://gokesari.com` | **guest only** — run `tests/qa/guest` | nothing; never sign in |

Always `export CHROMIUM_PATH=/opt/pw-browsers/chromium` in the cloud
container (the installed browser build differs from Playwright's default).

## 2. Local server (all tiers)

```bash
npx next build --webpack            # NODE_OPTIONS=--max-old-space-size=6144 if tsc runs out of memory
bash scripts/qa/local-up.sh 3000 gk_qa
source test-results/qa/local-3000.env
```

`local-up.sh` creates and migrates the database, starts the local mail
catcher (sign-in codes land in `test-results/qa/mail`) and the server, and
seeds the plan's test data (`scripts/qa/seed-local.ts` → `test-results/qa/world-localhost_3000.json`).
Re-seed for a clean world: `npx tsx scripts/qa/seed-local.ts --base-url http://localhost:3000`.

## 3. Run

```bash
rm -rf test-results/qa/<host>                          # a clean result set for this run
npx playwright test -c playwright.qa.config.ts [paths] # all specs; or e.g. tests/qa/guest
npx playwright test -c playwright.qa.config.ts -g "TC-CART-009"   # one case
```

* Both projects run: `desktop` and `mobile` (Pixel 7) — mobile only for checks marked `{ mobile: true }`.
* The test site is slow (8–10 s a cold page): a full guest run takes ~15 min there, a signed run longer. Run long runs in the background.
* Production: `E2E_BASE_URL=https://gokesari.com npx playwright test -c playwright.qa.config.ts tests/qa/guest` — nothing else.

## 4. Read the results

```bash
python3 - <<'EOF'
import json, glob, collections
rows=[json.loads(l) for f in glob.glob("test-results/qa/<host>/*.jsonl") for l in open(f)]
print(collections.Counter(r["status"] for r in rows))
for r in rows:
    if r["status"] in ("fail","blocked"): print(r["status"], r["id"], r["project"], r["detail"][:200])
EOF
```

* **fail** — the site differs from the case's Expected result. Open the
  screenshot / trace under `test-results/qa/artifacts/` (`npx playwright show-trace …`),
  decide test bug vs app defect (re-read the case in `tests/qa/catalog/cases.json`
  and the code), then fix the test or log the defect (skill `gokesari-qa-report`).
* **blocked** — a precondition is missing there (no session, no rider online,
  no stock…). The detail says what; fix the precondition and re-run that check.
* **skipped** — not run on this site by rule. Expected on production.

Then collect the run (skill `gokesari-qa-report`, step 1).

## Do not

* point any signed / local check at gokesari.com, or `db()` at a site's database;
* hammer the sites: the access sweeps already pace themselves — do not loop them;
* re-run a whole remote suite to retry one flaky check — use `-g "<TC ID>"`.
