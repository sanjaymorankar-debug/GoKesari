@AGENTS.md

# Scope of this project's chats: GoKesari only

Chats and sessions for this repository are for **GoKesari (gokesari.com and
test.gokesari.com) only**. The following projects must **not** be discussed,
planned, reviewed or developed here — not even a small change:

- **Ladwani** (Mi Ladwani)
- **Education** (the `edu` project)
- **ATIP** (`ATIP-DEV`)
- **Bkesari** — bkesari.com, any `*.bkesari.com` site, `bkesari-platform`

If a request touches any of them, even by mistake (a pasted error, a file, a
question, a repo that happens to be attached to the session), do not act on
it. Reply briefly that this chat is for GoKesari only and ask the user to
continue in that project's own chat window. Where a request mixes GoKesari with
one of these, do only the GoKesari part and say which part was left out and
where to take it.

# Payment testing on staging: Cashfree sandbox test data

For any payment test on test.gokesari.com (staging), use Cashfree **sandbox**
test data only. The full list is in
[docs/testing/cashfree-sandbox-test-data.md](docs/testing/cashfree-sandbox-test-data.md).
Quick reference:
- **Cards:** OTP **111000** for every test card. Proven on staging: Visa
  4111 1111 1111 1111 (exp 12/30, CVV 123) and debit 4706 1312 1121 2123.
  Cashfree's own list (exp 03/2028, CVV 123, name Test) is in the doc.
- **UPI:** testsuccess@gocash (success) and testfailure@gocash (failure).
- **Net banking:** bank code 3003 is proven on staging; Cashfree also lists
  TEST Bank 3333 / TESTR.
- **Running a payment:** this session cannot reach Cashfree, so the pay step
  runs through the "Sandbox payment" GitHub workflow
  (`.github/workflows/sandbox-pay.yml`).

Never use real cards, UPI IDs or bank accounts on staging. Never use test data
or sandbox keys on gokesari.com (production). Keys come from the environment,
never from code.
