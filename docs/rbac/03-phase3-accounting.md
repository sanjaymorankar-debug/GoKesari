# Phase 3 — Accounting: Accountant (maker) → CA (checker)

Built 22-Nov-2026 (IST). Flag: `rbac_v2_accounting` (OFF). Screen: **/staff/accounting** (tabs: Journals, To approve, Periods, Rates, Trial balance, Bank). Bank reconciliation added 23-Nov-2026 (migration 0175).

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

## Bank reconciliation (added 23-Nov-2026, migration 0175)

The Accountant imports the platform's bank statement and accounts for every line; the CA signs it off.
Service: `src/server/rbac-accounting/bank-reconciliation.ts` (file reading: `bank-statement-file.ts`).
Tables: `fin_bank_statements`, `fin_bank_statement_lines`. Approval type `BANK_RECONCILIATION` (checker CA).
Permissions: `BANK_RECON_PREPARE` (Accountant), `BANK_RECON_SIGNOFF` (CA); admins hold both.

| Step | Rule |
|---|---|
| Import | CSV or Excel as the bank exports it (≤ 10 MB, ≤ 50,000 lines). The header row is found under the account details, and its columns are recognised by name (HDFC, ICICI, SBI and similar layouts: Date / Txn Date, Narration / Particulars / Transaction Remarks, Chq./Ref.No. / UTR, Withdrawal / Deposit or Debit / Credit, or one Amount column with Dr/Cr, Balance). Dates DD/MM/YY(YY), DD-Mon-YYYY, YYYY-MM-DD and Excel dates. A statement listed newest first is put in date order. **"Check file"** reads it without saving. |
| Refusals | Any row with a problem refuses the whole file, with row numbers (a statement with missing lines cannot be reconciled). The same file twice (SHA-256). A statement whose dates overlap an existing one for the same account. An account name with a full account number (only the last 4 digits, e.g. "HDFC current ••1234"). |
| Warnings | A running balance that does not follow from the row before (a line may be missing). |
| Automatic match | A debit line is matched when exactly one unclaimed record carries a bank reference found on the line (reference cell or a token in the narration) **and** has the same amount. Records: shop payouts (`payout_items`, `shop_settlements`), rider payouts and bank transfers, dealer payouts (net of TDS), refunds to a customer's bank — each once PAID / SUCCESS — and posted journal entries. Otherwise the line gets a **suggestion**: the reference agrees but the amount differs, or exactly one unclaimed record of the same amount was recorded within 4 days. "Match again" re-runs it. |
| Money received | Credits (gateway settlements, interest, capital …) are matched to a **posted journal entry**: the Accountant records the receipt as a journal first. |
| By hand | Match to a record of the **same amount** (amount differences go through a journal entry), or **exclude** with a reason of at least 5 characters (bank charges, interest), or undo either. One record is matched to at most one bank line across every statement (DB unique index). |
| Paid, not in bank | Payouts and refunds recorded as paid within the statement's dates that no bank line is matched to — for the Accountant to chase. |
| Sign-off | Submit only when no line is unmatched and opening + credits − debits = closing (when the file has balances). The CA approves (RECONCILED) or sends it back with a comment (OPEN again). The Accountant can withdraw a submitted statement, or delete an OPEN one imported by mistake (its matches are released). |
| Final | Lines change only while their statement is OPEN; a RECONCILED statement is never changed or deleted — the database refuses (triggers `fin_bank_statements_guard`, `fin_bank_statement_lines_guard`). |

Nothing in the existing payout, refund, settlement or finance tables is written: reconciliation only reads them.
The existing `runReconciliation` (payments ↔ orders ↔ settlements, `/admin/finance`) is unchanged.

## Not in this phase (recorded follow-ups)

- **Bank feeds**: statements are uploaded by hand; fetching them from the bank automatically needs a bank API agreement.
- **Gateway settlement records**: GoKesari does not store Cashfree's settlement UTRs, so a settlement credit is matched to the Accountant's journal entry rather than automatically.
- **Franchise fee**: out of scope here (owner, 23-Nov-2026) — the franchise / dealer module is handled in its own session. No "platform fee" field exists, so there is nothing to propose for it.
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
| GET / POST | `/api/staff/accounting/bank-statements` (POST multipart `file`, `accountLabel`, `preview=1` to only check) | list: Accountant, CA · import: Accountant |
| GET / DELETE | `/api/staff/accounting/bank-statements/{id}?status&format=csv` | read: Accountant, CA · delete an open one: the importer |
| POST | `/api/staff/accounting/bank-statements/{id}/auto-match` · `/submit` · `/withdraw` | Accountant (submit / withdraw: the importer) |
| GET | `/api/staff/accounting/bank-statements/{id}/unrecorded` | Accountant, CA |
| GET / POST | `/api/staff/accounting/bank-lines/{id}?q=` · `{action: match \| accept \| exclude \| unmatch}` | candidates: Accountant, CA · actions: Accountant |
| POST | `/api/approvals/{id}/decide` | CA (stage 1), Admin (stage 2 / activation) |
