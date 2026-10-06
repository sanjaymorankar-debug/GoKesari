# GoKesari feature status - 6 Oct 2026

Your workbook `Gokesari_Complete_Features_and_Workflows.xlsx` (148 rows + flow diagram) compared with the code on main @579fd42 plus PR #58 (branch claude/admiring-ritchie-rhs1x8), 6 Oct 2026. Development status from code and tests, not QA sign-off. Full detail: `GOKESARI_FEATURE_STATUS_REPORT_2026-10-06.xlsx`.

Checked on main @579fd42 plus PR #58 (branch claude/admiring-ritchie-rhs1x8), 6 Oct 2026, fresh PostgreSQL 16 with migrations 0000-0055 applied: typecheck clean, lint 0 errors (4 unused-variable warnings in files PR #58 does not touch), 1214/1214 tests passed in 88 files (vitest), production build passes.

| Status | 3 Oct | 6 Oct |
|---|---|---|
| COMPLETED | 132 | 147 |
| IN PROGRESS | 23 | 0 |
| BLOCKED | 0 | 11 |
| YET TO START | 1 | 0 |
| UNCLEAR | 1 | 0 |
| Total | 157 | 158 |

COMPLETED includes features behind a business rule that is off by default (marked *off*).

## In Progress

| ID | Feature | Remaining | Blocked on |
|---|---|---|---|
| - | None | - | - |

## Blocked

| ID | Feature | Remaining | Blocked on |
|---|---|---|---|
| GS-001 | Mobile/email/Gmail login | SMS delivery of the OTP so a mobile number is proven (OTP provider seam ready). | D2 - SMS/OTP vendor with DLT registration |
| GS-023 | E-commerce price benchmark | Turn on the customer display - one rule flip, no code. | D7 - lawful / licensed price source |
| GS-028 | UPI/card/netbanking gateway | Per-order ONLINE payment via Cashfree hosted checkout (design signed off 1 Oct). | Go-ahead to build per-order payment, or a decision to launch wallet + COD only |
| GS-073 | Payment gateway | Order payment intents, callbacks and gateway refunds. | Needs GS-028 |
| GS-074 | SMS/WhatsApp/email/push | Real SMS / push / WhatsApp providers. | D2 - vendor choice (DLT registration) |
| WF-001 | Customer product purchase | Direct online payment for the order. | Needs GS-028 |
| RBAC-003 | Manage own shop | Define what an operator may change on a shop, then implement. | Decision: what 'Limited' means |
| SM-005 | Payment state machine | INITIATED -> AUTHORIZED -> CAPTURED -> RECONCILED; CHARGEBACK. | Per-order online payment go-ahead (GS-028 / NEW-007) |
| SM-006 | Issue state machine | Either add the four states to grievances or accept the dispute lifecycle as the issue state machine. | Decision: does the dispute lifecycle satisfy SM-006? |
| NAV-003 | Customer portal - Cart & Checkout | Online payment at checkout. | Needs GS-028 |
| NEW-007 | Direct per-order payments, tax invoicing, photo POD, accept timeout | Per-order online payment only (the other three parts are done). Invoice rates / HSN / wording to be confirmed by a CA before use for filing. | Per-order online payment go-ahead (GS-028) |

## Yet To Start

| ID | Feature | Remaining | Blocked on |
|---|---|---|---|
| - | None | - | - |

## Completed

