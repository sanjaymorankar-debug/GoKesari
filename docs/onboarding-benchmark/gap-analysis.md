# Shop onboarding — gap analysis

05-Nov-2026, 23.15 IST. Based on [current-flow.md](current-flow.md) and
[competitor-benchmark.md](competitor-benchmark.md) (practice IDs P1–P22 refer to its section 3).

Impact: H / M / L for shop owners and time-to-first-sale. Effort: **S** ≤ 1 week, **M** 2–4 weeks,
**L** > 4 weeks or needs a vendor contract. "Asset" = something GoKesari already has that the fix reuses.

## 1. Gap table

| # | Stage | Best-in-class (who) | GoKesari today | Gap | Impact | Effort | Recommended fix |
|---|---|---|---|---|---|---|---|
| G1 | Sign-in | Mobile OTP first (Meesho, Mystore, Flipkart) | Code by **e-mail only**; unknown mobile also asks an e-mail | Kirana owners without e-mail stall at step 0 | H | M (SMS/WhatsApp vendor + DLT templates) | SMS/WhatsApp OTP on mobile; e-mail optional. Until a vendor exists: keep e-mail, and Google sign-in shown first on phones |
| G2 | Sign-in → register | Straight into the seller flow | New user goes through customer `/onboarding` (2 screens); mandatory customer code can **divert to `/referral`** | Lost registrations; 2 extra screens | H | S | When the return-to is `/shop/register`, skip `/onboarding` and the customer-code check; collect name inside the wizard |
| G3 | Minimum upfront | Account in < 10 min with GSTIN + 1 product (Flipkart P1); "bare minimum" (Udaan) | 6 screens before payment incl. shop e-mail and "documents now?" | Two screens add no value before payment | H | S | Merge: shop e-mail defaults to the account e-mail (change later in settings); remove "documents now?" — the document screen itself has "I'll add them later" |
| G4 | Referral | Not used by benchmarks; GoKesari rule must stay | Toggle works; when mandatory, a code-less owner must request and **wait for a call** | Hard stop at tile 1 | H | S | Keep toggle (business rule). When mandatory: instant "nearest dealer / district code" suggestion by PIN (nearby-referral data), plus WhatsApp/call button; request still e-mails referrals@ |
| G5 | GST/PAN prefill | GSTIN auto-fetch of name, PAN, type, address (Mystore P3); live state check (Flipkart P4) | Prefills name, legal name, owner, address, PIN; **city and state not filled**, no state field | Owner re-types; state empty on every wizard shop | M | S | Fill city + state from the GST record; add state (read-only when from GST) |
| G6 | Non-blocking verification | Continue while GST verifies (Amazon P2) | Already allowed (PENDING / MANUAL_REVIEW can continue) but status is silent | Owner doesn't know what is happening | M | S | Real-time status chips ("Checking GST… ✓ Verified 2 s") on the document and review screens, pushed by the existing event bus |
| G7 | Production KYC | Live GST/PAN API at all peers | Provider on production **unconfirmed** (docs: blocked until Gridlines keys); mock blocks auto-approval in production | Auto-approve may not work on gokesari.com at all | **H** | S (owner: vendor keys) | Confirm provider + keys; switch-check on prod before any rollout |
| G8 | DigiLocker / e-KYC | Not confirmed at any peer (P7 — opportunity) | DigiLocker exists for **riders** only (`/delivery-partner/kyc/digilocker`) | Owner identity / PAN by manual upload or typing | M | M | Reuse rider DigiLocker flow for owner PAN / Aadhaar-masked identity on the "upload later" path and for non-GST shops |
| G9 | Camera-first docs | Selfie + ID in-app (Amazon P6) | Scan tab with on-device OCR (English; not Shop Act); unconfirmed inside the app WebView | Works on web; app untested | M | S | Make "Scan" the default tab on phones; test in Android + iOS WebView; Hindi/Marathi OCR later |
| G10 | Defer documents to payout | No peer states it publicly — chance to lead | "Upload later" path exists; payouts held until GSTIN/PAN verified; 1st/15th reminders | Copy contradicts (30 vs 90 days); ready e-mail says "GST/PAN verified" for upload-later | M | S | Fix copy; one clear rule shown before payment: "Sell now — add documents before your first payout" |
| G11 | Fee transparency | Revenue calculator / settlement pricing before first sale (Amazon, Flipkart P13) | Slab fee shown at review; copy says "one-time" but it starts a **12-month membership**; commission / wallet not explained | Mistrust, payment drop-off | H | S | One "What you pay" card before payment: fee + GST, renewal after 12 months, commission %, wallet minimum, payout timing |
| G12 | Fee amounts | — | Code: ₹999 / ₹4,999 / ₹9,999 + GST by **turnover**; brief says ₹1,000 shop / ₹2,500 wholesale | Business rule mismatch | H | S | **Owner decision needed** (see §3) |
| G13 | Payment return | Return to the next step | Gateway returns to `/shop/registration-fee`, not the wizard | Tiles 8–10 skipped | **H** | S | Return to `/shop/register` (or a "You're live" screen that continues to set-up) |
| G14 | Failed / pending payment | — | No notice to owner on failed wizard payment; no admin alert for paid-but-pending | Silent dead ends | H | S | Events `SHOP_FEE_FAILED` (owner, dealer) and `SHOP_PAID_PENDING_REVIEW` (admin, with SLA); retry link |
| G15 | Location | Pickup address / map early (Meesho, Mystore) | Pin after approval; pending shops can't set pin; staging Maps key refused | Delivery radius unknown until later | M | S | Keep owner's "pin after pay" decision; allow pin while pending; owner adds staging Maps referrer |
| G16 | First products | Master catalogue match (Amazon ASIN, Mystore P9); barcode scan (Amazon P10); photo-to-listing AI (Amazon P11) | Category adds **no products**; add one by one or Excel; no barcode scan for shops; GS1/OFF barcode lookup exists for **admin** only | Shop live but empty; slow first listing | **H** | M | "Starter shelf": pick categories → top products from the product master pre-ticked (count set by admin, e.g. 100) → owner only types price (MRP pre-filled) and stock in one list. Phone barcode scan using the existing GS1/OFF lookup. Photo-to-listing later |
| G17 | Price / MRP | Price only, rest from catalogue | No MRP for shops; price + stock one product at a time | Slow, error-prone | M | S | MRP shown from master; "sell at MRP" one-tap; bulk price % off MRP |
| G18 | Bank account | Bank during sign-up (Meesho, Mystore) | Separate page, ₹1 debit-refund; rule off; payouts not held for unverified bank | Payout set-up forgotten | M | S | Keep it **after** live (defer), but as checklist item "Add bank to get paid", required before first payout; instant penny-drop via Cashfree when owner enables `bankAccountCheck` |
| G19 | Wallet / delivery | — | Wallet rule off; delivery off by default; not in onboarding | Shop can't take delivery orders | M | S | Checklist items: "Choose delivery: own staff / GoKesari riders / pickup only" and "Top up wallet" (only when wallet rule on) |
| G20 | Post-live checklist | Go-live checklist + share link/QR (Dukaan P20); guided 60 days (Flipkart P18) | None in Seller Central; wizard tiles only | Owners don't know what's left | **H** | S | Seller Central "Finish set-up" card: pin, 10 products, bank, delivery, test order, share link + QR, documents — each with live status |
| G21 | Progress / time | Completion progress (Flipkart P8) | 10 tiles, no time estimate | — | L | S | "Step 3 of 5 · about 2 min left" |
| G22 | Save & resume | — | Server-side drafts, resumes; no abandon reminder | No recovery of abandoned owners | M | S | Mark drafts ABANDONED after 24 h idle; event-driven reminder (e-mail / push / WhatsApp later) with resume link; admin drafts list |
| G23 | Assisted mode | Field teams (Flipkart, Swiggy P16) | Dealer-assisted and operator flows exist (owner e-mail code) | Separate flows; dealer role can't use the wizard | M | M | One wizard with "Registering for someone else": owner consent by OTP, then same screens; dealer credited automatically |
| G24 | Multiple shops | — | Owner can't start a 2nd shop in the wizard | Branch owners blocked | M | S | "Register another shop" button on Seller Central and on the DONE screen |
| G25 | Language | Indian languages (Amazon 8, Meesho Hindi P15) | Wizard English only; `/sell` promises हिन्दी / मराठी | Promise broken | H | M | Translate wizard, sign-in, referral dialog, checklist, e-mails into HI / MR using the board i18n (`gk_lang`) |
| G26 | WhatsApp | Not confirmed at peers — chance to lead | Provider stub only (`WHATSAPP_PROVIDER` none/mock) | No WhatsApp status | M | L (BSP + Meta templates) | Phase B: wire templates through existing notify(); go live when owner signs a BSP |
| G27 | Analytics / funnel | — | No step events, no funnel | Can't measure drop-off | H | S | `onboarding_events` (started / completed / abandoned / ms spent per step) + admin funnel: registration → verified → paid → first product → first order |
| G28 | Notifications | — | Submit / first product / first order not notified; copy defects | Gaps in B2 | M | S | Event per state change to owner, referrer / dealer, admin (§B2) |
| G29 | Accessibility | — | Alerts not announced, focus not moved, 11 px labels | Screen-reader users lost | M | S | `role="alert"`, `aria-describedby`, focus heading on step change, ≥ 13 px labels |
| G30 | Distributor commission | — | Module 3 commission not written for wizard shops (inferred) | Distributor pay at risk | M | S | Confirm with owner; route through dealer attribution |
| G31 | Mobile apps | Native seller apps (Flipkart Minutes, Amazon) | WebView shell; deep links for `/shop/register` uncommitted; flow untested on a real phone | Parity is automatic but unproven | M | S | Commit deep links, test Android + iOS (camera, location, payment return), bump app version only if native code changes |

