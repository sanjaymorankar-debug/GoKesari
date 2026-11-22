# Phase 3 — Accounting: Accountant (maker) → CA (checker)

Built 22-Nov-2026 (IST). Flag: `rbac_v2_accounting` (OFF). Screen: **/staff/accounting** (tabs: Journals, To approve, Periods, Rates, Trial balance).

## What it does

| Feature | Rule | Where |
|---|---|---|
| Journal entries | Accountant drafts (balanced: debits = credits, ≥ 2 lines, each line debit **or** credit) → submits → CA approves (the engine posts it) or rejects with a comment. Nobody approves their own entry. | `src/server/rbac-accounting/journals.ts`, `fin_journal_entries`, `fin_journal_lines` |
| High-value entries | Total ≥ rule `rbacV2.highValueJournalPaise` (default ₹50,000): a CA **and then** an admin (not the same person). The threshold is an admin rule; with `rbac_v2_four_eye_admin` on, changing it needs a second admin. | type `JOURNAL_ENTRY_HIGH_VALUE` (`CA_THEN_ADMIN`) |
| Finalised entries | A POSTED entry is never edited or deleted — the **database** refuses (trigger `fin_journal_entries_guard`; lines: `fin_journal_lines_guard`). A correction is a reversing entry (lines swapped), approved like any entry; the original becomes REVERSED. | `createReversal` |
| Periods | Months (YYYY-MM). The CA closes (refused while entries await approval) and reopens (reason required). Nothing is drafted, submitted or posted into a CLOSED month (re-checked at posting). | `fin_periods`, `closePeriod`, `reopenPeriod` |
| Trial balance | Posted + reversed entries by account; CSV download. | `trialBalance`, `GET /api/staff/accounting/trial-balance?format=csv` |
| Rate changes | Accountant proposes (commission DEFAULT/SHOP_TYPE/SHOP, registration fee, delivery charge) with effective date → CA approves → Admin activates. Activation calls the **existing** setter (`setCommissionRate`, `setRegistrationFee` — which schedules future dates itself —, rule `shopWallet`), so rate logic is unchanged (stop gate 4). Future commission / delivery-charge changes are SCHEDULED and activated by the hourly `rbac-v2` job. Rates are untouched until then. | `src/server/rbac-accounting/rates.ts`, `rate_change_proposals` |
| Four-eye on configuration | With `rbac_v2_four_eye_admin` on: business rules (`/api/admin/settings`), commission rates (`/api/finance/commission-rates`) and the registration fee (`/api/registration-fees`) changed by one admin wait for a second. | `src/server/approvals/admin-actions.ts` |

The existing direct admin edits of rates stay (an additive path; making the proposal path the only one would remove an existing admin capability — stop gate 3, owner's decision).

## Not in this phase (recorded follow-ups)

- **Bank-statement reconciliation** (upload a bank statement, match lines to payments / settlements). The existing `runReconciliation` checks payments ↔ orders ↔ settlements; matching a bank file is a separate piece of work.
- **Franchise fee and platform fee** as proposal kinds: the franchise fee lives in versioned `franchise_config_versions` with its own monthly-effective rule; no "platform fee" field exists. Both can be added as rate kinds calling their setters.
- GST / TDS registers for the Accountant: today the CA's existing pages (`/admin/statutory`, `/admin/tds-commission`) and finance views (FINANCE_VIEW, now held by the Accountant and CA) serve them.

## API

| Method | Path | Who |
|---|---|---|
| GET / POST | `/api/staff/accounting/journals` | list: Accountant, CA · create draft: Accountant |
| GET / PUT | `/api/staff/accounting/journals/{id}` | read: Accountant, CA · edit draft/rejected: the preparer |
| POST | `/api/staff/accounting/journals/{id}/submit` · `/withdraw` · `/reverse` | the preparer (reverse: any Accountant) |
| GET | `/api/staff/accounting/periods` | Accountant, CA |
| POST | `/api/staff/accounting/periods/{YYYY-MM}` `{action: CLOSE\|REOPEN, reason}` | CA |
| GET / POST | `/api/staff/accounting/rates` | list: Accountant, CA, Admin · propose: Accountant |
| POST | `/api/staff/accounting/rates/{id}/cancel` | the proposer |
| GET | `/api/staff/accounting/trial-balance?from&to&format` | Accountant, CA |
| POST | `/api/approvals/{id}/decide` | CA (stage 1), Admin (stage 2 / activation) |
