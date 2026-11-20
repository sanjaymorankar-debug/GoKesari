# Staging regression: 20-Nov-2026 (IST)

Site: test.gokesari.com, build **f1fb3c7a** (production release #415 + #416 R2, #417 dealer 3 %,
#418 manual workbook, #419 territory dealers, #420 team leads add agents, #421 QA catalog, #422 staging
e-mail redirect). Suite: branch `qa/dealer-territory-team-cases-2026-11-20` (8ea0f6b4; re-runs at bcc4a5fb).
Full run **09.48 to 11.03 IST**, re-runs 11.07 to 11.15 IST; afternoon re-run **16.57 to 17.25 IST**
after a wallet top-up (section below; the Result table is the morning run). Guest and signed-in tiers; local-only checks
are skipped on staging by rule.

Record: `docs/testing/qa-runs/2026-11-20-staging-regression.json`. Register:
`docs/testing/GOKESARI_MASTER_TEST_REGISTER.xlsx` (1,133 cases and journeys).

## Result

| | Pass | Fail | Blocked | Not run here by rule |
|---|---|---|---|---|
| Desktop | 466 | 29 | 174 | 669 |
| Phone (Pixel 7) | 100 | 10 | 43 | 28 |
| **Total rows** | **566** | **39** | **217** | **697** |

**No new product defect on staging.** The 39 failed rows are 25 checks:

| Class | Checks | Status |
|---|---|---|
| Customer 1's test wallet ran out (₹135 after the run; E-33) | TC-CART-009, 012, 015, 016, 018; TC-LOC-018, 020, 022, 024; TC-ORD-001; TC-PRE-008; TC-RBAC-016, 017 | Test data. Top up through the "Sandbox payment" workflow, then re-run |
| Open COD limit and the customer's 50-order list (E-16) | TC-COD-001, 002, 012; TC-CART-018; TC-SUP-001, 002, 006; TC-FLD-102 | Test data (stale open orders) |
| Rider offer taken back between offer and accept | TC-DEL-001, 010 (one desktop check; the same IDs pass in another check and on phone) | Timing; re-run |
| Re-run artefact: the order was already rated by the first run | TC-FLD-102, TC-SUP-008 | Not a defect |
| Known product defects | TC-RPAY-001 (D-152), TC-FLD-056 (D-78 / D-144) | Open, unchanged |

What happened during the run:

- **Both test shops stopped taking orders mid-run (E-36).** Each order takes GoKesari's charges from the
  shop's prepaid wallet; shop B (Asmy test2) fell to ₹0 and shop A (E2E Four Features Bakery) to ₹196.67,
  under the ₹200 `shopWallet` minimum, so the app paused them (correct behaviour). Admin credit of ₹5,000
  each at 11.09 IST, then the 27 affected checks were re-run: shop A delivers again (TC-LOC-004, 005,
  007, 013 pass), but the order-placing checks then met customer 1's empty wallet.
- **SD-06** now records *blocked* instead of *fail*: the staging shop owner has a shop waiting for approval,
  so `/shop/register` rightly offers no wizard (E-27). Fixed in the check.
- **TC-QA-001** failed in the first pass only because the run's suite commit had the 36 new cases in the
  catalog but not yet their checks; it passes at bcc4a5fb.
- **rider2 / shopB** have no saved session: their sign-in codes go to a mailbox the QA agent does not read
  (24 rows blocked, as on 16-Nov).

