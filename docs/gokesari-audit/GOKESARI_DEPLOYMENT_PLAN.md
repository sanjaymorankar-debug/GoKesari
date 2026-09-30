# GoKesari — Deployment Plan

*No deployment action was taken by this audit. This documents the environment as configured (per prior session notes — not re-verified live beyond the read-only probe in §2) and the ladder every future change should follow, per [DEPLOYMENT.md](../../DEPLOYMENT.md) (already in the repo) plus this audit's findings.*

## 1. Environments

| Environment | Branch | Domain | Database | Notes |
|---|---|---|---|---|
| Local | any | `localhost:3000` | Local Postgres or a personal Neon branch | This audit ran exclusively here, against a disposable cluster (`127.0.0.1:54329`) |
| CI | any PR/push to `main`/`staging` | n/a | Ephemeral Postgres 16 service container | Runs migrate → typecheck → lint → test → build |
| Test/staging | `staging` | `test.gokesari.com` | Neon (`pmd` schema applied, catalogue populated with promoted pilot data) | Hostinger Node app, auto-deploy on push |
| Live/production | `main` | `gokesari.com` | Neon (no `pmd` schema; empty/unused catalogue, per prior session notes) | Hostinger Node app, auto-deploy on push |

**The single most important operational fact about this setup:** merging to `main` deploys **live** automatically. There is no separate manual-approval gate on the hosting side — the merge itself *is* the approval gate, per `DEPLOYMENT.md`'s own description ("Promotion is a merge of staging into main, which is also the human approval gate"). Never merge a test-only or unfinished change into `main`.

## 2. What this audit verified about the live environment (read-only)

A single read-only HTTP probe of `GET /api/auth/providers` on both hosts, to confirm the dev-only credentials sign-in provider is correctly absent from production:

```
https://test.gokesari.com/api/auth/providers → 200, {"google": {...}}
https://gokesari.com/api/auth/providers       → 200, {"google": {...}}
```

Both hosts respond and expose only the Google provider — correct. Nothing else was probed, and no write of any kind was made to either host or to any hosted database.

## 3. Deployment ladder (already the project's stated policy — restated here as the plan every roadmap phase follows)

```
LOCAL → TEST (this audit's local cluster, or a personal branch)
      → CI (automatic on push/PR)
      → STAGING (test.gokesari.com, via the `staging` branch)
      → SMOKE TEST (manually exercise the changed flow on staging)
      → APPROVAL (explicit go-ahead from the user)
      → PRODUCTION (merge staging → main)
```

Nothing skips a rung. In particular: **no P0 fix, however small, goes straight to `main`** — even a one-line defect fix (e.g., DEF-01's restock call) goes through staging and a smoke test first, because the golden rule ("do not break existing working functionality") applies to the fix itself, not just to new features.

## 4. Branch hygiene (a finding from this audit, low-risk, worth doing early)

The checked-out branch (`feature/pmd-review-decide`) is byte-identical to `origin/staging` — it is not a distinct line of work, just a stale local branch. `origin/main` is exactly one merge (promoting staging to main) behind `origin/staging`. Six other feature branches on `origin` are already merged into `staging` and can be deleted. **Recommendation:** start the next phase of work from a fresh branch off `origin/staging`, and delete the stale merged branches, before Phase 4 implementation begins — this is pure hygiene, zero functional risk, and prevents future confusion about which branch is current.

## 5. Rollout plan for this audit's own findings (§ once approved)

1. **SEC-01 (Next.js patch)** — highest priority, but still goes through the full ladder: branch → local test/build/typecheck/lint → staging → smoke-test the app still boots and core flows work → approval → main. A dependency bump is low-risk in principle but touches every request the app serves, so it gets the same discipline as any other change, not an exception.
2. **P0 defect fixes (DEF-01, DEF-03, DEF-04, DEF-06)** — each as its own small, reviewable commit/PR with a regression test proving the old (wrong) behaviour and the new (correct) one, per the project's own commit-message convention (`fix: ...`, `test: ...`).
3. **SEC-02 (KYC encryption)** — needs a backup immediately before the migration, on both staging and (later) live, per the database change plan §2.
4. **Everything else** — follows the phase order in [GOKESARI_IMPLEMENTATION_ROADMAP.md](./GOKESARI_IMPLEMENTATION_ROADMAP.md), each phase independently shippable through this same ladder.

## 6. Monitoring (already documented in DEPLOYMENT.md §8 — restated as what to watch through this work)

| Signal | Why it matters here specifically |
|---|---|
| Daily cron ran, `errors` empty | Unverified by this audit (§ Test Plan §5) — confirm before relying on subscriptions working at all |
| 5xx rate on `/api/checkout`, `/api/wallet/*`, and (once fixed) `/api/orders/[id]/assign` | Money and fulfilment paths — exactly where the P0 findings live |
| `subscription_orders` with `WALLET_INSUFFICIENT` | Unchanged by this audit, still worth watching |
| Wallet-vs-ledger drift query (`DEPLOYMENT.md` §7) | Run this immediately after deploying the DEF-01 restock fix, to confirm nothing about the wallet path was disturbed by an unrelated change |
| Shops stuck in `PENDING_APPROVAL` | Unchanged |

## 7. Rollback

Unchanged from `DEPLOYMENT.md` §9: redeploying the previous commit is always safe because every schema change in this plan is additive (§ Database Change Plan). A rollback that requires restoring from backup puts the app in maintenance mode first, because restoring over a live wallet system loses real transactions — this is non-negotiable and applies equally to every phase of this roadmap.

## 8. Pre-phase checklist (add to `DEPLOYMENT.md`'s existing pre-launch checklist, don't replace it)

Before any phase of this roadmap reaches staging:
- [ ] Baseline suite (628 tests) still green, plus the new phase's own tests
- [ ] `npm run typecheck` and `npx eslint src tests` clean
- [ ] `npm run build` succeeds
- [ ] A fresh `pg_dump` of the target database exists if the phase includes a migration
- [ ] The regression matrix's protecting tests for every `EXISTING_WORKING`/`EXISTING_PARTIAL` feature the phase touches still pass
- [ ] Smoke-tested on staging by a human, not just by CI
- [ ] Explicit go-ahead recorded before merging to `main`
