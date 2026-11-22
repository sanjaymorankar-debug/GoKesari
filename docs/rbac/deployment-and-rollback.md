# RBAC v2 — deployment and rollback

All times IST. Follows CLAUDE.md: staging through the staging queue, production one release at a time in the
23.00 IST window, post-deploy check after every production deploy.

## Release units

| PR | Branch | Content | Migrations |
|---|---|---|---|
| #485 | `feature/rbac-unified-roles` | Phase 1 assessment, Phase 2 foundation | 0170 |
| (next) | `feature/rbac-v2-phases-3-7` | Phases 3, 4, 5, 7, documents, staff teams | 0171, 0172, 0173 |
| (other session) | `feature/rbac-v2-operations` | Phase 6 Operations | 0175 (number agreed) |

Order: #485 → staging-verified → label the Phases 3–7 PR → staging-verified → Phase 6 PR. Production: each in its own
23.00 IST window, never two in one window, after `scripts/release/post-deploy-check.sh https://gokesari.com` passes for
the previous one.

## Every flag ships OFF

`rbac_v2_staff_roles`, `rbac_v2_four_eye_admin`, `rbac_v2_accounting`, `rbac_v2_support`,
`rbac_v2_shop_change_requests`, `rbac_v2_operations` — seeded OFF by 0170 on both sites. With all of them off the
site behaves as before, except: refused permission checks are audit-logged (`authz.denied`), the five new roles can be
assigned by an admin, Admin → Approvals and Admin → Staff teams exist (empty).

## Switching on (owner decides; each switch is logged with a reason)

1. **test.gokesari.com first**: assign test accounts the new roles (Admin → Users → privileges), put them in teams
   (Admin → Staff teams), switch the area's flag on, run the testing report's cases.
2. A flag can be limited to roles (`feature_flags.role_scope`, `setFeatureFlagRoleScope`) for a pilot.
3. `rbac_v2_four_eye_admin` is **stop gate G1**: on means no admin acts alone. Needs the owner's explicit go-ahead
   and at least two active admins (else the Super Admin `SUPER_ADMIN_EMAIL`, default ceo@agtci.com, approves alone,
   each approval e-mailed). `SUPER_ADMIN_EMAIL` can be set per site.
4. gokesari.com: same order, with designated test accounts only (no real customer or financial data changed).

## Rollback (first line → last)

1. **Flag off** (Admin → Feature flags). Takes effect on the next request in that process, every process within the
   cache time. No redeploy. With four-eye on, switching a flag off needs a second admin (or the Super Admin alone in
   bootstrap).
2. **Revert the PR** (staging, then main in a release window). New tables are left unused.
3. **Drop the data** (only if required, export first): `scripts/rollback-0173.sql`, `rollback-0172.sql`,
   `rollback-0171.sql`, `rollback-0170.sql`, newest first. The five `user_role` enum values cannot be dropped in
   PostgreSQL; move any account holding one back to its previous role first, then they are inert.

Nothing in these migrations alters or rewrites an existing column or row (0172 adds nullable columns and a CHECK on
the new `sub_status` column only).

## Mobile (Phase 8)

The Android and iOS apps are one WebView of the website, so every page above is in both apps as soon as the website
is deployed. Only Android's app-link list needed `/staff` (`mobile/app.config.ts`); it takes effect with the next APK
build (`.github/workflows/mobile-apk.yml` builds both variants on PRs touching `mobile/**`; the PR's APK checks passed).
iOS opens every path already (apple-app-site-association `*`). `/shop/changes` and `/admin/...` were already covered.
Push notifications for change requests use the existing push channel (rule `push`).
