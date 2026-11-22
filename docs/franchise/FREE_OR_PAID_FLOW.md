# Franchise zones: free dealership or paid franchise (22-Nov-2026)

## The prompt (owner request, as drafted and confirmed)

> On **Book a franchise zone** (`/franchise/book`):
>
> 1. **City prefix.** Every zone name starts with its city:
>    "Pune – Koregaon Park–Mundhwa", "Mumbai – …", "Nashik – …".
>    The zone codes do not change (GKZ-PUN-17).
> 2. **Choose how to join.** When a dealer has selected zones and taps
>    **Continue**, ask: *Free dealership* or *Franchise (paid)*.
>    - **Free dealership:** no fee. He works in the zone he picked and earns the
>      one-time 20% / 4% / 3% on the shops he and his team register. There is no
>      zone ownership and no monthly share. This opens the free dealer sign-up
>      with that zone saved as his working zone. If a franchise owner later buys
>      the zone, the free dealer may join that team (Admin → Referral moves).
>    - **Franchise (paid):** he owns the zone(s). He pays the annual fee + GST
>      and earns 25% on his own shops, 4% / 3% on his team's shops, and the 20%
>      monthly share. This goes straight to payment.
> 3. **Pay first, KYC after.** A paid buyer:
>    - signs in;
>    - gives his name, mobile and PAN (the account is created if he has none);
>    - accepts the rules;
>    - pays online.
>
>    The zone is booked for him at once, but it goes **live** only after his
>    dealer KYC and bank account are approved. Going live means his franchise
>    code, team shops and payouts start.
>
>    He has **30 days** to finish KYC. After that the admin sees the booking as
>    overdue and may refund it, which frees the zone.

Owner's choices: 22-Nov-2026, about 13.40 IST, all on the recommended
options. This **supersedes** the final brief (21-Nov) rule §5.5, "a verified
dealer before payment".

## What was built

| Part | Where |
|---|---|
| City prefix on zone names (data) | `drizzle/0164_franchise_free_or_paid.sql` |
| Choice step, free path, paid path | `src/components/franchise/zone-booking.tsx` |
| Selected zones survive sign-in (`?zones=…&join=paid`) | `src/app/franchise/book/page.tsx` |
| Minimal buyer account (name, mobile, PAN → DRAFT dealer) | `startFranchiseBuyer` in `src/server/franchise/booking.ts`, `POST /api/franchise/buyer` |
| Pay blockers vs. KYC-after items | `ownerStatusForUser` (`missing` = blocks paying; `kycMissing` = needed to go live) |
| Paid before KYC → `kyc_due_at` = payment + 30 days; no code, no team shops yet | `onFranchiseFeeCaptured` |
| Going live when KYC + bank are done | `goLiveAfterKyc`: called on admin approval, on the bank check and daily |
| No franchise commission while waiting for KYC | `zoneContext` / `franchiseModelFor` skip allocations with `kyc_due_at` |
| Overdue list (after 30 days) | daily job → admin notice; Admin → Franchise shows "Awaiting KYC" with the due date |
| Free dealer's working zone | `dealers.preferred_zone_id`; `/dealer/apply?zone=GKZ-PUN-17` |

## Defaults chosen (not asked)

- **The 12-month term starts at payment**, not at go-live. This matches the
  receipt and the launch-offer count.
- A paid buyer whose dealer application is **rejected** stays on the overdue
  list for an admin refund. Nothing is refunded automatically; the payment
  gateway stays an admin action.
- **Free path with several zones selected:** he picks one working zone from
  his selection.
