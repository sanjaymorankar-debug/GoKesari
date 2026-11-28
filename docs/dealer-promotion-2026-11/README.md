# Dealer and super dealer promotion (owner, 28-Nov-2026 ~20.00 IST)

Owner: "creating a dealer or a super dealer should be an admin action or a request from a shop owner"; an operator
or an administrator approves; a free dealer requests, a paid dealer picks a territory and pays; the admin can search
a shop or dealer and promote him; and an on / off switch for moving shops between referral codes.

Migration **0233** (`dealers.wants_super_at`, `wants_super_by`). Rollback: `scripts/rollback-0233-dealer-super-wish.sql`.
Tests: `tests/integration/dealer-promotion-admin.test.ts`.

## What a shop owner does

| Want | Where | Who decides |
|---|---|---|
| Free dealer | `/franchise/start` → Free dealer (existing) | An **admin or operator** approves, a **different** admin / operator confirms (four-eye, existing rule of 28-Nov) → GKD code |
| Paid franchise | `/franchise/start` → Paid franchise → pick zone(s), plan, pay (existing) | Nobody: live with the GKF code on payment |
| Super dealer | Tick **"I also want to become a super dealer"** on `/franchise/start`, or **Request to become a super dealer** on the dealer page `/dealer` | **One admin or operator** approves or rejects (never the requester). Asked before he is a dealer: kept and raised as a request once the dealer is approved |

## What an admin / operator does — Admin → Dealers → **Promote** (`/admin/dealers/promote`)

- Search by shop name, owner name (shop or account), mobile, e-mail, shop ID, dealer name or dealer code.
- **Make dealer** (a live shop's owner): the dealer row is made from the shop (verified mobile, PAN, GSTIN, address,
  bank); the person who clicks is the first approver, a different admin / operator confirms. Option **Also make super
  dealer**: when an admin asked, he becomes super dealer with the approval; when an operator asked, a super dealer
  request follows for another admin / operator.
- **Make super dealer** (an approved dealer): an admin at once; an operator raises a request another admin / operator
  approves. Waiting requests are listed at the top with Approve / Reject.
- The reason is typed on the page (the old browser pop-up on the dealer page is gone).
- Add dealer (manual form) stays for dealers with no GoKesari shop.

Operators can now approve (first or second person) or reject a **shop owner's** dealer request on the dealer page.
Everything else (applicants without a live shop, suspend, terminate) stays admin-only.

## Referral moves switch — rule `referralMoves` (Admin → Business rules)

| Field | Default | Effect |
|---|---|---|
| `enabled` | true | false: no new move request, and no waiting one can be approved (rejecting / cancelling still works) |
| `requireConsents` | true | false: the signed consent letters are optional; a different admin still approves |

## Defaults — "DEFAULT – confirm with Sanjay"

1. A super dealer request is decided by **one** admin or operator (the requester is the second person).
2. A dealer in another super dealer's team cannot request; an admin takes him out of the team first.
3. Super dealer starts at the rule's default rates (3% fees / 2% order commission); own rates on the dealer page.
4. An operator's "Make super dealer" is a request, not immediate.
5. Shop-owner notices for a new free request now go to admins **and operators**.

Also fixed: the referral-move shop search matched every shop with a phone number for a name search with no digits.
