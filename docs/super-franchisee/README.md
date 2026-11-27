# Super franchisee

Owner decisions, 27-Nov-2026. Migration `0226_super_franchisee`. Rule `superFranchisee` (Admin → Settings), **off by default**.

## What it is

A super franchisee is a dealer at the top of a team of other dealers (free or paid franchisees). GoKesari pays him
**extra**, on **his own team only**. Nothing is taken from the franchisee's own commission.

| Share | Default | On what | When |
|---|---|---|---|
| `SUPER_FEE` | 3% (`feeShareBp` 300) | every fee paid in his team: a team dealer's shop registration fee (before GST, after coupons; a waived fee earns nothing), and a team dealer's own joining or franchise fee (before GST) | when the fee is paid; reversed if it is refunded |
| `SUPER_ORDER` | 2% (`orderShareBp` 200) | GoKesari's order commission on the team's activated shops, net of refunds | at the monthly commission close, to the team at the end of the month |

Both rates are editable in the rule, and per super franchisee (empty = the rule's). 0 switches a share off.
Each fee and each shop-month pays at most once, whatever team the dealer is in.

## Who does what

Only an **admin** (Admin → Dealers → the dealer → "Super franchisee"):

- makes any approved dealer a super franchisee (any number of them), or removes one (his team is released; what he
  earned stays);
- adds an existing or new dealer to his team, or moves a dealer from another team (the old link ends at that moment);
  optionally credits fees paid in the last N days (0–365);
- takes a dealer out of a team;
- sets a super franchisee's own rates.

A dealer is in at most one team; a super franchisee cannot be in another team. Every change needs a reason and is in
the audit log (`super_franchisee.changed`, `super_franchisee.team_changed`). Operators see the card read-only.

## Data

- `super_franchisees` (dealer, status ACTIVE/REMOVED, own rates, reason, who/when).
- `super_franchisee_members` (super, member, starts_at, ends_at, reasons). One open row per dealer.
- Ledger lines in `dealer_commission_ledger` with entry types `SUPER_FEE` / `SUPER_ORDER`, paid with the dealer
  payouts like every other line. Accrual keys: `SFS:<shop>`, `SFJ:<joining payment>`, `SFB:<franchise booking>`,
  `SFO:<shop>:<YYYY-MM>`.

Code: `src/server/dealers/super-franchisee.ts`, API `src/app/api/admin/super-franchisees/route.ts`, card
`src/components/dealer/super-franchisee-admin.tsx`. Tests: `tests/integration/super-franchisee.test.ts`.
Rollback: `scripts/rollback-0226-super-franchisee.sql`.

## First use (production)

Sanjay Morankar and Deepak Wadabhat are the first two. Deepak's team: Chandrashekhar Dolke (free franchisee,
code GKD-4EHBBG, added 27-Nov-2026), Pramod Giri and more. Each needs an approved dealer account first.
