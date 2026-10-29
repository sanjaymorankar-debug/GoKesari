# Dealer Programme — Admin and Operator Guide

GoKesari Authorized Dealer & Merchant Acquisition Programme. For GoKesari admins and operators.
Last updated 28 Oct 2026. Design and decisions: [REUSE_GAP_ANALYSIS.md](REUSE_GAP_ANALYSIS.md).

**Who can do what**

| | Admin | Operator | Dealer |
|---|---|---|---|
| Switch features on / off | Yes | No | No |
| Approve, suspend, reject, terminate dealers | Yes | Read only | No |
| Commission rules, cap, rating slabs, bonus, payouts | Yes | Read only | Sees own rates and ledger |
| Support service charges, refund rule, refunds | Yes | Read only | No |
| Area targets, performance-score weights | Yes | Read only | No |
| Attribution claims, support tickets | Yes | Yes | Raises own |

Every change needs a written reason and is kept in the audit log.

---

## 1. Switching the programme on

**Admin → Settings → Feature flags** (`/admin/feature-flags`).

| Flag | What it switches on |
|---|---|
| `dealer_programme_enabled` | Dealer application, dealer portal, codes, attribution, commission, dealer analytics |
| `gov_verification_auto_approval_enabled` | Instant shop approval on government GST/PAN check + online fee payment |
| `dealer_rating_bonus_enabled` | The rating bonus on top of commission |
| `paid_support_services_enabled` | The paid Support services page for shops |

Each flag can be on for **all of India**, or only for chosen **states** and **districts**. A state
(`KA`, `TN`, …, listed as "Karnataka (whole state)") covers every district in it, including
districts added later; a district (the Pune pilot is `MH-PUN`) covers only itself.
Off means the site behaves exactly as before. Turn a flag off at any time; nothing is deleted.

**Production:** all four are off. Switch them on only in an approved window, Pune first.

---

## 2. Dealers

**Admin → Dealers** (`/admin/dealers`). Filters by status; the list shows each dealer's rating,
shops brought, live shops and commission.

**Lifecycle:** Draft → Pending → Approved → Suspended / Rejected / Terminated.

**Approving a dealer** (`/admin/dealers/<id>`):
1. Check each document (PAN, GSTIN, Shop Act, address proof, bank proof, signed agreement).
   Which documents a dealer type must give is set under **Document requirements** on the same
   screen — not every document is forced on every type.
2. Check the bank account (₹1 check result) and the agreement dates.
3. Approve. The dealer gets a code like `GKS-MH-PUN-7K4Q9X`, a share link
   (`/shop/register?ref=CODE`) and a QR code.

**Suspending** puts the dealer's unpaid commission on hold; **reactivating** releases it.
A code can be suspended or replaced (the old code stops working; shops keep their attribution).

**Adding a dealer directly** (admins only): **Add dealer** at the top of `/admin/dealers`.
1. Choose the **state or union territory** (all 28 states and 8 UTs are listed).
2. Choose one of its **districts**, "Whole state (no district)", or **+ Add a new district…** and
   type its name. A new district gets a short code automatically (Mysuru → `MYS`); typing a
   district that already exists in that state reuses it.
3. Optionally give the dealer's **sign-in e-mail** (an existing GoKesari account; one dealer per
   account), mobile, city and PIN code, and the **reason** (kept in the audit log).
4. The dealer is approved at once with a unique code: `GKS-<state>-<district>-<6 characters>`
   (`GKS-KA-MYS-GVERY9`), or `GKS-<state>-<6 characters>` with no district (`GKS-TN-FGXFW9`).
   The six characters are random from a set without look-alike letters, checked against every
   existing code. Documents, bank details and the agreement can follow on the dealer's page.

**Commission rules** can be set for all of India, a state or a district; the most specific one
that matches the shop's area wins (district, then state, then all of India).

**Legacy distributors** were moved in as dealers with their existing codes. Codes with no
distributor sit under **GoKesari Direct** (internal; earns no commission).

---

## 3. Shops brought by dealers

- A shop registered with a dealer code (typed, or from the `?ref=` link) belongs to that dealer;
  the dealer's employee is recorded when the optional **Employee ID** is filled in.
- A dealer can also register a shop **with the owner** (dealer-assisted): the owner confirms with a
  one-time code.
