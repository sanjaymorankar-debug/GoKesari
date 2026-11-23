# Delta build: owner-approved conflict features (22-Nov-2026)

**Owner decision (chat, 22-Nov-2026 ≈23.05 IST):** "Approve A for CF-006 and CF-011, build them."
**Branch:** `feat/delta-society-join-logo-2026-11-22` from origin/staging `c34ef9e8`. All times IST.

| Conflict | Feature | Outcome |
|---|---|---|
| CF-011 | D-144: shop logo upload (Option A: on the shop's own pages, after onboarding) | **COMPLETED**: built, additive, flag `shop_logo_upload_enabled` OFF |
| CF-006 | Society: riders ask to join a society (Option A: new table, rider page, society-admin approval) | **BUILT 23-Nov-2026** after RBAC v2 (0170–0175) was staging-verified: migration 0176, flag `society_rider_join_requests_enabled` OFF (see "CF-006: Delta Build Register") |

## CF-006: why it was stopped

Option A needs a new table, so it needs a migration. The migration journal must
number its entries 0, 1, 2 … and give each a later timestamp
(`tests/unit/migration-journal.test.ts`). Drizzle's migrator **silently skips**
any migration older than the newest one a database has already recorded (D-99,
24-Oct). Numbers 0170–0175 are already taken by RBAC v2 work that is still in
flight:

| Migration | Where |
|---|---|
| 0170 | PR #485 (staging queue) |
| 0171–0173 | `feature/rbac-v2-phases-3-7` |
| 0175 | `feature/rbac-v2-operations` |

A CF-006 migration added now would either reuse one of those numbers, or land
on staging before them, after which their migrations would be skipped on
test.gokesari.com. This is a **C2 (ongoing work)** conflict. Following the delta
rules, no code, branch commit, migration or test was created for CF-006.

**Owner decision (chat, 22-Nov-2026 ≈23.12 IST): A1.** CF-006 is built once migrations 0170–0175 are on origin/staging.

**Options that were offered**

- **A1 (recommended):** build CF-006 as soon as the RBAC migrations (0170–0175) are on staging. It then takes the next free number. About 2–3 dev-days; no change to the RBAC work.
- **A2:** build it now as the next number after 0175 and hold the PR until the RBAC PRs merge.
- **A3:** a version with no migration (store requests in an existing table). Not recommended, because no existing table fits: `society_riders` has no PENDING state, and `society_members` is for residents.

## CF-011: Delta Build Register

| Item | Value |
|---|---|
| Flag | `shop_logo_upload_enabled`: OFF (no row is seeded; a missing row is OFF) |
| API | `POST /api/shops/[id]/logo` (multipart `file`) and `DELETE /api/shops/[id]/logo` |
| Who | The shop's owner or staff with shop access (`requireShopAccess`, as `PATCH /api/shops/[id]`) |
| Checks | Same as every upload (`saveImage`): real type from the bytes (JPEG/PNG/WebP), size and pixel limits (rule `images`); 10 uploads per 10 minutes per user |
| Write | The existing `updateShop(id, { logoUrl })`, the same writer as the settings API |
| Screen | My Shop → "Open or close the shop, hours and contact" (`/shop/manage/hours`): a "Shop logo" card, shown only while the flag is on for the shop's district |
| Audit | `IMAGE_UPLOADED` with `purpose: SHOP_LOGO` and the shop id |
| Not changed | The onboarding wizard, `PATCH /api/shops/[id]`, image serving, shop cards |

New files:

- `src/app/api/shops/[id]/logo/route.ts`
- `src/components/delta/shop-logo-upload.tsx`
- `src/lib/delta/shop-logo.ts`
- `tests/integration/delta-shop-logo-upload.test.ts`
- `docs/delta/DELTA_BUILD_2026-11-22.md`

## Wiring Register (existing files; only added lines)

| File | Added | Deleted | Why |
|---|---|---|---|
| `src/server/db/schema.ts` | 2 | 0 | Flag key in `FEATURE_FLAG_KEYS` (after `ondc_mode`, away from the RBAC v2 additions at the end of the list) |
| `src/server/services/feature-flags.ts` | 3 | 0 | Flag label and hint for Admin → Feature flags |
| `src/components/feature-flags-panel.tsx` | 1 | 0 | The panel's own copy of the key list |
| `src/app/shop/manage/[section]/page.tsx` | 8 | 0 | Import plus the card, rendered only when the flag is on |

## Zero-deletion proof

```
$ git diff --numstat origin/staging...HEAD   (existing files)
8	0	src/app/shop/manage/[section]/page.tsx
1	0	src/components/feature-flags-panel.tsx
2	0	src/server/db/schema.ts
3	0	src/server/services/feature-flags.ts
```

No migration and no rollback script: nothing in the database changes. Rollback = flag off, or revert the PR.

## Tests (local PostgreSQL 18, database `gk_delta_test`)

| Test ID | Feature | Env | Command | Result | Time (IST) |
|---|---|---|---|---|---|
| DT-11-01 | Flag OFF: upload/remove refused (404), nothing stored | Local | `vitest run tests/integration/delta-shop-logo-upload.test.ts` | Pass | 22-Nov 23.08 |
| DT-11-02 | Flag ON: owner uploads; logo set to `/api/images/<id>` | Local | same | Pass | 22-Nov 23.08 |
| DT-11-03 | Not an image: refused (422), old logo kept | Local | same | Pass | 22-Nov 23.08 |
| DT-11-04 | Another owner refused | Local | same | Pass | 22-Nov 23.08 |
| DT-11-05 | Remove logo | Local | same | Pass | 22-Nov 23.08 |
| DT-11-06 | Existing `PATCH /api/shops/[id]` still sets logoUrl | Local | same | Pass | 22-Nov 23.08 |
| DT-REG-01 | Flag order, photo listing and migration journal suites | Local | `vitest run` (4 files, 30 tests) | Pass | 22-Nov 23.09 |
| DT-REG-02 | Full regression | Local | `vitest run` (317 files, 4037 tests) | 4033 pass, 4 fail: local Postgres connection timeouts while another session's suite ran on the same server. Re-run: `qa-2026-10-24-auth-fixes` Pass; `migrate-on-build` (3) still times out locally (its child process cannot connect to this Mac's Postgres); unrelated to this change (no migration or build-script change); passes in staging CI at the base commit c34ef9e8; the PR's CI re-runs it | 22-Nov 23.09 – 23-Nov 00.50 |
| DT-TC | Typecheck and lint | Local | `npm run typecheck`, `eslint` on changed files | Pass | 22-Nov 23.05 |
| DT-STG-01 | Flags-OFF smoke on test.gokesari.com | Test | Staging queue (CI, deploy, post-deploy check, guest QA), PR #489 | Pass (staging-verified) | 23-Nov 02.38 |
| DT-STG-02a | Owner OK (chat, 23-Nov ≈08.05): flag ON on staging only | Test | admin `PUT /api/admin/feature-flags` {enabled:true, districtCodes:null} | Pass: 200, change logged (old OFF → new ON, reason given) | 23-Nov 08.12 |
| DT-STG-02b | Card shows on `/shop/manage/hours` (1280 and 375 px) | Test | Playwright, staging shop-owner session | Pass: card visible, no page errors, no sideways scroll at 375 px | 23-Nov 08.12 |
| DT-STG-02c | Owner uploads a 512×512 PNG | Test | same | Pass: 201, logo `/api/images/<id>` served 200 image/jpeg, shown after reload, "Logo saved." | 23-Nov 08.12 |
| DT-STG-02d | Remove logo (the staging shop had none, so it was left as before) | Test | same | Pass: "Logo removed." | 23-Nov 08.12 |
| DT-STG-02e | Guest upload refused | Test | `POST /api/shops/<id>/logo` with no session | Pass: 401 | 23-Nov 08.12 |
| DT-STG-03 | Look of the card | Test | screenshot | **Defect D-CF011-01** (minor): the card had no inner padding (text against the border). Fixed in the follow-up PR (`p-4`, as the contact card) | 23-Nov 08.15 |
| DT-PROD | Read-only smoke | Prod | n/a | Not Run: awaiting deployment authorization | n/a |