**Feature Master** (69): GS-002 Role-based access control; GS-003 Multi-role user account; GS-004 PIN / address selection; GS-005 Society identification; GS-006 Shop registration; GS-007 Business KYC; GS-008 Payment reference verification; GS-009 Shop categories; GS-010 Service radius / delivery zone; GS-011 Product master; GS-012 Shop catalog mapping; GS-013 Bulk product upload; GS-014 Product images/specifications *(off)*; GS-015 MRP / selling price / discount; GS-016 Stock quantity; GS-017 Low-stock threshold; GS-018 Reorder level / quantity; GS-019 Shop search; GS-020 Product search; GS-021 All shops selling product; GS-022 Local price comparison; GS-024 Single-shop cart; GS-025 Multi-shop cart; GS-026 Address validation; GS-027 Delivery slot *(off)*; GS-029 Wallet; GS-030 COD; GS-031 Payment reconciliation; GS-032 Order creation; GS-033 Shop order split *(off)*; GS-034 Shop accept/reject; GS-035 Substitution approval; GS-036 Pick and pack; GS-037 Gig worker onboarding; GS-038 Online/offline status; GS-039 Job assignment; GS-040 Society priority assignment; GS-041 Pickup OTP/QR; GS-042 Live tracking; GS-043 Delivery OTP/POD; GS-044 Society registration; GS-045 Authorized Gig worker whitelist; GS-046 Security notification; GS-047 Delivery instructions; GS-048 Daily milk subscription; GS-049 Recurring vegetables/daily goods; GS-050 Subscription payment; GS-051 Skip/pause/resume/cancel; GS-052 Customer segmentation; GS-053 Shop promotional campaigns; GS-054 Referral program *(off)*; GS-055 Order notifications; GS-056 Report an issue; GS-057 Returns/refunds; GS-058 Dispute management; GS-059 Shop rating; GS-060 Gig rating; GS-061 Shop commission; GS-062 Shop settlement; GS-063 Gig earnings; GS-064 Gig payout; GS-065 Global dashboard; GS-066 Operator console; GS-067 Audit logs; GS-068 Fraud/risk rules; GS-069 Marketplace KPI dashboard; GS-070 Privacy/consent management; GS-071 Data access controls; GS-072 Maps/navigation *(off)*

**Workflow Master** (9): WF-002 Shop fulfillment; WF-003 Gig assignment; WF-004 Society authorized delivery; WF-005 Delivery; WF-006 Subscription; WF-007 Return/refund; WF-008 Shop onboarding; WF-009 Marketing campaign; WF-010 Settlement

**RBAC Matrix** (14): RBAC-001 Browse/search; RBAC-002 Place order; RBAC-004 Manage catalog; RBAC-005 Upload product lists; RBAC-006 Verify shop; RBAC-007 Assign delivery; RBAC-008 Manage own availability; RBAC-009 Whitelist Gig workers; RBAC-010 View all orders; RBAC-011 Refund approval; RBAC-012 Settlement; RBAC-013 Manage users/roles; RBAC-014 System configuration; RBAC-015 Audit logs

**State Machines** (4): SM-001 Order state machine; SM-002 Shop state machine; SM-003 Gig state machine; SM-004 Subscription state machine

**Gig Assignment Rules** (9): GA-001 Society authorization; GA-002 Society preferred partner; GA-003 Distance; GA-004 Availability; GA-005 Current load *(off)*; GA-006 Shop readiness; GA-007 Reliability; GA-008 Fairness; GA-009 No worker

**Navigation** (18): NAV-001 Customer portal - Home *(off)*; NAV-002 Customer portal - Shop *(off)*; NAV-004 Customer portal - Orders; NAV-005 Customer portal - Subscriptions; NAV-006 Shop portal - Dashboard; NAV-007 Shop portal - Catalog; NAV-008 Shop portal - Orders; NAV-009 Shop portal - Marketing; NAV-010 Shop portal - Finance; NAV-011 Gig portal - Jobs; NAV-012 Gig portal - Earnings; NAV-013 Gig portal - Profile; NAV-014 Society portal - Dashboard; NAV-015 Operator portal - Operations; NAV-016 Operator portal - Orders; NAV-017 Admin portal - Control Tower; NAV-018 Admin portal - Analytics; NAV-019 Admin portal - Security

**KPIs** (15): KPI-001 GMV; KPI-002 Order fill rate; KPI-003 Shop acceptance time; KPI-004 Pick-pack time; KPI-005 Assignment time; KPI-006 Delivery time; KPI-007 On-time delivery rate; KPI-008 Cancellation rate; KPI-009 Refund rate; KPI-010 Customer repeat rate; KPI-011 Subscription retention; KPI-012 Gig acceptance rate; KPI-013 Gig utilization; KPI-014 Shop retention; KPI-015 Marketing conversion