## 2. Priorities

### Quick wins (< 1 week)

1. **G13** Payment returns to the wizard → no lost tiles 8–10.
2. **G20** "Finish set-up" checklist in Seller Central (pin, products, bank, delivery, share link + QR, documents).
3. **G2** Skip customer `/onboarding` and customer-code diversion for shop registration.
4. **G3** Remove the shop e-mail and "documents now?" screens (defaults + inline "add later").
5. **G11** "What you pay" card before payment (fee, GST, renewal, commission, payouts).
6. **G14 / G28** Events + notices: payment failed, paid-but-pending (admin SLA), submitted, first product, first order.
7. **G5** City + state from the GST record.
8. **G6** Real-time verification status chips.
9. **G10** Copy fixes (30 vs 90 days, "one-time", "GST/PAN verified").
10. **G24** "Register another shop".
11. **G27** Step analytics + admin funnel.
12. **G29** Accessibility fixes. **G21** "X min left".
13. **G7** Confirm production KYC provider (owner / vendor).

### Next (2–4 weeks)

14. **G16 / G17** Starter shelf from the product master (auto-tick top N per category, price/MRP/stock in one list) + phone barcode scan.
15. **G25** Hindi + Marathi for the whole onboarding.
16. **G4** Instant referral help by PIN when the code is mandatory.
17. **G22** Abandon detection + resume reminders + admin drafts list.
18. **G23** One assisted mode for dealers / operators with owner OTP consent.
19. **G8 / G9** DigiLocker for owners (reuse rider flow); scan-first on phones.
20. **G18 / G19** Bank and delivery as checklist steps, bank required before first payout.
21. **G1** SMS OTP (needs SMS vendor + DLT).