- **Leads:** a dealer may record a lead (with the owner's consent). It reserves the shop for
  30 days (business rule `dealerProgramme.leadWindowDays`); at most 200 open leads per dealer.
- **Likely duplicates** (same phone, GSTIN, or a similar name within 150 m) are flagged and earn
  no commission.
- **Attribution claims** (`/admin/dealers/claims`): a dealer who says a shop is theirs. Decide with a
  reason; the decision moves or keeps the attribution.

---

## 4. Instant approval on GST/PAN (where its flag is on)

**Admin → Shops → Instant approvals** (`/admin/shops/instant-approvals`).

A pending shop is approved with no admin step when **all** of these hold:
- GSTIN active at the government source, its PAN matches, names match (or PAN-only with the
  "not GST-registered" declaration accepted);
- the other mandatory documents are verified (Shop Act; FSSAI for food shops);
- the registration fee was paid **through the payment gateway** (a fee recorded by hand does not count);
- no other owner's shop has the same GSTIN.

The owner then gets the "ready for product upload" e-mail, and the dealer is told.
Every decision is logged with its evidence. **Pending** lists shops still waiting, with the reason
(e.g. "registration fee not paid"); if the government source is down, the shop stays pending and the
nightly re-check approves it once the source answers.

**Approving without documents** (Shops approval queue, admin only, with a reason): allowed, but
the dealer's activation commission and rating credit stay **on hold** until the shop's documents are
verified; then they are released automatically.

---

## 5. Commission, rating and payouts

**Admin → Dealers → Commission, rating & payouts** (`/admin/dealers/commission`).

**Rules** — per shop type (standard / wholesale), district and milestone, with effective dates.
Pilot default for a standard shop:

| Milestone | Default |
|---|---|
| Registration completed (fee paid) | ₹100 |
| Verified documents + catalogue (10 active products) | ₹150 |
| Activation (shop approved) | ₹150 |
| **Total** | **₹400** |

A changed rule applies to new entries only; old entries keep the version they were earned under.

**Cap:** commission per shop (including the bonus) cannot exceed the cap (default ₹999). Anything
above waits as "above cap" until an admin overrides it with a reason.

**Rating** (0–10, starts at 5.0): rises with live shops — 200 → 5.5, 250 → 6.0, 500 → 6.5
(editable slabs). An admin can set a starting rating or downgrade a dealer with a reason (the dealer
sees it). **Bonus** (when its flag is on): each 0.1 above 5.0 adds 0.1% of the fee.

**Ledger:** earned → approved (by an admin) → in a payout → paid. Reversed entries (fee refunded,
fraud, duplicate) are cancelled; a reversal after payment is deducted from the next payout.

**Payouts:** create a payout for a dealer (all approved entries, netted), pay it **outside GoKesari**
by bank transfer, then mark it paid with the bank reference. GoKesari moves no money itself.

---

## 6. Support services (where its flag is on)

**Admin → Help desk → Support services** (`/admin/support-services`).

| Service | Default charge |
|---|---|
| General support | Free |
| Product upload | ₹499 per 50 products + 18% GST |
| Price update | ₹199 per 50 products + 18% GST, first request each month free |

- Change a charge: choose the model (free / per request / per item / per batch), amount, GST,
  free requests per month, effective date, and a reason. Requests already made keep their price.
- **Refund rule:** the share refunded when a shop cancels before work starts (default 100%).
- **Managed billing:** shops already paying for managed inventory & billing are not charged again
  for product upload or price update (switch on the same screen).
- Each paid request opens a **help-desk ticket** (Admin → Help desk) with the shop's files attached;
  work it there. Once work starts the shop can no longer cancel; an admin can still refund (to the
  shop wallet, or back through the gateway for an online payment).

---

## 7. Coverage and analytics

**Admin → Dealers → Coverage & analytics** (`/admin/dealers/analytics`).

- **Coverage:** Maharashtra → districts → talukas → localities. Each area shows active dealers,
  shops (and how many came through dealers), operational shops, target and status:
  *No dealer*, *Under target*, *Not operational* (half or more of its shops have no order in
  30 days), *Covered*, *No target set*. The drawn map places each area at its shops' average
  position. **Set target** (admin) records the number of shops wanted in an area.
- **Performance score** (for analysis only — the rating decides commission): live shops 35%,
  registration quality 20%, 30-day activity 20%, cost per live shop 15%, coverage 10%. Change the
  weights in **Admin → Settings → business rules → dealerPerformanceScore** (they must add up to
  100). Dealers are ranked only against dealers in the same district.
- **Activation & 30-day activity:** per dealer and per employee.

---

## 8. Business rules used by the programme

Admin → Settings → business rules:
- `dealerProgramme` — lead window (30 days), open-lead cap (200), duplicate distance (150 m),
  name similarity (80), dealer-assisted code validity (60 min).
- `dealerPerformanceScore` — the score weights.
- `registrationFeeByTurnover` — registration fee slabs by declared turnover (up to 20 slabs).
