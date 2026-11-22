# Conflict Register: pending owner feedback

**Run:** Delta development run, prompt dated 22-Nov-2026, 22.54 IST
**Register produced:** 22-Nov-2026, 23.01 IST (all times IST)
**Baseline:** origin/staging `c34ef9e8` (22-Nov 22.50), origin/main `bd927331` (22-Nov 19.12)
**Companion report:** [MASTER_PROMPT_STATUS_2026-11-22.md](MASTER_PROMPT_STATUS_2026-11-22.md)

None of the features below was developed. No branch, code, stub, migration, flag
or test was created for any of them. Fill in the three owner columns (**Owner
Decision**, **Owner Feedback**, **Target Release**). Each feature is built only in a
later run, and only as you approve it.

> **The master prompt was not received.** The delta prompt names it as attachment
> (1), but only the gap-analysis workbook (attachment 2) is in the repository.
> The master prompt's scope was rebuilt from the RBAC v2 brief as recorded in
> `docs/rbac/01-assessment.md` (brief received 22-Nov 21.56) and from the gap
> workbook. Where a feature's exact wording (for example SEC-06) could not be
> checked, it is held here as a **C3** conflict.

## Summary table

| ID | Feature | Types | Risk | Effort (dev-days) | Recommended | Mobile |
|---|---|---|---|---|---|---|
| CF-001 | SEC-06 fix and residual SEC-/DEF- items | C1, C3 | High | 1–2 | B, after the SEC-06 text is supplied | No |
| CF-002 | Remap legacy OPERATOR users to Operations/Support roles | C5, C2, C4 | High | 2 | C (defer until RBAC v2 is live) | No |
| CF-003 | Phase 4 order-state additions | C1, C4 | High | 3–5 | C until D8 states are decided | Yes |
| CF-004 | Phase 9 RECONCILED / CHARGEBACK payment states | C1, C4 | High | 3 | A (shadow ledger), then B | No |
| CF-005 | In-app turn-by-turn rider navigation | C1, C4 | Medium | 5–8 | C (keep the Maps link) | Yes |
| CF-006 | Society: riders ask to join a society | C1, C4 | Medium | 2–3 | B after product decision | Yes |
| CF-007 | Onboarding WP6: referral help by PIN code | C1 | Medium | 2 | B | Yes |
| CF-008 | Onboarding WP7: assisted mode | C1, C2, C6 | Medium | 3 | C (overlaps RBAC Phase 6 customer assists) | Yes |
| CF-009 | Onboarding WP8 + GAP-015: Hindi/Marathi inner pages | C1, C4 | Medium | 5+ | B after reviewers are named | Yes |
| CF-010 | Onboarding WP10: scan-first + DigiLocker | C1, C4 | High | 5 | C (needs a DigiLocker partner) | Yes |
| CF-011 | D-144: shop logo file upload | C1 | Low | 1 | B | Yes |
| CF-012 | Shop Product Setup validation changes | C1, C4 | Medium | 1–2 | C (08-Nov rules are live) | No |
| CF-013 | Guest shopping (24 of 37) and Guest/Smart overlap removal | C6, C2, C4 | High | 10+ | C until PR #482/#484 settle on prod | Yes |
| CF-014 | Own-VPS housekeeping: remove unused env vars and Neon references | C1 | Medium | 0.5 | B (owner-run checklist) | No |
| CF-015 | R2/R3 defects: phone UI, D-130, D-138, D-141, D-136 | C1, C2 | Medium | 4–6 | B through the R2/R3 release plan | Yes |
| CF-016 | Tile board NEW-046: rider board, Favourites, Theme, Call rider; 15 themes | C1, C2, C4 | Low | 3 | C (decision #34 open; `menus.ts` in flight) | Yes |

---

## CF-001: SEC-06 fix and residual SEC-/DEF- remediation

| Field | Content |
|---|---|
| Feature ID / Name | SEC-06 and any open SEC-0x / DEF-0x item |
| Master Prompt Part | Roadmap Phase 1b (security and defects) |
| Conflict Type | C1, C3 |
| Conflicting Item | Gap workbook sheet 2, row 1b, marks SEC-01..07 and DEF-01..09 DONE. The master prompt (not received) lists a SEC-06 fix. Residual owner items: DB password rotation (Blockers #33) and deleting copy-shops SQL files (#39). |
| Current Behaviour | Phase 1b fixes are on main (PLT-004, NEW-006, NEW-014, NEW-018, NEW-026, RBAC-003). |
| Required Behaviour | A SEC-06 fix whose text this run could not read. |
| Why Not Built | Any security fix edits existing code (C1). The trackers say done while the master prompt says open (C3). |
| Additive Portion | A read-only regression test that proves the SEC-06 behaviour, once its definition is known. |
| Option A | Add the regression test only. If it fails, the fix itself becomes Option B. |
| Option B | Patch the affected file(s). Impact and rollback depend on the item; revert the PR to roll back. |
| Option C | Close it as done per the tracker. |
| Recommended Option | A first. Send the SEC-06 text so it can be checked against the code. |
| Risk | High |
| Estimated Effort | 1–2 |
| Dependent Features Held | None |
| Mobile Impact | No |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-002: Remap legacy OPERATOR users to Operations / Support roles

| Field | Content |
|---|---|
| Feature ID / Name | OPERATOR → OPERATIONS_* / SUPPORT_* mapping |
| Master Prompt Part | Part 3 (roles), seven-role model |
| Conflict Type | C5, C2, C4 |
| Conflicting Item | `docs/rbac/01-assessment.md` §2 and Q3 ("No automatic move; OPERATOR stays"); PR #485 adds the new roles. |
| Current Behaviour | OPERATOR is a broad staff role. PR #485 (open) adds the five new roles and leaves OPERATOR unchanged. |
| Required Behaviour | Existing operator accounts move to the new roles. |
| Why Not Built | It changes existing users' roles and permissions (C5), depends on roles that are not yet merged (C2), and is an open owner question (C4). |
| Additive Portion | A read-only report listing each OPERATOR account and the role it would map to. |
| Option A | An admin grants the new roles as extra roles through `user_role_grants`. Nothing is taken away. |
| Option B | A migration script that swaps roles. Affects every operator login. Roll back by restoring the old role from the audit log. |
| Option C | Defer until RBAC v2 is live and used. |
| Recommended Option | C, then A: no user loses access before the new roles are proven. |
| Risk | High |
| Estimated Effort | 2 |
| Dependent Features Held | None |
| Mobile Impact | No (WebView) |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-003: Phase 4 order-state additions

| Field | Content |
|---|---|
| Feature ID / Name | Order-engine extension: new order states (SM-001 family) |
| Master Prompt Part | Roadmap Phase 4 |
| Conflict Type | C1, C4 |
| Conflicting Item | Order state machine (`src/server/services/orders*`); the D8 payment/order-states decision; flags `parentOrders.enabled`, `cancellation.customerMayCancelUntil` and `fulfilmentOptions.enabled` are OFF on production. |
| Current Behaviour | Split order, master order and the cancel rule are built and switched OFF on production. |
| Required Behaviour | More order states. |
| Why Not Built | It changes the existing state machine and depends on an open owner decision (D8). |
| Additive Portion | None that is safe; states are read by every order screen. |
| Option A | None. |
| Option B | Add the states with an additive enum migration and change the transitions. Touches checkout, the shop, rider and admin order screens, and the mobile app. High regression risk; roll back with the flag plus a revert. |
| Option C | Defer until D8 is decided and the built-but-off flags are switched on. |
| Recommended Option | C: switch on what is already built first. |
| Risk | High |
| Estimated Effort | 3–5 |
| Dependent Features Held | CF-004 (in part) |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-004: Phase 9 RECONCILED / CHARGEBACK payment states

| Field | Content |
|---|---|
| Feature ID / Name | SM-005 payment states RECONCILED, CHARGEBACK |
| Master Prompt Part | Roadmap Phase 9 |
| Conflict Type | C1, C4 |
| Conflicting Item | Payment state machine, Cashfree webhook handler, settlement model decision (D8). Gap sheet 2 row 9; sheet 6 item 8. |
| Current Behaviour | Payments end at PAID / FAILED / REFUNDED. Cashfree was set as the production gateway on 19-Nov; live tests are pending. |
| Required Behaviour | Payments move to RECONCILED after the settlement match, and to CHARGEBACK on a dispute. |
| Why Not Built | It changes the payment state machine and the webhook handling, and the settlement model is an owner decision. |
| Additive Portion | A separate `payment_reconciliation` ledger table, filled from Cashfree settlement reports, that leaves the payment state alone. |
| Option A | Shadow ledger only (new table plus an admin report). No change to existing states. |
| Option B | Add the enum values and the transitions in the webhook. Payment flows are affected; roll back by reverting (the enum values stay, inert). |
| Option C | Defer until the Cashfree live tests pass. |
| Recommended Option | A after the Cashfree live tests: it gives reconciliation without touching live payments. |
| Risk | High |
| Estimated Effort | 3 |
| Dependent Features Held | None |
| Mobile Impact | No |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-005: In-app turn-by-turn rider navigation

| Field | Content |
|---|---|
| Feature ID / Name | GS-072 / GAP-002 turn-by-turn navigation |
| Master Prompt Part | Roadmap Phase 7 |
| Conflict Type | C1, C4 |
| Conflicting Item | Rider job screen (Google Maps deep link); flag `routing.enabled` OFF; gap sheet 6 item 7 ("Product decision"). |
| Current Behaviour | The rider taps through to Google Maps. |
| Required Behaviour | Turn-by-turn navigation inside the app. |
| Why Not Built | It replaces the rider job screen's navigation and needs a product decision plus a Maps SDK key and billing. |
| Additive Portion | None without a key. |
| Option A | Keep the deep link and switch on `routing.enabled` for route preview. |
| Option B | Embed a navigation SDK in `mobile/`. Native module, app store release, Maps billing. |
| Option C | Defer. |
| Recommended Option | C, with A if route preview is wanted now. |
| Risk | Medium |
| Estimated Effort | 5–8 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-006: Society: riders ask to join a society

| Field | Content |
|---|---|
| Feature ID / Name | Phase 8 society rider membership request |
| Master Prompt Part | Roadmap Phase 8 |
| Conflict Type | C1, C4 |
| Conflicting Item | Society worker authorization (GS-040/044/045), society admin screens; gap sheet 6 item 6 ("Product decision"). |
| Current Behaviour | Only the society admin adds riders. |
| Required Behaviour | A rider can ask to join, and the society admin approves. |
| Why Not Built | It changes how society membership is granted (permissions) and needs a product decision. |
| Additive Portion | A new `society_join_requests` table, a rider "Ask to join" page and an approval list for the society admin. |
| Option A | Build exactly that additive portion behind a new flag. Approval calls the existing "add worker" service. |
| Option B | Change the existing worker-authorization flow. |
| Option C | Defer. |
| Recommended Option | A, once you confirm riders may ask. |
| Risk | Medium |
| Estimated Effort | 2–3 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | Approve A (owner, 22-Nov-2026 ≈23.05 IST) |
| **Owner Feedback** | Not built: a new C2 conflict was found (its migration collides with RBAC v2 migrations 0170–0175 in flight). Options A1/A2/A3 in DELTA_BUILD_2026-11-22.md |
| **Target Release** | Owner to choose A1 (after RBAC migrations land) or A2 |

## CF-007: Onboarding WP6: referral help by PIN code

| Field | Content |
|---|---|
| Feature ID / Name | WP6 |
| Master Prompt Part | Onboarding Phase 2, Wave 2 |
| Conflict Type | C1 |
| Conflicting Item | Identity-first wizard (live on prod since 08-Nov), referral step. |
| Current Behaviour | The shop owner types a referral code or skips the step. |
| Required Behaviour | Show nearby dealers/agents by PIN code to help pick a referrer. |
| Why Not Built | It changes the live wizard's referral step. |
| Additive Portion | A read-only "Find a dealer near PIN" API and page. |
| Option A | Standalone page linked from help text (one added line in the wizard). |
| Option B | Built into the referral step. |
| Option C | Defer. |
| Recommended Option | B. The wizard is the point of use, and the change is small. |
| Risk | Medium |
| Estimated Effort | 2 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-008: Onboarding WP7: assisted mode

| Field | Content |
|---|---|
| Feature ID / Name | WP7 |
| Master Prompt Part | Onboarding Phase 2, Wave 2; Part 3 Operations User |
| Conflict Type | C1, C2, C6 |
| Conflicting Item | RBAC v2 Phase 6, `feature/rbac-v2-operations` (`src/server/rbac-operations/assists.ts`, commits until 22-Nov 22.57); the OPERATOR_LIMITED owner-consent onboarding. |
| Current Behaviour | OPERATOR_LIMITED onboards shops with the owner's consent. |
| Required Behaviour | Staff fill in the wizard for the shop owner. |
| Why Not Built | It overlaps work in flight (Phase 6 customer assists) and the existing operator-limited flow. |
| Additive Portion | Decide after Phase 6 merges. |
| Option A | Use the Phase 6 assist flow as WP7. |
| Option B | A separate WP7 mode in the wizard. |
| Option C | Drop WP7 as covered by Phase 6. |
| Recommended Option | A or C after Phase 6 is staging-verified. |
| Risk | Medium |
| Estimated Effort | 3 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-009: Onboarding WP8 and GAP-015: Hindi/Marathi inner pages

| Field | Content |
|---|---|
| Feature ID / Name | WP8, GAP-015 |
| Master Prompt Part | Onboarding Phase 2; Roadmap Phase 10 |
| Conflict Type | C1, C4 |
| Conflicting Item | Every form, table and policy page (English strings in place); owner to name HI/MR reviewers. |
| Current Behaviour | Boards, header, menus and the first onboarding screen are translated. |
| Required Behaviour | All inner pages in Hindi and Marathi. |
| Why Not Built | It edits strings in existing files across the app, and needs reviewers. |
| Additive Portion | New message catalogue files. |
| Option A | Catalogue files only, wired page by page later. |
| Option B | Replace strings page by page with `t()` calls. Many files; visual regression risk. |
| Option C | Defer (owner deferred it to Phase 2). |
| Recommended Option | B in small batches, once reviewers are named. |
| Risk | Medium |
| Estimated Effort | 5+ |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-010: Onboarding WP10: scan-first and DigiLocker

| Field | Content |
|---|---|
| Feature ID / Name | WP10 |
| Master Prompt Part | Onboarding Phase 2, Wave 3 |
| Conflict Type | C1, C4 |
| Conflicting Item | Identity-first wizard document step; KYC provider decision (Sandbox.co.in, 09-Nov). |
| Current Behaviour | GST/PAN is typed in and verified online. |
| Required Behaviour | Scan the document first, or fetch it from DigiLocker. |
| Why Not Built | It changes the wizard's first step and needs a DigiLocker partner or OCR vendor. |
| Additive Portion | None without the vendor. |
| Option A | None. |
| Option B | Add a scan option to step 1 with OCR. Vendor key needed. |
| Option C | Defer. |
| Recommended Option | C until a vendor is chosen. |
| Risk | High |
| Estimated Effort | 5 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-011: D-144: shop logo file upload

| Field | Content |
|---|---|
| Feature ID / Name | D-144 |
| Master Prompt Part | Onboarding Phase 2 |
| Conflict Type | C1 |
| Conflicting Item | Wizard shop-details step; shop profile form. |
| Current Behaviour | Logo by URL or none. |
| Required Behaviour | Upload a logo file. |
| Why Not Built | It edits the existing wizard and profile form. |
| Additive Portion | Upload API using the existing upload service. |
| Option A | Upload on the shop profile page only, after onboarding. |
| Option B | Upload in the wizard too. |
| Option C | Defer. |
| Recommended Option | B. A small change with low risk. |
| Risk | Low |
| Estimated Effort | 1 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | Approve A (owner, 22-Nov-2026 ≈23.05 IST) |
| **Owner Feedback** | Built as COMPLETED: flag `shop_logo_upload_enabled` OFF; see docs/delta/DELTA_BUILD_2026-11-22.md |
| **Target Release** | Staging queue; production with the flag OFF in a 23.00 window |

## CF-012: Shop Product Setup validation changes

| Field | Content |
|---|---|
| Feature ID / Name | Shop Product Setup validation |
| Master Prompt Part | New scope (shop product set-up) |
| Conflict Type | C1, C4 |
| Conflicting Item | Owner decision 08-Nov (Name/Category/MRP/Stock mandatory; Selling > MRP rejects the row), live on prod. |
| Current Behaviour | The 08-Nov rules apply to upload and manual entry. |
| Required Behaviour | Further validation changes (not specified in what was received). |
| Why Not Built | It changes live validation and an owner decision. |
| Additive Portion | None. |
| Option A | None. |
| Option B | Change the validators; affects every product upload. |
| Option C | Keep the 08-Nov rules. |
| Recommended Option | C unless you name the new rule. |
| Risk | Medium |
| Estimated Effort | 1–2 |
| Dependent Features Held | None |
| Mobile Impact | No |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-013: Guest shopping and the Guest/Smart overlap

| Field | Content |
|---|---|
| Feature ID / Name | Guest shopping (24 of 37 not started), voice, WhatsApp shopping; duplicate removal |
| Master Prompt Part | New scope |
| Conflict Type | C6, C2, C4 |
| Conflicting Item | PR #482 (smart list, in the 23.00 release path), `fix/482-guest-access-2026-11-22` (staging queue running 22-Nov 22.50); owner decisions D-02/D-03; Vocestry (no public API). |
| Current Behaviour | The smart list (photo/WhatsApp) is on staging with flags off; guests are sent to sign-in. |
| Required Behaviour | Guest session and checkout; one shopping flow without duplicates. |
| Why Not Built | It overlaps work in flight and existing flows, and depends on open decisions. |
| Additive Portion | Recount after #482 is on production. |
| Option A | Extend the smart list for guests behind a new flag. |
| Option B | A separate guest flow. Duplicates smart-list parts. |
| Option C | Defer until #482 is live and D-02/D-03 are answered. |
| Recommended Option | C, then A. |
| Risk | High |
| Estimated Effort | 10+ |
| Dependent Features Held | Voice shopping, WhatsApp shopping |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-014: Own-VPS housekeeping

| Field | Content |
|---|---|
| Feature ID / Name | O.1/O.2: remove unused Hostinger/GitHub env vars and Neon references |
| Master Prompt Part | Own-VPS hosting |
| Conflict Type | C1 |
| Conflicting Item | Environment files, GitHub secrets, CI workflows. |
| Current Behaviour | Unused variables remain; the site runs on the VPS. |
| Required Behaviour | Remove them. |
| Why Not Built | It deletes existing env and CI config (not allowed in this run). |
| Additive Portion | A checklist of each variable and where it is read. |
| Option A | The checklist only; the owner deletes. |
| Option B | Remove them in a PR, then redeploy staging and production. |
| Option C | Leave them. |
| Recommended Option | A, then B on staging first. |
| Risk | Medium |
| Estimated Effort | 0.5 |
| Dependent Features Held | None |
| Mobile Impact | No |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-015: R2/R3 defects (phone UI, D-130, D-138, D-141, D-136)

| Field | Content |
|---|---|
| Feature ID / Name | R2/R3 defect releases |
| Master Prompt Part | Open items and release plan (20-Nov) |
| Conflict Type | C1, C2 |
| Conflicting Item | `GOKESARI_OPEN_ITEMS_AND_RELEASE_PLAN_2026-11-20.xlsx`: R2 in staging, R3 not started. |
| Current Behaviour | Defects open as logged. |
| Required Behaviour | Fixed. |
| Why Not Built | Defect fixes change existing code, and R2 is in flight. |
| Additive Portion | None. |
| Option A | None. |
| Option B | Fix through the R2/R3 plan. Each fix goes through the staging queue. |
| Option C | Defer. |
| Recommended Option | B: these are user-visible defects. |
| Risk | Medium |
| Estimated Effort | 4–6 |
| Dependent Features Held | None |
| Mobile Impact | Yes (phone UI) |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |

## CF-016: Tile board NEW-046 (rider board, Favourites, Theme, Call rider; 15 themes)

| Field | Content |
|---|---|
| Feature ID / Name | NEW-046 |
| Master Prompt Part | Platform |
| Conflict Type | C1, C2, C4 |
| Conflicting Item | `src/lib/board/menus.ts` (changed by PR #485 and both RBAC branches); owner decision #34. |
| Current Behaviour | Tile boards per role. |
| Required Behaviour | A rider board, Favourites, themes and Call rider. |
| Why Not Built | Open decision; the same file is in flight. |
| Additive Portion | None until #485 merges. |
| Option A | A new rider board file plus one menu entry after #485. |
| Option B | Rework `menus.ts`. |
| Option C | Defer. |
| Recommended Option | C until decision #34 is answered. |
| Risk | Low |
| Estimated Effort | 3 |
| Dependent Features Held | None |
| Mobile Impact | Yes |
| **Owner Decision** | |
| **Owner Feedback** | |
| **Target Release** | |
