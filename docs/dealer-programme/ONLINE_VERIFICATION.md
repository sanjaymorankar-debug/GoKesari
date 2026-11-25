# Dealer documents: verify online or upload (22-Nov-2026)

> **Status (24-Nov-2026):** live on gokesari.com since 22-Nov-2026 19.19 IST (release #481, migration 0166).

## Owner's request

1. After booking a franchise zone, the dealer application asked the buyer again to choose the area he will
   work in. Remove it: his booked zone is his area.
2. The documents step asked only for uploads. Also offer to enter the details and verify each document online.

## What was built

| Part | Where |
|---|---|
| A paid franchise buyer sees "Where you will work: your franchise zone(s)" instead of the state / district picker; saving and submitting need no other area | `franchiseZonesOfDealer`, `validateTerritories`, `submitApplication` in `src/server/dealers/service.ts`; `dealer-application.tsx` |
| "Verify PAN online" / "Verify GSTIN online": the number from step 1 is checked with the government record through the KYC provider (Sandbox.co.in, `KYC_PROVIDER`) and the name on it is matched against the legal and representative names (rule `sellerVerification.nameMatchAutoApprove`, 85) | `src/server/dealers/online-verify.ts`, `POST /api/dealer/application/verify` |
| "Verify with the bank": the account from step 1 is checked with the bank (Cashfree Bank Account Verification, the same check as before) | `checkDealerBank` via the same route; shown only when the Verification keys are set |
| A document verified online needs no upload: it shows **verified online** and counts as accepted for submit and approval | `dealerView` (`VERIFIED_ONLINE`), `decideDealer` |
| A GSTIN verified online also covers the **address proof** (the GST record carries the registered address) | `satisfiedOnline` |
| Results kept per dealer and document (latest check only, normalised fields, never the vendor's raw response); a check counts only while the number is unchanged | table `dealer_verifications`, `drizzle/0166_dealer_online_verification.sql`, rollback `scripts/rollback-0166.sql` |
| Admin → Dealers shows each online check (status, name on record, time) and the franchise zones | `dealer-admin-detail.tsx` |

## Rules chosen (not asked)

- **Name does not match** (score below 85): not accepted online; the dealer corrects the name or uploads the
  document for the team to check.
- **Provider down or number unknown**: the upload stays available; nothing is failed for our outage.
- **Cost control**: at most 10 online checks an hour per user; a number already verified is not checked again.
- **Not online**: Shop & Establishment (Sandbox.co.in has no Maharashtra lookup), the signed agreement (accepted
  online at submit), and the address proof for a dealer without a GSTIN (upload). Aadhaar through DigiLocker
  for the address proof is possible later (the rider flow has it).
