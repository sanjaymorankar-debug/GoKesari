# Referral moves — add / move a referral code (owner, 21/22-Nov-2026)

> **Status (24-Nov-2026):** live on gokesari.com since 22-Nov-2026 (release #473, migration 0162).

Admin → Dealers → **Referral moves** (`/admin/dealers/referral-moves`). Code: `src/server/dealers/referral-moves.ts`,
API `src/app/api/admin/referral-moves/`, migration `drizzle/0162_referral_moves.sql` (rollback `scripts/rollback-0162.sql`).

## What an admin can do

| Request | What happens on approval |
|---|---|
| **Shops** — add a referral code to shops that have none, or move shops (up to 50) to another dealer / franchise team | Each shop gets the chosen team member's code (or the dealer's own code) and is attributed to that team from the moment of approval |
| **Team member** — move an agent or team lead to another dealer / franchise team (reporting to the dealer, or under one of its team leads) | He gets a place in the new team (old place ends, payee details carry over), **keeps his own referral code**, and the shops he registered move with him |

The old direct "move to another dealer" action (`POST /api/admin/dealers/:id/salespeople/:spId/transfer`) now refuses
and points here, so no move happens without the documents and a second admin.

## Documents and approval (maker-checker)

- One admin raises the request with a written reason (at least 10 characters).
- Signed consent letters are uploaded (PDF, JPEG, PNG or WebP, up to 5 MB, stored encrypted):
  - Shops: the **shop owner** of every shop, the **old dealer / franchise owner** (when a shop had one), the **new** one.
  - Team member: the **person**, the **old dealer**, the **new dealer**.
- A **different admin** approves (only when every letter is in) or rejects, with a note. The requester can cancel his own
  request; nobody decides his own request (also a database check).
- Everything is in the audit log: `referral_move.requested`, `referral_move.document`, `referral_move.decided`, and
  `dealer.attribution_changed` per shop.

## Money: old stays, new from the move

- Commission **already earned** stays with whoever earned it (ledger entries are never changed).
- From the approval the **new team** earns: one-time commission not earned yet (a shop not activated yet; with the
  current settings everything is earned at activation), renewal commission, and **recurring franchise commission** on
  orders delivered from the move.
- Recurring is split exactly at the move: the old franchise attachment is kept as a closed period
  (`franchise_shop_team_periods`) and the shop attaches to the new dealer's franchise in its zone from that moment
  (`franchise_shop_attributions.attached_from`). If the new team holds no franchise in that zone, the shop earns from
  then on like any free-team shop in the zone.
