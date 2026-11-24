# GoKesari's books (migration 0188, flag `auto_journals`)

When the flag is on, every payout that is paid queues a balanced **posting** in GoKesari's chart of accounts. The Accountant opens **Accounting → Auto postings** and does one of two things with each posting:
- **Create journal draft:** the Accountant becomes the preparer and submits it to the CA as with any journal entry.
- **Dismiss:** with a reason, for example when it was booked by hand.

Nothing posts by itself.

| Paid | Debit | Credit |
|---|---|---|
| Shop payout item (payout cycle) | 2100 Payable to shops (total) | 4100 commission · 2330 GST on fees · 2310 TCS · 2320 TDS 194-O · 2340 s.9(5) GST · 2150 wallet top-up · 1100 bank (net) |
| Weekly shop settlement | 2100 (net + commission) | 4100 commission · 1100 bank |
| Rider weekly payout / bank transfer | 2110 Payable to delivery partners (gross) | 2321 TDS 194C · 4200 fee · 1100 bank |
| Dealer / team commission | 5300 commission expense | 2323 TDS on commission · 1100 bank |
| Referral commission | 5200 referral expense | 2322 TDS 194H · 1100 bank |

## Chart of accounts

The codes are in `src/server/rbac-accounting/auto-post.ts` (`GK_ACCOUNTS`). A posting is queued only if it balances, and only once per payment (`fin_auto_postings` has one row per source).

## Statutory liabilities

The same tab shows, for a month:
- what posted journals credited to the TCS, TDS (by section) and GST accounts;
- what is still waiting as postings.

These are the figures for the challans (record them under Admin → TDS on commission → challans, any section) and the returns (GSTR-8 export, 26Q).

## Switch-on

Switch on `rbac_v2_accounting` (already on on staging) and then `auto_journals`.

Rollback: `scripts/rollback-0188.sql`.
