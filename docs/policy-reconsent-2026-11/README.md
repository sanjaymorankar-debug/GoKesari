# Policy re-consent (open-features CONSENT, 24-Nov-2026)

Before this change GoKesari recorded the policy version a user accepted at
sign-up (`user_consents`, one global `CURRENT_POLICY_VERSION`) but never asked
again when a policy changed. Now an admin publishes versions per document and
signed-in users accept the new version before going on.

**Switched off by default:** feature flag `policy_reconsent_enabled`
(Admin → Settings → Feature flags, "Ask signed-in users to accept a new policy
version"). With it off nobody is asked; the admin report still works.

## How it works

| Piece | Where |
|---|---|
| Versions per document (`terms`, `privacy-policy`, `seller-terms`) | table `policy_versions` (migration 0200), seeded with 2026-10-24 as a baseline that asks nobody |
| Acceptances (version, time, channel, IP, user agent), append-only | table `policy_acceptances` + audit `policy.accepted` |
| Service | `src/server/services/policy-versions.ts` |
| Re-consent page (blocking dialog over every page except `/legal/*`, `/signin`, `/profile/delete`) | `src/components/policy-reconsent-gate.tsx`, rendered by `src/app/layout.tsx` |
| Signed-in API (site and app) | `GET/POST /api/me/policy-consent` → `{ enabled, needsReconsent, pending[] }` |
| Admin report and publishing | `/admin/policy-versions` (Settings hub → More), `GET/POST /api/admin/policy-versions` |
| Wording in English, Hindi, Marathi | `src/lib/policy-reconsent.ts`; the change summary is entered per version in all three (Hindi / Marathi fall back to English) |

- **Required version:** the newest published version of a document with
  "users must accept" ticked. A minor edit (unticked) is recorded and asks
  nobody.
- **Who is asked:** Terms and Privacy — every signed-in user; Seller Terms —
  users who own a shop. A sign-up made after a Terms / Privacy version was
  published counts as accepting it (its `TERMS_AND_PRIVACY` consent row).
  Shop registration (`/api/shop-registrations`, which has the seller-terms
  checkbox) records the seller-terms acceptance.
- **Portals:** the dialog is in the root layout, so it covers the customer
  site, the shop (`/shop`), rider (`/delivery-partner`) and dealer (`/dealer`,
  `/franchise`) portals and the app's WebView. The channel recorded is
  `WEB`, `SHOP_PORTAL`, `RIDER_PORTAL`, `DEALER_PORTAL` or `APP` (app user
  agent); `API` for a non-browser call without a page.
- **Stale page:** if an admin publishes a newer version while the dialog is
  open, accepting answers 409 and the page reloads with the new version.
- **Declining:** the dialog offers "sign out"; there is no way past it without
  accepting. The account-deletion page (`/profile/delete`, when
  `account_self_deletion_enabled` is on) stays open, so someone who will not
  accept can still delete their account.
- Only an `ADMIN` publishes (audited `policy_version.published`, reason
  required, versions only move forward, never edited). The report needs
  `consent:view` (operators and admins) and identifies nobody.

## Turning it on (owner)

1. Change the policy text on the `/legal/...` page and release it.
2. Admin → Policy versions → publish the version (date as on the page), the
   change summary (English; Hindi / Marathi if available), "users must
   accept" ticked, and a reason.
3. Switch on the flag. Users are asked on their next page load.

The legal pages' "Last updated" date still comes from `CURRENT_POLICY_VERSION`
in `src/lib/legal-docs.ts`; keep it equal to the version published.

## Not covered / follow-ups

- Account deletion (#518, now on staging) does not remove `policy_acceptances` rows
  (no foreign key). Keeping them as evidence or deleting them is that PR's
  retention call.
- The onboarding wizard does not show a seller-terms checkbox, so it does not
  record a seller-terms acceptance; a wizard shop owner is asked once after a
  seller-terms version needing acceptance is published.
- The mobile app is a WebView shell: it shows the same dialog. The JSON API
  is there if a native screen is ever added.

Tests: `tests/integration/policy-reconsent.test.ts`,
`tests/unit/policy-reconsent.test.ts`, QA `TC-RECONSENT-001..003`
(`tests/qa/guest|signed-in/policy-reconsent.spec.ts`).
