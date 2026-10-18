# Decision log — GoKesari build & integrate batch (18 Oct 2026)

Every assumption made during the batch, so the owner can overrule any of them.
Ground rule applied throughout: **additive only** — new tables, new rules
(feature flags) and provider interfaces; existing behaviour stays the default.

Format: **ID — decision.** *Why.* (Where.)

## Run and process

- **D-001 — The batch was built in the `GoKesari` repository** (gokesari.com /
  test.gokesari.com), not in `bkesari`. *`bkesari/README.md` records that the
  two brands are deliberately separate since 8 Oct.* (repo attached to the session)
- **D-002 — Work branches from `staging`** (identical tree to `main` at the
  start) and goes `feature → staging (test.gokesari.com) → main (gokesari.com)`.
  *The repo's documented promotion path (DEPLOYMENT.md §3).*
- **D-003 — Six parallel workstreams (A–F) on reserved migration slots
  0079–0084 and marked sections in the shared registries.** *Lets each area be
  built and tested in isolation and merged cleanly.* (scaffolding commit)
- **D-004 — Every new configurable value is a rule in `src/server/config/rules.ts`**
  (admin-editable at Admin → Settings, audited), never a constant. *Ground rule 5;
  the existing mechanism already gives admin editing, validation and audit.*
- **D-005 — New provider-backed features default to OFF** (rule flag `enabled:
  false` or provider = sandbox/mock). Production stays OFF until the owner's keys
  exist; staging can switch them on through `docs/batch-2026-10/test-settings.sql`.
- **D-006 — Payment contract defined before the build:** `PaymentGateway`
  (`src/server/payments/gateway/types.ts`) and payment intents
  (`src/server/payments/intents.ts`) with state machine
  `CREATED → PENDING → AUTHORIZED → CAPTURED → PARTIALLY_REFUNDED → REFUNDED`,
  plus `FAILED`, `EXPIRED`. *Refunds (F6.2.3) and the registration fee
  (F8.4.2) depend on it.*

## F14.2.1 — empty `PROD_DATABASE_URL` (PLT-009)

- **D-010 — Diagnosis from the run logs, not assumed.** Run #7 (13 Oct): the
  secret was empty. Run #8 (15 Oct): the secret was visible (masked `***`), but
  `vars.PROD_DATABASE_HOST` / `vars.PROD_DATABASE_NAME` were empty. Meanwhile
  "Database split" — whose job declares `environment: production` — saw every
  production secret (runs #19, #20 succeeded). Conclusion: checklist item (a) —
  the values are kept on the **production environment**, and `prod-db.yml`'s job
  had no `environment:`. Items (b)–(g) checked and ruled out (see
  `scripts/prod-db/preflight.sh` header).
- **D-011 — Fix: the job declares `environment: production`** (repository-level
  values remain visible; environment values override them) and a new
  **preflight** step reports which required secrets/variables are visible
  (`set` / `EMPTY`, never the value) with the checklist, failing fast before the
  guard. The guard's host/database checks are unchanged.
- **D-012 — The production migration itself runs after the release reaches
  `main`** ("Production database" → `migrate`, confirm `MIGRATE PRODUCTION`),
  because the workflow only runs from `main` by design.

## F14.2.4 — seller / customer split (PLT-015)

- **D-015 — Split secrets are visible to Actions** (production environment;
  run #19 PASS: 190 tables, 486/486 rows, checksums equal, no broken links).
- **D-016 — The cut-over (`DB_SPLIT_MODE=split` on gokesari.com) was NOT done.**
  *README §5 phases 2 (replication) and 3 (moving service areas) are separate
  releases; switching now would let the seller copy go stale. It is an
  irreversible production change in a Hostinger setting this environment can't
  reach.* Runbook: `docs/db-split-2026-10/CUTOVER_2026-10-18.md`.

## Statutory rates (looked up 18 Oct 2026 — CA must confirm before production)

- **D-020 — GST TCS (s.52 CGST Act): 0.5%** of net taxable supplies
  (CGST 0.25% + SGST/UTGST 0.25%, or IGST 0.5%), Notification 15/2024-Central
  Tax dated 10 Jul 2024 (was 1% under Notification 52/2018).
  Source: https://gstcouncil.gov.in/sites/default/files/2024-09/central-tax-15-2024-11072024.pdf
- **D-021 — Income-tax TDS on e-commerce participants (old s.194-O): 0.1%** of
  gross sales from 1 Oct 2024 (Finance (No. 2) Act 2024; was 1%); 5% without
  PAN/Aadhaar; individual/HUF participants ≤ ₹5 lakh a year with PAN/Aadhaar
  exempt. From 1 Apr 2026 the Income-tax Act, 2025 consolidates TDS in
  **s.393** (194-O maps to s.393(1)). Secondary sources only
  (e.g. https://taxguru.in/income-tax/section-194-o-amendment-lower-tds-rate-e-commerce-payments.html ,
  https://blog.tdsman.com/2026/07/tds-on-e-commerce-transactions-section-3931-194o/);
  the label is configurable.
- **D-022 — GST on restaurant services through an ECO (s.9(5)): 5%** paid by
  the ECO — disabled until food-service shops are onboarded.
- **D-023 — Local delivery services through an ECO by unregistered suppliers
  (s.9(5)) at 18% from 22 Sep 2025** (Notifications 15/2025 and 17/2025-Central
  Tax (Rate)) — added as a dated setting, **disabled**, CA to confirm whether
  GoKesari's delivery model falls under it.
  Source: https://www.ey.com/en_in/technical/alerts-hub/2025/09/cbic-issues-notifications-giving-effect-to-the-recommendations-made
- **D-024 — All statutory rows are seeded with `confirmedByCa = false`**, shown
  prominently in Admin.

## Consumer protection

- **D-030 — Help-desk SLAs: acknowledge within 48 hours, resolve within one
  month** — Consumer Protection (E-Commerce) Rules, 2020, Rule 4 (grievance
  officer; acknowledgement within 48 hours; redressal within one month of
  receipt). Configurable. Secondary-source check:
  https://mondaq.com/india/dodd-frank-consumer-protection-act/985606/the-consumer-protection-e-commerce-rules-2020 —
  counsel to confirm against the gazette text.

## Testing

- **D-040 — Integration tests run on a local PostgreSQL 16** (one database per
  workstream), the same engine CI uses. Each new case is named
  `TC-B26-<WS>-NNN` and counted in the test report.
- **D-041 — Authenticated browser flows on test.gokesari.com were not run by
  the agent.** Signing in needs the email code from the owner's mailbox; the
  session's safety policy declined reading it to sign in as the owner's test
  accounts. The public / read-only remote suite ran instead; the signed-in
  journeys are listed as BLOCKED in the report with the exact steps to run them.

<!-- Workstream decisions (A–F) are appended below. -->