**Staging flag state:** `shop_logo_upload_enabled` is **ON, every district, on test.gokesari.com only** (since 23-Nov 08.12 IST, owner OK). Production: no row, OFF.

## Mobile (G.1)

The Android/iOS apps are a WebView, and `/shop` is already in the app's path
prefixes (`mobile/app.config.ts`). The new card appears in the app with no app
change, so no version or build bump is needed. Store publishing stays BLOCKED.

## Staging deployment and rollback

1. The PR goes into `staging` with `ready-for-staging`; the staging queue merges, deploys and checks it with the flag OFF.
2. After `staging-verified`: Admin → Feature flags on test.gokesari.com → `shop_logo_upload_enabled` ON (staging only), then upload a logo as the staging shop owner.
3. Rollback: switch the flag off (the card disappears and the API answers 404). Logos already uploaded stay, as `logoUrl` values. Full rollback: revert the PR; there is no database change.

## Reuse by the dealer / franchise module (owner, 23-Nov-2026 ≈09.25 IST: "integrate this with dealer module")

`ShopLogoUpload` now takes optional `endpoint`, `heading` and `hint`. Without them the shop pages are unchanged. With them, another module points the same card at its own route. The route must take a multipart `file` on POST, clear the logo on DELETE and answer `{ logoUrl }`.

Hand-over to the "GoKesari Pune PMR franchise dealer module" session (its dealer-dashboard phase, P6):

- `dealers` has no logo column. A dealer logo needs a new migration numbered after the RBAC range (0170–0175), with a rollback script.
- Copy the `/api/shops/[id]/logo` pattern into a dealer route (for example `/api/dealer/[id]/logo`) under the dealer's own guard and flag: `saveImage` → `recordAudit IMAGE_UPLOADED {purpose: "DEALER_LOGO"}` → update the column.
- Render `<ShopLogoUpload shopId={dealer.id} initialLogoUrl={dealer.logoUrl} endpoint={…} heading="Dealer logo" hint="…" />`.

