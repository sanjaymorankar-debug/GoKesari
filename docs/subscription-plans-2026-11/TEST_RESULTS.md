# Subscription plans — test results

Feature: [PROMPT.md](PROMPT.md) · design: [DESIGN.md](DESIGN.md).

## 1. Local — 23-Nov-2026, finished 22.45 IST

Local PostgreSQL databases made for this work only (`gk_plans_test`, `gk_plans_full`, `gk_plans_ui`), migrations to 0182 applied.

| Suite | Result |
|---|---|
| `tests/unit/subscription-plans.test.ts` — plan settings, schedule fitted to a plan, labels, term end dates | 10 / 10 pass |
| `tests/integration/subscription-plans.test.ts` — plans, nearby search, subscribing within the rules, plan price on Monday not Sunday, subscription-only listing, off / removed plans, prep sheet, API routes and access | 11 / 11 pass |
| Existing subscription suites (engine, states, schedule, newspapers, periodicals) | pass — 95 tests across the 7 subscription files |
| `tile-board`, `seller-central` (menu counts and groups) | pass |
| Typecheck (`npm run typecheck`), QA typecheck, lint on every changed file | clean |
| QA guest checks TC-SUB-028, 029 against the local server (desktop + phone) | 3 pass, 1 desktop-only skipped on phone |
| Full unit + integration suite | see §1a |

### Browser walk-through (local server, desktop and 375 px phone)

| Step | Seen |
|---|---|
| Shop owner: Product categories → Subscription plans → New plan | Made "Veg lunch thali" from a listing **not on sale online and not subscribable**: Meals & tiffin, Lunch 12:30–2 pm, ₹80 subscriber price, Mon–Sat, every delivery day / days of the week → card "Taking subscribers · Lunch (12:30–2 pm) · Mon–Sat · ₹80 per piece (subscriber price) · 0 subscribers · open-ended". A second plan "Morning poha & chai" (Breakfast, ₹55, every day, 7 or 30 days). |
| Customer: Subscription plans | Both plans from Annapurna Tiffin Service, 0.3 km away, with price, days and length; Lunch filter leaves the lunch plan only |
| Subscribe page | Only the plan's choices; "Every delivery day" → "Delivered: Mon–Sat."; 30-day estimate ₹2,080 (26 × ₹80); wallet warning (₹1,000 < ₹2,080) |
| After subscribing | Subscription page "plan "Veg lunch thali", Lunch (12:30–2 pm)", ₹80 per piece; calendar has no delivery on Sundays |
| Shop | Notice "New subscriber — Meera Joshi subscribed to Veg lunch thali (1 piece, Mon–Sat, Lunch (12:30–2 pm)), starting 24 Nov 2026. Deliver to: Deccan, Pune, 411005."; Subscribers: "Next 7 days — what to prepare" 1 a day Mon–Sat, none on Sunday 29 Nov; subscriber row with plan and slot |
| Shop's public page (phone) | "Subscription plans" section with both plans and Subscribe buttons; no sideways scroll; the plan form fits a phone too |

## 1a. Full local suite

(filled in when the run finishes)

## 2. test.gokesari.com (staging queue)

(filled in after the queue merges and verifies the PR)
