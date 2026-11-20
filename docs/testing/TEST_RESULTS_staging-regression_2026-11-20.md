# Staging regression: 20-Nov-2026 (IST)

Site: test.gokesari.com, build **f1fb3c7a** (production release #415 + #416 R2, #417 dealer 3 %,
#418 manual workbook, #419 territory dealers, #420 team leads add agents, #421 QA catalog, #422 staging
e-mail redirect). Suite: branch `qa/dealer-territory-team-cases-2026-11-20` (8ea0f6b4; re-runs at bcc4a5fb).
Full run **09.48 to 11.03 IST**, re-runs 11.07 to 11.15 IST. Guest and signed-in tiers; local-only checks
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

1. **Customer 1's staging wallet** (₹135): a ₹5,000 top-up through the "Sandbox payment" workflow (UPI
   testsuccess@gocash), then a re-run of the 13 wallet checks and the returns chain (37 rows blocked).
2. **Staging queue paused by #422** (issue #424): the failure is the test harness and the runner, not the
   change — closing #424 lets the queue go on.
3. **D-157 and D-158** before territory dealers are released.