**Added after the target workbook** (9): NEW-001 Business-rules console (admin-tunable thresholds); NEW-002 Shop suspension policy, impact preview & review; NEW-003 Order placed while the shop is closed; NEW-004 Rider arrival checkpoints & customer notices; NEW-005 Minimum order value, pause new orders, extra delivery PIN zones; NEW-006 D10 cancellation & refund policy (verified); NEW-008 Product category master & shop product-category visibility; NEW-009 Explicit Save flow on admin screens (categories, privileges, user profiles); NEW-010 Shop inventory fill when a category is added; per-shop prices

## Your flow diagram

| Box | Step | Status | Gap |
|---|---|---|---|
| Customer | Location / Society | COMPLETED | - |
| Customer | Search shop or product | COMPLETED | - |
| Customer | Compare local + online prices | BLOCKED | Online (e-commerce) prices hidden from customers until D7 - licensed source - is decided. |
| Customer | Cart / Subscription | COMPLETED | - |
| Customer | Payment | BLOCKED | No per-order UPI / card / netbanking payment - waits on the go-ahead (GS-028 / NEW-007). |
| Order engine | Validate stock + service area | COMPLETED | - |
| Order engine | Split order by shop | COMPLETED | - |
| Order engine | Confirm payment | BLOCKED | Gateway confirmation and the payment state machine wait on GS-028. |
| Order engine | Create fulfillment tasks | COMPLETED | - |
| Shop owner | Receive order | COMPLETED | SMS / WhatsApp alerts wait on D2. |
| Shop owner | Accept / reject / substitute | COMPLETED | - |
| Shop owner | Pick + pack | COMPLETED | - |
| Shop owner | Mark READY | COMPLETED | - |
| Gig assignment | Check society authorization | COMPLETED | - |
| Gig assignment | Priority partner rules | COMPLETED | - |
| Gig assignment | Distance / ETA / load | COMPLETED | - |
| Gig assignment | Assign / broadcast | COMPLETED | Sequential offers, not a broadcast; no radius widening. |
| Delivery partner | Accept job | COMPLETED | - |
| Delivery partner | Pickup OTP / QR | COMPLETED | Code only - no QR. |
| Delivery partner | Navigate | COMPLETED | No in-app turn-by-turn. |
| Delivery partner | Society access | COMPLETED | - |
| Delivery partner | Customer OTP / POD | COMPLETED | No signature capture. |
| Society | Whitelist / revoke Gig workers | COMPLETED | - |
| Society | Delivery instructions | COMPLETED | - |
| Society | Security notification | COMPLETED | - |
| Society | Priority zone rules | COMPLETED | - |
| Post-order | Delivered / failed / returned | COMPLETED | - |
| Post-order | Refund / replacement | COMPLETED | Refunds go to the wallet; card / UPI refunds wait on GS-073. |
| Post-order | Ratings + support | COMPLETED | - |
| Post-order | Shop settlement + Gig payout | COMPLETED | Bank transfer is manual. |
| Subscription engine | Milk / vegetables / daily goods | COMPLETED | - |
| Subscription engine | Schedule | COMPLETED | - |
| Subscription engine | Auto-create order | COMPLETED | - |
| Subscription engine | Payment | COMPLETED | - |
| Subscription engine | Fulfillment + delivery | COMPLETED | - |
| Admin / operations | KYC + shop approval | COMPLETED | Runs on the mock vendor until Gridlines keys are set. |
| Admin / operations | Product master | COMPLETED | - |
| Admin / operations | Payments / reconciliation | COMPLETED | - |
| Admin / operations | Disputes / refunds | COMPLETED | - |
| Admin / operations | RBAC + audit | COMPLETED | RBAC-003 (operator 'Limited' shop management) waits on a definition. |
| Admin / operations | Analytics / controls | COMPLETED | - |
| Marketplace data | Product master | COMPLETED | - |
| Marketplace data | Shop catalog | COMPLETED | - |
| Marketplace data | Inventory | COMPLETED | - |
| Marketplace data | Price history | COMPLETED | - |
| Marketplace data | Customer consent | COMPLETED | - |
| Marketplace data | Orders / ledger | COMPLETED | - |
| Marketplace data | Analytics | COMPLETED | - |
