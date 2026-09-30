# GoKesari — Test Plan

*Governs testing for every phase in [GOKESARI_IMPLEMENTATION_ROADMAP.md](./GOKESARI_IMPLEMENTATION_ROADMAP.md). Baseline results are in [GOKESARI_BASELINE_TEST_REPORT.xlsx](./GOKESARI_BASELINE_TEST_REPORT.xlsx); per-feature protection is tracked in [GOKESARI_REGRESSION_MATRIX.xlsx](./GOKESARI_REGRESSION_MATRIX.xlsx).*

## 1. What already exists (keep using it)

- **Unit tests** (`tests/unit/`, 9 files) — pure logic: money math, Excel cell parsing, the Product Master normalize/match/quality/taxonomy/sources modules, schedule resolution, webhook signatures, generated-doc drift.
- **Integration tests** (`tests/integration/`, 33 files, 628 assertions total) — run against **real PostgreSQL**, not mocks, because the guarantees that matter here (row locking, unique constraints, CHECK constraints, transaction isolation) cannot be proven against a mock. This is a deliberate, already-proven-out project convention — keep it for every new financial or concurrency-sensitive feature.
- **E2E** (`tests/e2e/acceptance.spec.ts`, Playwright, desktop + mobile) — one acceptance scenario, not run in this audit (no browser installed here) and not part of CI.
- **CI** (`.github/workflows/ci.yml`) — migrate → typecheck → lint → unit+integration tests → build, on every push/PR to `main`/`staging`, against a real Postgres 16 service container.

Test database discipline (already established, keep following it): `TEST_DATABASE_URL` must point at a database that can be safely `TRUNCATE`d — never Neon staging with real data, never live. This audit ran everything against a disposable local cluster for exactly that reason.

## 2. Gaps in the existing test pyramid

From the reachability and coverage scan (regression matrix):

| Layer | Gap |
|---|---|
| Route-level (HTTP) | Only the 13 Product Master routes are tested at the HTTP layer. The other 82 routes (checkout, orders, wallet, cart, subscriptions, delivery, shops, admin) are exercised only through their underlying service functions — a route-level bug (wrong permission check, wrong status code, a parsing mistake) would not be caught by the current suite. |
| Service-only, zero callers | 76 exported service functions have no route or UI reaching them at all (tracked individually in the feature inventory as `EXISTING_PLACEHOLDER`). |
| E2E | One scenario, not in CI, not run in this audit. |
| Security-specific | No dedicated auth-bypass/IDOR test sweep beyond what `authorization.test.ts` already covers (28 tests) — good coverage of the permission matrix itself, but not of every individual route's own guard call. |
| Browser rendering | Nothing in the suite renders a page and inspects the DOM; component tests render the React tree in isolation (per the Product Master pilot report), not through a real browser. |

## 3. Test requirements for every new or changed feature (per the brief's own list)

For each unit of work in the roadmap:

1. **Unit tests** — new pure logic (scoring functions, state-machine transitions, validators).
2. **API/route tests** — auth (rejects wrong role), ownership (rejects wrong shop/user), validation (rejects bad input with the right error code), success path, and the actual HTTP status code — not just the service function underneath.
3. **Integration tests** — anything touching the database, run against real Postgres, per the existing convention. Anything involving money or concurrency gets an explicit concurrent-access test (the wallet suite is the template: N simultaneous operations, assert the exact final state).
4. **RBAC tests** — every new permission gets at least one test proving each role that should NOT have it, doesn't (negative RBAC, not just positive).
5. **Negative tests** — invalid input, missing required field, wrong content type, oversized payload, malformed IDs.
6. **Security tests** — IDOR (can user A touch user B's row via a crafted ID?), the specific finding being fixed (e.g., DEF-06 needs a test proving `CONFIRMED` is no longer reachable without payment).
7. **Regression tests** — before modifying an `EXISTING_WORKING`/`EXISTING_PARTIAL` feature per the regression matrix, confirm its existing protecting suite still passes; if its "Protection level" column says "None," add characterization tests **first**, as their own commit, before the behaviour change.
8. **E2E** — extend `acceptance.spec.ts` for any new critical path (see §4); keep it running on both desktop and mobile viewports as it already does.

## 4. Critical end-to-end scenarios to build toward

Per the brief's §30/§31, adapted to what exists and what's missing. Each row's "Today" column is what the *existing* suite already proves; new phases add to it, they don't replace it.

| Scenario | Today | Add when |
|---|---|---|
| Customer → search → shop → cart → wallet checkout → shop advances → delivery assigned → accepted → picked up → delivered | Proven at service level (`checkout`, `order-cancel-refund`, `delivery-assignment` suites); Playwright spec exists but unrun | Route-level tests now (P0); full Playwright run in CI once a browser is provisioned |
| Subscription: create → daily engine → delivery | Proven, including 5 concurrent cron runs producing exactly one order | Extend once a delivery slot exists |
| Society worker authorization | None (module doesn't exist) | With the Society phase — model tests on `authorization.test.ts`'s IDOR pattern |
| Product price comparison | None (view doesn't exist) | With the comparison-query phase |
| Marketing campaign with consent/opt-out | Consent-record tests exist; campaign tests don't | With the marketing phase — consent/suppression tests **before** any send-capability test |
| Refund | Cancel→refund proven; return/replacement request doesn't exist | With the returns phase |
| Cancellation | Proven, but currently proves the **wrong** behaviour for stock (DEF-01) | Fix DEF-01 with a red-then-green test first |
| Failed payment | Proven for wallet top-up | Extend once direct order payment (D1) exists |
| Shop rejection | None (no accept/reject step exists) | With the order-state extension (D8) |
| Gig rejection | Proven for the reject path itself | Extend for re-offer/expiry once DEF-03/04 are fixed |
| No gig available | Proven (throws the documented error) | Extend for escalation once that exists |
| Multiple shops in one order | Proven (independent per-shop orders, one wallet debit each) | Extend once a master order exists |

## 5. What must happen before Phase 4 (implementation) begins

1. **Install Playwright's browser and run `npm run test:e2e` once**, to get a real baseline for the one existing E2E scenario (this audit could not — no browser was installed in this environment, and installing one is a download outside a read-only discovery pass).
2. **Confirm the daily-order cron is actually scheduled and firing on test and live** (`GET /api/cron/daily-orders` health probe, or ask the user directly) — this cannot be seen from the repository alone, and its silent failure is explicitly the most damaging outage this system can have per the deployment doc's own words.
3. **Add route-level tests for the money and fulfilment paths** (checkout, order status, wallet top-up/verify, delivery assignment) before modifying any of them — they are the P0 defects' blast radius.
4. **.gitattributes** pinning `docs/**/*.md` (at least the Product Master generated docs) to `eol=lf`, so the two CRLF-only failures stop appearing on Windows checkouts and CI/Windows stay in agreement.

## 6. Environment and safety rules for all future test runs

- Local integration/unit tests: local disposable Postgres only (`scripts/pmd/local-pg.ps1`), or a dedicated Neon test branch — **never** the Neon database also used for staging data, since the suite truncates tables.
- Never run `npm run db:migrate` with the ambient `.env` loaded without overriding `DATABASE_URL` — it points at Neon.
- Mock payment/geocoding/GST-PAN-provider credentials in test env, exactly as `tests/setup.ts` already does — never let a test suite make a real external call.
- CI already provisions Postgres 16 per run; keep using it as the source of truth when local Postgres isn't available, and align CI's Node version with the hosts' (see the low-priority gap in the gap analysis).