| Test ID | Check | Result | Time (IST) |
|---|---|---|---|
| DT-11-07 | Card default text unchanged; custom heading/hint shown (unit, `delta-logo-upload-reuse`) | Pass | 23-Nov 09.22 |
| DT-11-01..06 | Logo API suite re-run on staging code (with RBAC 0170 migrated) | Pass | 23-Nov 09.22 |

## CF-006: Delta Build Register (23-Nov-2026)

**Owner decisions:** "Approve A" (22-Nov ≈23.05 IST), "A1" (22-Nov ≈23.12 IST), and "Go ahead with CF-006 after #487" (23-Nov ≈09.28 IST). #487 (RBAC v2 0171–0175) was staging-verified at 11.43 IST. CF-006 was then rebased on origin/staging (52d62755) and given the next free migration number, **0176**. The dealer platform PR renumbers its migrations after it, as agreed with that session.

Flag **`society_rider_join_requests_enabled`**: OFF by default (no row). Checked by the society's PIN-code district. While it is off, every new route answers 404 `FEATURE_NOT_AVAILABLE`, and the new page and links are hidden.

| Item | File | Kind |
|---|---|---|
| Table `society_join_requests` (PENDING / APPROVED / DECLINED / WITHDRAWN, one pending request per rider per society) | `drizzle/0176_society_join_requests.sql`, journal idx 176 | new |
| Rollback | `scripts/rollback-0176.sql` | new |
| Service: ask, list mine, list for society (no phone numbers), decide (society ADMIN only; approval calls the existing `addSocietyRider`), withdraw | `src/server/services/delta/society-join-requests.ts` | new |
| API: `POST/GET /api/societies/[id]/join-requests`, `PATCH /api/societies/join-requests/[requestId]`, `GET /api/societies/join-requests/mine` | `src/app/api/societies/…` | new |
| Rider page "Societies" (search, ask, withdraw) | `src/app/delivery-partner/societies/page.tsx`, `src/components/delta/society-join.tsx` | new |
| Society page: "Riders asking to join (n)" | `src/app/society/[id]/page.tsx` | +10 lines |
| Rider dashboard link (approved riders, flag on) | `src/app/delivery-partner/page.tsx` | +11 lines |
| Schema, flag key, label, panel type | `schema.ts` (+36), `feature-flags.ts` (+3), `feature-flags-panel.tsx` (+1) | added lines only |

**Zero deletions:** `git diff --numstat` over existing `src/` files shows 61 lines added and 0 deleted. Existing behaviour is unchanged: the society admin still adds a rider by mobile number (tested).

**Refusals:**
- a rider who is not approved (403);
- a society that is not verified (409);
- a rider already listed (409);
- a rider GoKesari blocked for the society (409);
- a note over 300 characters (422);
- an OPERATOR deciding (403);
- another rider withdrawing (404);
- deciding a request a second time (409).

Notifications reuse `SOCIETY_MEMBERSHIP_REQUESTED/DECIDED` and are sent after the row is saved. Audit rows use `SOCIETY_RIDER_CHANGED` with entity type `society_join_request`.

### CF-006 tests (local PostgreSQL, `gk_delta_test`, freshly migrated to 0176)

| ID | Check | Result |
|---|---|---|
| DT-006-01 | `delta-society-join-requests.test.ts`: 7 cases (flag off 404; ask, repeat and notify; approve lists the rider; decline and withdraw; refusals; OPERATOR cannot decide; existing add-by-mobile unchanged) | Pass, 23-Nov 11.50 |
| DT-006-02 | `society-rider-guard`, `society-memberships` and `migration-journal` (idx 176, later `when`) | Pass, 23-Nov 11.50 (22/22 with DT-006-01) |
| DT-006-03 | `tsc --noEmit`, eslint on the changed files | Pass, 23-Nov 11.52 |
| DT-006-04 | Full regression | 4,123 / 4,127 pass, 23-Nov 11.52–15.15. **4 failures in `migrate-on-build.test.ts`, all `CONNECT_TIMEOUT localhost:5432` / hook timeouts.** The local PostgreSQL was shared with another session's test run. A re-run at 15.20 still timed out locally (3 fail, 4 pass). This is the same local-only failure as DT-REG-02. The PR's CI runs it against a clean database and is the deciding result. |
| DT-006-05 | Staging, flag OFF: new routes answer 404, rider and society pages unchanged | Not run yet (after the staging queue merges the PR) |

**Staging and production:** the PR goes into the staging queue with `ready-for-staging`, and the flag stays OFF there unless the owner asks. On production the flag stays OFF and migration 0176 goes out with the joint logo + dealer release (production database migrate runs before the merge, DEPLOYMENT.md §4). Rollback: switch the flag off, then run `scripts/rollback-0176.sql`. Riders already approved stay on the society's rider list.
