# GoKesari — GST & shop registration work: consolidated status

**25-Nov-2026, 02.55 IST.** All work is on its way to **staging** (test.gokesari.com) through the staging queue. Nothing is on gokesari.com yet. Production follows the 23.00 IST release window and needs the owner's OK.

## Pull requests (merge order = PR number)

| PR | What | CI | Queue |
|---|---|---|---|
| [#542](https://github.com/sanjaymorankar-debug/GoKesari/pull/542) | Change a verified GST / PAN in signup; a different number re-asks owner name, address, shop details, pin | ✅ pass | queued |
| [#544](https://github.com/sanjaymorankar-debug/GoKesari/pull/544) | Many GSTINs per shop (any PAN, added after go-live); invoice uses the delivery state's GSTIN (migration 0190) | ⏳ re-running after a test fix (c3d88027) | queued |
| [#547](https://github.com/sanjaymorankar-debug/GoKesari/pull/547) | Abandoned registrations resume where they stopped; Admin → Unfinished registrations: continue for the owner, send the owner a link | ✅ pass | queued |
| ~~#550~~ | GST names shown after verify; sign-in name and mobile reused | — | **closed: folded into #552** (conflicted with #542/#547) |
| [#552](https://github.com/sanjaymorankar-debug/GoKesari/pull/552) | New signup order: Start selling → sign in → referral → GST/PAN → shop type → licences (number / photo / promise; must-haves kept) → address → pin → pay. **Also carries #550.** | ⏳ re-running | queued |
| [#554](https://github.com/sanjaymorankar-debug/GoKesari/pull/554) | Operations Manager role: shop documents + registrations access; staff-board tile | ⏳ running | queued |

Stacking: #547 is built on #542, and #552 on #547 + #550. Merge checks: #544 and #554 merge cleanly on top of #552.

Queue position: the queue was testing #543, with about 12 other PRs (#518–#538) ahead of these.

## Owner decisions recorded (25-Nov-2026)
- Many GSTINs on one shop. Any PAN allowed. Added after go-live. Invoice by delivery state, otherwise the main GSTIN.
- Abandoned registrations are never thrown away. This reverses the 08-Nov "never resumed" rule.
- Staff may continue a registration for the owner. The GST/PAN consent is the owner's, given on the call. The owner pays.
- Signup order as above. Must-have licences stay required.
- Operations Manager gets document + registration access.

## Open items
- **QA:** the signed-in / local QA cases for the old GST screen (TC-ONB identity-first) need re-baselining. The queue runs only the guest tier.
- **To check on staging once verified:** change GST; resume an abandoned registration; staff "Continue for owner"; the new order with a food shop (FSSAI); a second GSTIN and its invoice.
- **Not started:** shop subscriptions (1-year default, expiry e-mail + app alert, reminders / payment links for unpaid shops). The new session did not receive its brief.