The two checks that paused the staging queue for #422 (TC-RGR-005, TC-SEC-007) **pass** in this run on
#422's build (04:23 UTC). In the queue they failed with a Node module-loading race in the test harness
(`next-auth/jwt` from `tests/qa/lib/actors.ts`, also seen in #421's run) and a network `fetch failed` from
the GitHub runner — not with a wrong answer from the site.

## Afternoon re-run after the wallet top-up (16.57 to 17.25 IST)

Customer 1's wallet held ₹2,215.50 at 16.55 IST (other activity since the morning). On the owner's OK it
was topped up **₹5,000** through the "Sandbox payment" workflow (Cashfree sandbox, UPI testsuccess@gocash,
run 44727452470) and credited at 16.57 (₹7,155.50). Then on test.gokesari.com build **4483e776** (staging
with #423 newspapers, #425 / #433 consultant appointments and #426), suite db8c94d1:

1. the 13 checks that failed on the empty wallet, by ID;
2. the delivery, support and returns files in full (the 10 checks blocked "wallet too low" and the
   returns chain of 37 blocked rows);
3. TC-RBAC-016 / 017 and TC-CART-015 again at 17.24, once the shop owner's own wallet had money.

Record: `docs/testing/qa-runs/2026-11-20-staging-rerun-wallet.json` (72 IDs, 128 rows: 91 pass, 18 fail,
19 blocked). Staging column of the register: **Fail 25 → 21, Blocked 86 → 71, Pass 134 → 141, Pass
(partial) 240 → 252.** No new product defect.

The register now also lists the 28 GoKesari Health cases (PR #429, TC-HLT-…): **1,197** cases and
journeys, the Health cases *Not run* (they reached staging after this run).

| Group | Result |
|---|---|
| 13 empty-wallet checks | **10 pass**: TC-CART-009, 012, 018, TC-LOC-018, 020, 024, TC-ORD-001, TC-PRE-008, TC-RBAC-016, 017. TC-RBAC-016 / 017 and the B2B half of TC-CART-015 pay from the **shop owner's** own wallet, which was ₹0 at 16.57; they pass at 17.24. The pickup-order check (TC-CART-015, 016, TC-LOC-022) passed at 16.57 and is refused again at 17.24 (402): customer 1 was back to ₹10 (E-37) |
| 10 checks blocked "wallet too low" | TC-FLD-095, TC-RET-001 pass; TC-DEL-001 / 010 / 012, TC-FLD-102, TC-SUP-006 / 008 pass on desktop; on the phone, and TC-SUP-001 / 002 on both, they fail or block on the rider (E-38) |
| Returns chain (18 IDs) | **All pass on desktop** except the last step of TC-RET-010 / TC-FLD-098: ₹70.50 is stored as 7050 paise and refunded, but the refunded case is not on page 1 of the shop's "All" returns, where 15 open QA returns from earlier runs come first (E-39). On the phone the pickups never reach the rider (E-38) |

What the run showed about the test set-up (logged, none a product defect):

- **E-37:** the staging test accounts are used by more than one session at once. Customer 1 went from
  ₹7,155.50 to ₹10 in 27 minutes, with an order at 17.23 IST after this run had ended; another session
  topped the shop owner up ₹3,000 at 17.15 and ordered as the shop owner at 17.23.
- **E-38 (test fix):** the phone pass ran after the desktop pass had left an offer with the single staging
  rider. The dashboard then showed two offers and the unscoped "Accept" click hit both (strict mode);
  TC-DEL-020 asserts the rider has no active delivery at all; later offers come only on the minute
  dispatch tick, after the checks' 30 s wait. One QA order still offered after the run (DB-20261120-KHS786)
  was cancelled as operations ("QA cleanup") at 17.23 IST.
- **E-39 (test fix):** TC-RET-010's last step looks only at page 1 of `/shop/returns?tab=all`.

## Territory dealers and team leads (new, local server)

36 new cases (TC-TERR-001 … 026, TC-TIER-033 … 042) and journeys SC-48 / SC-49, automated as local-tier
checks and run on a local server of this code (`docs/testing/qa-runs/2026-11-20-local-dealer-territory-team.json`):
**60 checks: 53 pass, 6 fail, 1 blocked** (SC-45, declared manual). The rest of the dealer suite passes,
except TC-TIER-032 (D-153, known). New product defects:

| ID | Severity | Case | What |
|---|---|---|---|
| D-157 | Medium | TC-TERR-013 | No "Pay … to renew" on /dealer in the 30-day renewal window: the card waits for an open fee that only exists after a payment starts |
| D-158 | Medium | TC-TERR-010 | After a failed or expired online fee payment, "Pay" reopens the same failed attempt; the dealer cannot pay online again |
| D-154 | Low | TC-TIER-036 | An inactive team lead is told "Only a member of a dealer team can add an agent." instead of "Your place in the team is not active." |
| D-155 | Low | TC-TERR-004 | 501 pincodes or a fee under ₹1: "Please check the highlighted fields." instead of the clear message |
| D-156 | Low | TC-TERR-008 | Paying a cancelled territory says its pincodes were released after the grace period, not "This territory is cancelled." |

On staging itself, the territory rule was switched on at 08.30 IST by another session and tested there
(`TEST_RESULTS_territory-dealer-staging_2026-11-20.md`, 13 of 13 pass).

## What needs you

1. **Shared staging test accounts (E-37):** customer 1 is at ₹10 again (17.24 IST) because other sessions
   order with the same accounts. Either one staging QA run at a time, or a test customer and shop owner per
   session; a further top-up only lasts while nobody else uses them.
2. **E-38 / E-39** are fixes in the QA suite (scope the rider's Accept to the check's own order, wait one
   dispatch tick, find the refunded return on any page); then the phone pass of the delivery, support and
   returns checks can be re-run (with funds in customer 1's wallet).
3. **D-157 and D-158** before territory dealers are released.

Done since the morning: the staging queue paused by #422 (issue #424) went on after #428 fixed the test
harness (12.35 IST); customer 1's wallet was topped up and the checks re-run (above).
