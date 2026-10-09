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

# Where GoKesari reports are saved (standard)

Every GoKesari development report and test result goes to the owner's folders
on their Mac:

| What | Folder |
|---|---|
| Feature development reports and status trackers (e.g. `GOKESARI_FEATURE_STATUS_REPORT_<date>.xlsx`, feature / process-flow / PR status, open-features lists) | `/Users/agtci/Documents/Doc_GoKesari/Devlopment_Trackers` |
| Test results and test-case tracking (test-case workbooks, regression matrices, test-run results such as `TEST_RESULTS.md`, QA sign-off sheets) | `/Users/agtci/Documents/Doc_GoKesari/Test_Cases_Tracking` |

Keep the folder names exactly as written (`Devlopment_Trackers` is spelled that
way on purpose).

- **Session on the owner's Mac** (the folder exists): save the file there.
  For a status report, write a new dated file (`..._<YYYY-MM-DD>.xlsx`). For
  test results, update the existing tracker for that feature or run, and
  create a new file only for a new run. Also keep the repository copy under
  `docs/` when the work is committed. Say the full path in the reply.
- **Cloud session** (the `/Users/agtci/...` folder does not exist): save the
  file in the repository as usual (status reports in `docs/gokesari-audit/`,
  test results next to the feature's docs). Send it to the owner as a file,
  and say which of the two Mac folders it belongs in so they can save it
  there. Never report a file as saved to the Mac folder when it was not.