### Later

22. **G26** WhatsApp onboarding and status (needs BSP + Meta templates).
23. Photo-to-listing AI (shelf photo → products).
24. Guided first 60 days (in-app tips, first-order nudge, launch offer) — owner to decide incentives.
25. **G30** Distributor commission review.

## 3. Owner decisions needed before Phase B

| # | Question | Default if not answered |
|---|---|---|
| D1 | Registration fee: keep turnover slabs (₹999 / ₹4,999 / ₹9,999 + GST) or switch to **₹1,000 shop / ₹2,500 wholesale** as in the brief? Is it one-time or yearly? | Keep the slabs as built; fix copy to say "12 months" |
| D2 | Starter shelf: how many products per category to pre-tick (brief says 100), and at what default stock? | 100 top products across chosen categories, stock 0 → owner sets stock |
| D3 | Remove the separate shop e-mail step (account e-mail used, changeable in settings)? It was kept by owner choice on 30-Oct. | Keep it, but as an optional line on the review screen |
| D4 | Bank account required before first payout (rule `requireVerifiedForShopPayouts` on)? | Yes |
| D5 | KPI "≤ 5 min / ≤ 6 screens" — measure from the first sign-in screen or from tile 1? | From tile 1 for a signed-in user; also report new-user time |
| D6 | Production: which KYC provider and are keys live? Is the wizard flag on? | Check in Phase B before release |

### Owner answers, 05-Nov-2026, 23.30 IST

| # | Answer | How it is applied |
|---|---|---|
| D1 | **Yearly** | Keep the turnover slabs as built (₹999 / ₹4,999 / ₹9,999 + GST; the ₹1,000 / ₹2,500 split was not chosen); every screen and e-mail says "for 12 months, renews yearly" instead of "one-time" |
| D2 | Pre-tick **100** products, default stock **100**; owner edits own quantity | Starter shelf |
| D3 | Shop e-mail stays **required** but as one pre-filled line, best UX | Account e-mail pre-filled on the details screen; a code is sent only when the owner changes it |
| D4 | **Yes** — verified bank account before the first payout, plus a banner on every Seller Central sign-in saying the account is not set and payouts will not be processed until it is | `requireVerifiedForShopPayouts` default on; banner on `/shop` |
| D5 | **Yes** (count from the first sign-in screen) | KPIs measured from the sign-in screen for a new owner |
| D6 | Owner will provide the production KYC provider / keys and wizard-flag state | Open — production release waits for it |

"Phase 1" (= the quick wins) approved by the owner, 05-Nov-2026, 23.30 IST.
