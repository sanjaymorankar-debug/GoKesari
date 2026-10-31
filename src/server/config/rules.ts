/**
 * Registry of admin-configurable business rules and their code defaults.
 * Add a new rule group here; services read it with `getRule("<key>")`
 * (services/settings.ts). Nothing below is a hard-coded business decision —
 * each is only the value used until an admin changes it.
 */
import { z } from "zod";
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { DEFAULT_TURNOVER_SLABS, MAX_TURNOVER_SLABS, turnoverSlabsProblem, upgradeLegacyTurnoverRule } from "@/lib/registration-fee";

const int = (min: number, max: number) => z.number().int().min(min).max(max);

export const RULES = {
  otp: {
    description: "Mobile-login one-time codes: length, expiry, attempt and resend limits.",
    schema: z.object({
      length: int(4, 8),
      expiryMinutes: int(1, 60),
      maxAttempts: int(1, 10),
      resendCooldownSeconds: int(0, 600),
      maxResendsPerWindow: int(1, 20),
      resendWindowMinutes: int(1, 1440),
      /** Requests per phone number + per IP within `resendWindowMinutes`. */
      maxRequestsPerIpPerWindow: int(1, 200),
      smsEnabled: z.boolean(),
    }),
    defaults: {
      length: 6,
      // batch-2026-10 WS-A (F1.1.2, GS-001): codes live 5 minutes (was 10).
      expiryMinutes: 5,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
      maxResendsPerWindow: 5,
      resendWindowMinutes: 60,
      maxRequestsPerIpPerWindow: 20,
      // batch-2026-10 WS-A: this switch now really gates SMS codes (with SMS_PROVIDER). On by
      // default so nothing changes where SMS_PROVIDER is set (Module 3 shops); off = email only.
      smsEnabled: true,
    },
  },
  dispatch: {
    description:
      "Finding a rider: offer lifetime, retry cadence and limits, and when the search stops.",
    schema: z.object({
      /** How long a rider has to accept an offer. */
      offerTtlSeconds: int(30, 900),
      /** Wait between automatic attempts to match a rider for one order. */
      retryIntervalSeconds: int(15, 1800),
      /** Matching attempts (each offer counts) before automatic retries stop. */
      maxAttempts: int(1, 100),
      /** Total search time before automatic retries stop. */
      maxSearchMinutes: int(1, 720),
      /** Keep searching this long past the promised delivery time, then stop. */
      windowGraceMinutes: int(0, 240),
      /** Minimum gap between two manual "Find rider now" presses for one order. */
      manualCooldownSeconds: int(0, 600),
      /** Tell the shop after this many unsuccessful attempts (then once more when the search stops). */
      notifyShopAfterAttempts: int(1, 20),
      /**
       * F3 — off: a rider already holding a delivery is not offered another
       * (the original rule). On: such riders stay in the pool, ranked after
       * every free rider, so they are offered only when no free rider is.
       */
      busyRidersAsFallback: z.boolean(),
      /** With busyRidersAsFallback on: most deliveries one rider may hold at once (offered, accepted or picked up). */
      maxActiveDeliveriesPerRider: int(1, 5),
      /**
       * Event layer (Y): minutes after the rider search starts with nobody
       * accepted before support is alerted (once per search) by the
       * timeout-sweep. Offers keep being retried meanwhile.
       */
      alertSupportAfterMinutes: int(1, 720),
    }),
    defaults: {
      offerTtlSeconds: 120,
      retryIntervalSeconds: 60,
      maxAttempts: 10,
      maxSearchMinutes: 30,
      windowGraceMinutes: 15,
      manualCooldownSeconds: 30,
      notifyShopAfterAttempts: 1,
      busyRidersAsFallback: false,
      maxActiveDeliveriesPerRider: 2,
      alertSupportAfterMinutes: 30,
    },
  },
  riderEarnings: {
    description:
      "Rider earnings: per-order minimum, and how failed or cancelled-after-pickup deliveries and late drops are paid.",
    schema: z.object({
      /** Floor for one order's earning when no slot sets its own. */
      minimumEarningPaise: int(0, 1_000_000),
      /** % of the computed earning paid when the drop failed (the rider made the trip). */
      failedDeliveryPayoutPercent: int(0, 100),
      /** % paid when the customer cancelled after the rider had picked up (D10: rider still paid). */
      cancelledAfterPickupPayoutPercent: int(0, 100),
      /** Flat deduction when a delivery is later than promised by more than the grace; 0 disables. */
      latePenaltyPaise: int(0, 1_000_000),
      lateGraceMinutes: int(0, 240),
    }),
    defaults: {
      minimumEarningPaise: 0,
      failedDeliveryPayoutPercent: 100,
      cancelledAfterPickupPayoutPercent: 100,
      latePenaltyPaise: 0,
      lateGraceMinutes: 15,
    },
  },
  returns: {
    description: "Customer returns: window, per-reason policy, pickup and refund behaviour.",
    schema: z.object({
      /** Hours after delivery within which a return may be requested. */
      windowHours: int(1, 24 * 60),
      /** Per reason: whether it is accepted, evidence needed, and who bears the refund. */
      reasons: z.record(
        z.string(),
        z.object({
          allowed: z.boolean(),
          requiresImages: z.boolean(),
          chargeTo: z.enum(["SHOP", "PLATFORM"]),
        }),
      ),
      /** Riders collect the goods when the shop delivers; otherwise the customer takes them to the shop. */
      pickupByRider: z.boolean(),
      /** Fee credited to the rider for a completed return pickup; null = the default base fee. */
      riderPickupFeePaise: z.number().int().min(0).max(1_000_000).nullable(),
      /** Refund is paid automatically once the inspection accepts the goods. */
      autoRefundAfterInspection: z.boolean(),
      maxImagesPerReturn: int(0, 12),
      /** Wrong PIN/code attempts at handover before only operations can complete the pickup. */
      maxHandoverAttempts: int(1, 10),
    }),
    defaults: {
      windowHours: 48,
      reasons: {
        DAMAGED: { allowed: true, requiresImages: true, chargeTo: "SHOP" },
        WRONG_ITEM: { allowed: true, requiresImages: true, chargeTo: "SHOP" },
        QUALITY_ISSUE: { allowed: true, requiresImages: true, chargeTo: "SHOP" },
        EXPIRED: { allowed: true, requiresImages: true, chargeTo: "SHOP" },
        MISSING_ITEM: { allowed: true, requiresImages: false, chargeTo: "SHOP" },
        NOT_AS_DESCRIBED: { allowed: true, requiresImages: true, chargeTo: "SHOP" },
        CHANGED_MIND: { allowed: false, requiresImages: false, chargeTo: "PLATFORM" },
        OTHER: { allowed: true, requiresImages: false, chargeTo: "PLATFORM" },
      },
      pickupByRider: true,
      riderPickupFeePaise: null,
      autoRefundAfterInspection: true,
      maxImagesPerReturn: 6,
      maxHandoverAttempts: 5,
    },
  },
  images: {
    description: "Uploaded images: size and dimension limits and counts.",
    schema: z.object({
      maxBytes: int(50_000, 10_000_000),
      maxDimensionPx: int(200, 8000),
      minDimensionPx: int(1, 2000),
      maxPerProduct: int(1, 30),
    }),
    defaults: { maxBytes: 2_000_000, maxDimensionPx: 4096, minDimensionPx: 100, maxPerProduct: 8 },
  },
  notifications: {
    description:
      "Notification delivery: every notification is sent the moment its event happens; a failed send stays in the outbox (notification_deliveries) and the notification-retry job tries again on this schedule. maxAttempts (N) sends, then the message is marked dead and support is alerted in the app.",
    schema: z.object({
      /** Delivery attempts (N) per outbound notification before it is marked dead. */
      maxAttempts: int(1, 10),
      /** Seconds to wait before attempt 2, 3, ...; the last value repeats. */
      retryBackoffSeconds: z.array(int(10, 86_400)).min(1).max(10),
      batchSize: int(1, 500),
      /** Event layer: tell support (operators, in the app) when a message is given up on. */
      alertSupportOnDead: z.boolean(),
    }),
    defaults: { maxAttempts: 4, retryBackoffSeconds: [60, 300, 1800], batchSize: 50, alertSupportOnDead: true },
  },
  suspension: {
    description:
      "Shop suspension policy: what happens to each open order by its status when a shop is suspended.",
    schema: z.object({
      /**
       * Per order status: CANCEL_REFUND (cancel with a full refund and restock),
       * CONTINUE (the shop finishes it) or REVIEW (held until an operator decides).
       * Statuses not listed are left alone.
       */
      actions: z.record(z.string(), z.enum(["CANCEL_REFUND", "CONTINUE", "REVIEW"])),
      defaultExpectedAction: z.string().min(3).max(300),
    }),
    defaults: {
      actions: {
        CONFIRMED: "CANCEL_REFUND",
        ACCEPTED: "REVIEW",
        PREPARING: "REVIEW",
        READY: "REVIEW",
        ASSIGNED: "REVIEW",
        PICKED_UP: "CONTINUE",
        OUT_FOR_DELIVERY: "CONTINUE",
      },
      defaultExpectedAction: "Contact Gokesari support to resolve the reason above so your shop can be reinstated.",
    },
  },
  mrp: {
    description:
      "MRP governance: when a shop's selling price is refused for being above the master MRP.",
    schema: z.object({
      /** VERIFIED: enforce only against a verified MRP. ANY: also unverified. NONE: never refuse. */
      enforceOn: z.enum(["VERIFIED", "ANY", "NONE"]),
      /** Paise a selling price may exceed the MRP by (rounding), normally 0. */
      tolerancePaise: int(0, 1000),
    }),
    defaults: { enforceOn: "VERIFIED", tolerancePaise: 0 },
  },
  externalPrices: {
    description:
      "Who sees external reference prices. Customer display stays off until the licensed-source decision (D7) is made.",
    schema: z.object({
      showToCustomers: z.boolean(),
      showToShops: z.boolean(),
      /** References older than this are not shown outside operations. */
      maxAgeDays: int(1, 3650),
    }),
    defaults: { showToCustomers: false, showToShops: true, maxAgeDays: 90 },
  },
  disputes: {
    description:
      "When a dispute case is escalated to an administrator automatically (GS-058). Both triggers are off at 0, which leaves escalation entirely to a reviewer.",
    schema: z.object({
      /** A live case older than this is escalated by the sweep. 0 disables the age trigger. */
      escalateAfterHours: int(0, 720),
      /** A case opened for more than this is escalated at once. 0 disables the amount trigger. */
      escalateAbovePaise: int(0, 100_000_000),
      /** How long a reviewer has to resolve an escalated case before it is flagged as overdue. */
      resolveTargetHours: int(1, 720),
      /**
       * Event layer (dispute SLA): a live L1 case left without a reply from
       * the shop or support for this many hours — since it opened or since
       * the customer last wrote — is escalated to an administrator by the
       * hourly SLA check. 0 disables it.
       */
      responseSlaHours: int(0, 720),
    }),
    defaults: {
      // 48 h matches the return window, so a dispute and a return on the same
      // order age out on the same clock.
      escalateAfterHours: 48,
      // ₹2,000. Above this an administrator decides, not operations.
      escalateAbovePaise: 200_000,
      resolveTargetHours: 120,
      responseSlaHours: 24,
    },
  },
  customerReferrals: {
    description:
      "Customer referral rewards. On: every customer gets a referral code and link; when a friend who joined with it has their first order delivered, both get the reward as promotional wallet credit. Off: no codes are shown and nothing is credited.",
    schema: z.object({
      enabled: z.boolean(),
      referrerRewardPaise: int(0, 1_000_000),
      refereeRewardPaise: int(0, 1_000_000),
      /** Most rewards one customer can earn by referring. */
      maxRewardsPerReferrer: int(1, 1000),
      /** A code can only be applied this many days after joining, before any order. */
      applyWithinDays: int(1, 365),
    }),
    defaults: {
      enabled: false,
      referrerRewardPaise: 5000,
      refereeRewardPaise: 5000,
      maxRewardsPerReferrer: 20,
      applyWithinDays: 30,
    },
  },
  imageModeration: {
    description:
      "Product photo moderation. Off: shop owners' photos go live at once (the original behaviour). On: photos a shop owner adds or replaces wait in Admin → Image moderation and are shown publicly only once approved; rejected photos carry a reason. Photos already live stay live.",
    schema: z.object({ enabled: z.boolean() }),
    defaults: { enabled: false },
  },
  homePriceComparison: {
    description:
      "Home-page price comparison. On: customers with a location see products sold by two or more of the shops that deliver to them, with each shop's price and the cheapest highlighted (loose goods without a price are skipped). Off: the section is hidden.",
    schema: z.object({ enabled: z.boolean() }),
    defaults: { enabled: false },
  },
  shopOffers: {
    description:
      "Shop offers (a shop's own discount on a product or category, with dates). Off: offers are hidden and prices are the shop's normal online price (the original behaviour). On: live offers show on the shop page and apply to the unit price in the cart and at checkout. Shop-funded.",
    schema: z.object({ enabled: z.boolean() }),
    defaults: { enabled: false },
  },
  coupons: {
    description:
      "Order-level coupon codes (Admin → Coupons). Off: the coupon box is hidden and codes are refused (the original checkout). On: a valid code takes a flat amount or a percentage off the order's goods, split across shops in proportion to their goods value. Platform-funded — shops are paid on their full goods value.",
    schema: z.object({ enabled: z.boolean() }),
    defaults: { enabled: false },
  },
  parentOrders: {
    description:
      "One order reference for a multi-shop checkout. Off: one order number per shop only (the original behaviour). On: a cart from several shops also gets a single parent reference (GK-…) covering all of them; each shop still gets and manages its own order.",
    schema: z.object({ enabled: z.boolean() }),
    defaults: { enabled: false },
  },
  deliverySlots: {
    description:
      "Delivery slot capacity. Off: no limit (the original behaviour). On: each delivery window takes at most the set number of orders per hour (express, standard) or per day (scheduled) for a shop; full windows show as unavailable at checkout. Per-shop and per-area limits are set under Admin → Delivery slots; these are the defaults (empty = unlimited).",
    schema: z.object({
      enabled: z.boolean(),
      defaultExpressPerHour: int(0, 10_000).nullable(),
      defaultStandardPerHour: int(0, 10_000).nullable(),
      defaultScheduledPerDay: int(0, 100_000).nullable(),
      /** GS-027: per chosen time slot of a scheduled delivery (empty = only the day limit). */
      defaultScheduledPerSlot: int(0, 10_000).nullable(),
    }),
    defaults: {
      enabled: false,
      defaultExpressPerHour: null,
      defaultStandardPerHour: null,
      defaultScheduledPerDay: null,
      defaultScheduledPerSlot: null,
    },
  },
  shopAcceptance: {
    description:
      "Shop acceptance timeout (NEW-007). Off: an order waits for the shop indefinitely (operations sees it in the exceptions queue — the original behaviour). On: a shop must accept a new order within acceptMinutes (X) — counted from when it opens, for an order placed while closed — or, per onTimeout, the order is cancelled with a full refund (customer and shop told) or escalated to support. The shop gets a reminder part-way through. Subscription orders are not affected.",
    schema: z.object({
      enabled: z.boolean(),
      /** Minutes the shop has to accept a new order. */
      acceptMinutes: int(1, 240),
      /** Remind the shop when this share of the time has passed (0.5 = half-way). */
      reminderAtFraction: z.number().min(0.1).max(0.95),
      /**
       * Event layer: what the timeout-sweep does when the time (X) is up.
       * CANCEL — cancel with a full refund and tell the customer and shop.
       * ESCALATE — alert support (once) and leave the order for an operator.
       */
      onTimeout: z.enum(["CANCEL", "ESCALATE"]),
    }),
    defaults: { enabled: false, acceptMinutes: 30, reminderAtFraction: 0.5, onTimeout: "CANCEL" },
  },
  deliveryProof: {
    description:
      "Photo proof of delivery (NEW-007). Off: a rider marks an order delivered with the customer's code, as before. On: the rider must also take or upload a photo at the door (JPEG, PNG or WebP, within the image size limit) before the order can be marked delivered. The photo is shown to the customer, the shop and operations only. An operator's override is unchanged.",
    schema: z.object({
      photoRequired: z.boolean(),
    }),
    defaults: { photoRequired: false },
  },
  invoicing: {
    description:
      "Tax invoice per order (NEW-007). On: when an order is delivered the shop's invoice is issued — a tax invoice for a shop with a verified GSTIN (CGST+SGST, or IGST across states), otherwise a bill of supply — numbered per shop per financial year, and the customer and the shop can download it. Prices are tax-inclusive; tax is worked out of each line at the product's GST rate. GoKesari's delivery fee is not on the shop's invoice. Confirm rates and wording with a CA before relying on these invoices for filing.",
    schema: z.object({
      enabled: z.boolean(),
      /** GST rate (basis points) for a product with no rate on record — such lines are marked "rate not set". */
      defaultGstRateBp: int(0, 2800),
    }),
    defaults: { enabled: false, defaultGstRateBp: 0 },
  },
  batching: {
    description:
      "Rider batching (GA-005): one rider carries several orders in one trip. Off: one order per rider at a time (the original behaviour; busy riders only as a fallback when dispatch.busyRidersAsFallback is on). On: a rider whose current orders are all still waiting for pickup can be offered another order when it fits the trip — pickup within the set distance of the trip's pickups, drop in the same direction, and every order still delivered by its promised time. Such a rider is preferred over an idle rider up to the preference distance further away. The rider gets one ordered list of pickups and drops; each order keeps its own status.",
    schema: z.object({
      enabled: z.boolean(),
      /** Orders one rider may carry in one trip. */
      maxOrdersPerTrip: int(2, 6),
      /** A new pickup must be this close (km) to every pickup already in the trip. */
      maxPickupDistanceKm: z.number().min(0).max(10),
      /** Drop bearings from the pickups may differ by at most this many degrees. */
      maxDropBearingDegrees: int(0, 180),
      /** Drops closer than this to the pickups (km) are compatible in any direction. */
      directionFreeWithinKm: z.number().min(0).max(10),
      /** Time allowed per stop (pickup or drop), minutes, for the promised-time check. */
      stopMinutes: int(0, 30),
      /** A rider on a compatible trip wins over an idle rider who is less than this much (km) further away. */
      batchPreferenceKm: z.number().min(0).max(10),
    }),
    defaults: {
      enabled: false,
      maxOrdersPerTrip: 2,
      maxPickupDistanceKm: 0.5,
      maxDropBearingDegrees: 45,
      directionFreeWithinKm: 1,
      stopMinutes: 3,
      batchPreferenceKm: 1,
    },
  },
  scheduledSlots: {
    description:
      "Scheduled delivery with a chosen date and time (GS-027). Off: 'Scheduled' is a single option with no time (the original behaviour). On: the customer picks a date and a time slot at checkout; only future slots inside the shop's opening hours, after the cut-off and with places left (Delivery slots limits) are offered, and the place is re-checked when the order is placed. A rider is sought for such an order only shortly before its slot.",
    schema: z.object({
      enabled: z.boolean(),
      /** Length of one slot. */
      slotMinutes: int(30, 480),
      /** How many days ahead, today included, a customer can book. */
      daysAhead: int(1, 14),
      /** A slot must start at least this long after the order (on top of the shop's preparation time). */
      cutoffMinutes: int(0, 1440),
      /** Hours used for a shop with no opening hours set ("HH:MM", IST). */
      defaultOpen: z.string().regex(/^\d{2}:\d{2}$/),
      defaultClose: z.string().regex(/^\d{2}:\d{2}$/),
      /** Look for a rider this long before the slot starts. */
      dispatchLeadMinutes: int(0, 240),
    }),
    defaults: {
      enabled: false,
      slotMinutes: 120,
      daysAhead: 3,
      cutoffMinutes: 60,
      defaultOpen: "08:00",
      defaultClose: "20:00",
      dispatchLeadMinutes: 45,
    },
  },
  routing: {
    description:
      "Road routing for delivery distance and arrival-time estimates. Off: straight-line distance at the assumed average speed (the original calculation). On: a routing service, falling back to straight-line whenever it fails.",
    schema: z.object({
      enabled: z.boolean(),
      /** google: Routes API with GOOGLE_MAPS_SERVER_API_KEY. osrm: an OSRM server (free / self-hosted). */
      provider: z.enum(["google", "osrm"]),
      /** Base URL of the OSRM server. The public demo server is rate-limited and not for production. */
      osrmBaseUrl: z.string().url(),
      /** Give up on the routing call after this long and use straight-line. */
      timeoutMs: int(500, 10_000),
      /** Reuse a route between nearby points (~100 m) for this long. */
      cacheSeconds: int(0, 3600),
    }),
    defaults: {
      enabled: false,
      provider: "google",
      osrmBaseUrl: "https://router.project-osrm.org",
      timeoutMs: 3000,
      cacheSeconds: 60,
    },
  },
  statusModels: {
    description:
      "Lifecycle status models for shops, riders and subscriptions: when enforcement is on, the database refuses a status change that is not in the allowed-transition table (it is always logged).",
    schema: z.object({
      /** Read by the database trigger (migration 0042). Off: disallowed changes go through, logged as unenforced. */
      enforceTransitions: z.boolean(),
    }),
    defaults: { enforceTransitions: true },
  },
  subscriptionRenewal: {
    description:
      "Subscription states (SM-004). A subscription with an end date becomes 'renewal pending' this many days before it ends, and one whose wallet will not cover the deliveries in the payment window becomes 'renewal pending' until the customer tops up. Deliveries continue while renewal is pending; a subscription past its end date completes. The schedule horizon is how many days of upcoming deliveries carry their own 'scheduled' / 'skipped' status.",
    schema: z.object({
      termEndEnabled: z.boolean(),
      /** Days before the end date that renewal becomes due (0 = on the end date). */
      termEndNoticeDays: int(0, 60),
      paymentDueEnabled: z.boolean(),
      /** Days of upcoming deliveries the wallet must cover (1 = the next delivery day). */
      paymentDueDays: int(1, 30),
      /** Days ahead each scheduled delivery is written with its own status. */
      scheduleHorizonDays: int(1, 60),
    }),
    defaults: {
      termEndEnabled: true,
      termEndNoticeDays: 3,
      paymentDueEnabled: true,
      paymentDueDays: 1,
      scheduleHorizonDays: 7,
    },
  },
  shopDocumentFollowUp: {
    description:
      "Shop documents (owner decision, 29 Oct 2026). The registration fee is paid only once the shop's documents are verified (at least one); an owner without the rest ticks \"I will provide all relevant documents within <promiseDays> days\" (promiseDays; 90 since the owner decision of 29 Oct 2026, was 30) and the shop waits for an admin or operator to approve it. When enabled, on each day in reminderDaysOfMonth (the 1st and 15th, India time) every live shop still missing a mandatory document (PAN, GSTIN or the no-GST declaration, Shop Act, FSSAI for food) is e-mailed a reminder; at the run after the last of remindersBeforeSuspension reminders, and not before its promised date, it is suspended and the owner is e-mailed. These e-mails are sent even when the owner has switched shop e-mails off. A shop approved without its documents (an admin's waiver) or on the promise has graceDays (3 months, owner decision 29 Oct 2026) from its latest waiver or its approval: it is reminded on every reminder day until then and suspended at the first run after.",
    schema: z.object({
      enabled: z.boolean(),
      reminderDaysOfMonth: z.array(int(1, 28)).min(1).max(4),
      remindersBeforeSuspension: int(1, 10),
      promiseDays: int(1, 90),
      graceDays: int(15, 365),
    }),
    defaults: { enabled: true, reminderDaysOfMonth: [1, 15], remindersBeforeSuspension: 3, promiseDays: 90, graceDays: 90 },
  },
  sellerVerification: {
    description:
      "Seller document verification (PAN, GSTIN, Udyam, FSSAI, Shop Act): when a vendor result is accepted without a person, how often documents are re-checked, and when a lapsed document takes a shop offline.",
    schema: z.object({
      /** A record name scoring at least this against the seller's names (0–100) passes the name check. */
      nameMatchAutoApprove: int(50, 100),
      /** Cross-document consistency score (0–100) needed to verify without an admin. */
      consistencyAutoApprove: int(0, 100),
      /** Re-check a verified GSTIN with the vendor this often (cancellations show up here). */
      gstRecheckDays: int(1, 365),
      /** Warn the seller this many days before an FSSAI or Shop Act document expires. */
      expiryWarningDays: int(1, 180),
      /** A document left PENDING because the vendor was down is retried after this long. */
      pendingRetryMinutes: int(5, 1440),
      /** Paid verification calls one shop may trigger per hour. */
      maxChecksPerShopPerHour: int(1, 100),
      /** Take an approved shop offline when a mandatory document expires or is cancelled. */
      autoSuspendOnLapse: z.boolean(),
      /** Days after expiry before that suspension, so a renewal in progress isn't cut off at once. */
      suspendGraceDays: int(0, 60),
      /**
       * DPDP Act 2023 s.8(7): erase verification data (numbers, certificates,
       * history) this long after a shop is closed, rejected or deleted.
       * CONFIRM THE PERIOD WITH A LAWYER/CA against tax and dispute limitation periods.
       */
      retentionDaysAfterClosure: int(30, 3650),
      /**
       * Event layer: approve a pending shop the moment its last mandatory
       * document is verified and nothing else blocks approval (registration
       * fee paid or waived, details complete). Off: an admin approves.
       */
      autoApproveShop: z.boolean(),
      /** The Kesari/Green classification an automatically approved shop gets, unless it already has one. Operators can change it later. */
      autoApproveClassification: z.enum(["KESARI", "GREEN"]),
      /** Event layer: remind support (daily job) of documents waiting in manual review longer than this. */
      manualReviewReminderHours: int(1, 720),
    }),
    defaults: {
      nameMatchAutoApprove: 85,
      consistencyAutoApprove: 80,
      gstRecheckDays: 30,
      expiryWarningDays: 30,
      pendingRetryMinutes: 15,
      maxChecksPerShopPerHour: 10,
      autoSuspendOnLapse: true,
      suspendGraceDays: 0,
      retentionDaysAfterClosure: 1095,
      autoApproveShop: false,
      autoApproveClassification: "GREEN",
      manualReviewReminderHours: 24,
    },
  },
  cancellation: {
    description:
      "Customer cancellation of their own order (D10 / D6). Any cancellation before the order is packed refunds the full amount, delivery fee included; after pickup a customer's own cancellation refunds the goods only (unchanged). CONFIRMED: a customer may cancel only until the shop accepts the order (the original D10 rule). PREPARING: a customer may cancel at any time before the order is packed (accepted or being picked); the shop is told.",
    schema: z.object({
      customerMayCancelUntil: z.enum(["CONFIRMED", "PREPARING"]),
    }),
    defaults: { customerMayCancelUntil: "CONFIRMED" },
  },
  shopContact: {
    description:
      "Shop phone numbers shown to customers (C1). SHOP_CONTACT: customers see only the contact phone and WhatsApp number the shopkeeper entered for the shop (My shop → details); with neither entered they see GoKesari customer care instead. The registration phone and the owner's login number are never shown. REGISTERED_PHONE: the original behaviour — the registration phone is shown as the shop's customer care number.",
    schema: z.object({
      customerVisible: z.enum(["SHOP_CONTACT", "REGISTERED_PHONE"]),
    }),
    defaults: { customerVisible: "SHOP_CONTACT" },
  },
  societyRiders: {
    description:
      "Society rider lists (C2). On: only a society Gokesari has verified can add riders to its list or mark one preferred, and only riders Gokesari has approved can be added — enforced by the server for every caller, platform staff included. Removing a rider is always allowed. Off: the original behaviour (any society admin could add an approved rider, verified or not).",
    schema: z.object({
      requireVerifiedSociety: z.boolean(),
    }),
    defaults: { requireVerifiedSociety: true },
  },
  openOrderCheck: {
    description:
      "Existing open order prompt at checkout (C3). On: before paying, a customer who already has an open order (placed directly, not yet delivered or cancelled) sees its status and chooses to cancel it (where they may cancel it themselves) or to ignore it and continue. ANY_SHOP: any open order; SAME_SHOP: only an open order from a shop in the cart. Off: no prompt (the original behaviour). Checkout itself is unchanged either way.",
    schema: z.object({
      enabled: z.boolean(),
      scope: z.enum(["ANY_SHOP", "SAME_SHOP"]),
    }),
    defaults: { enabled: true, scope: "ANY_SHOP" },
  },
  riderFiles: {
    description:
      "Rider photos, identity documents and ID card (C5). protectPhotos — on: a rider's photo opens only for the rider, Gokesari staff who manage riders, and the staff of a verified society that lists the rider, through a signed-in, access-checked link; a new photo must be uploaded (outside links are refused). Off: the original behaviour (anyone with the photo link can open it). kycDocuments — riders can upload photos of their identity documents; only an admin can open them (always, whatever this switch). idCard — approved riders get a digital ID card with their photo, name, rider ID and the verified societies that list them, to show at the society gate.",
    schema: z.object({
      protectPhotos: z.boolean(),
      kycDocuments: z.boolean(),
      idCard: z.boolean(),
    }),
    defaults: { protectPhotos: true, kycDocuments: true, idCard: true },
  },
  /* ---------------------------------------------------------------------
   * Item B (7 Oct 2026): business limits that used to be fixed in code. Each
   * default is the value the code used, so nothing changes until an admin
   * edits one.
   * ------------------------------------------------------------------- */
  cod: {
    description:
      "Cash on delivery limits (GS-030): largest COD order, open COD orders a customer may have at once, and how many failed or returned COD deliveries in how many days pause COD for that customer.",
    schema: z.object({
      maxOrderPaise: int(100, 100_000_000),
      maxOpenOrders: int(1, 50),
      failureWindowDays: int(1, 365),
      maxFailures: int(1, 50),
    }),
    defaults: { maxOrderPaise: 200_000, maxOpenOrders: 2, failureWindowDays: 90, maxFailures: 2 },
  },
  walletTopup: {
    description: "Wallet top-up: smallest and largest single top-up (paise).",
    schema: z
      .object({
        minPaise: int(100, 10_000_000),
        maxPaise: int(100, 100_000_000),
      })
      .refine((v) => v.minPaise <= v.maxPaise, { message: "The minimum cannot be above the maximum.", path: ["minPaise"] }),
    defaults: { minPaise: 100, maxPaise: 10_000_000 },
  },
  ratings: {
    description: "Ratings (GS-059/060): how many days after delivery a customer may rate the shop and the rider.",
    schema: z.object({ windowDays: int(1, 365) }),
    defaults: { windowDays: 30 },
  },
  marketing: {
    description:
      "Shop marketing campaigns: campaigns a shop may send a week, messages a customer may get from one shop and in total a week, and the largest audience per campaign.",
    schema: z.object({
      shopCampaignsPerWeek: int(0, 50),
      perShopPerCustomerPerWeek: int(0, 50),
      totalPerCustomerPerWeek: int(0, 100),
      maxRecipients: int(1, 1_000_000),
    }),
    defaults: { shopCampaignsPerWeek: 2, perShopPerCustomerPerWeek: 1, totalPerCustomerPerWeek: 3, maxRecipients: 5000 },
  },
  vouchers: {
    description: "Wallet vouchers: the highest bonus percentage a voucher may give.",
    schema: z.object({ maxBonusPercent: int(1, 100) }),
    defaults: { maxBonusPercent: 100 },
  },
  settlement: {
    description:
      "Shop settlement: days a delivered order is held before it can join a settlement batch, and days after delivery an order with no settlement is flagged as missing one.",
    schema: z.object({
      holdDays: int(0, 60),
      missingAlertDays: int(1, 120),
    }),
    defaults: { holdDays: 2, missingAlertDays: 9 },
  },
  deliveryOtp: {
    description:
      "Customer delivery code (GS-043): wrong attempts a rider may make before the drop is locked (a support ticket is raised and only operations can confirm it), and how often the customer may ask for a new code: seconds between requests and new codes per delivery. Also used by the exceptions queue and the OTP_LOCKOUTS risk rule. required (gig worker flow) — on: the rider enters the customer's code to mark a delivery done; off: no code is issued and the rider marks it delivered without one (use deliveryProof.photoRequired for photo proof instead).",
    schema: z.object({
      maxAttempts: int(1, 20),
      resendCooldownSeconds: int(0, 3600),
      maxResends: int(0, 20),
      required: z.boolean(),
    }),
    defaults: { maxAttempts: 5, resendCooldownSeconds: 60, maxResends: 3, required: true },
  },
  shopWallet: {
    description:
      "Shop prepaid wallet. When enabled, a delivered order's commission (rates under Admin → Finance) and a delivery charge (orders a GoKesari rider delivered: deliveryChargePaise + deliveryChargePerKmPaise × the shop-to-customer distance, to 0.1 km — the distance the rider is paid for; deliveryChargeUnknownDistancePaise when that distance is not known) are debited from the shop's wallet, and settlement no longer withholds that commission. A refund the shop bears returns the commission on the refunded goods to the wallet. A shop whose balance is below minBalancePaise cannot accept new orders and customers cannot check out from it; the owner is alerted when a charge takes the balance below lowBalanceThresholdPaise. topupMinPaise / topupMaxPaise limit one top-up. Amounts in paise.",
    schema: z
      .object({
        enabled: z.boolean(),
        deliveryChargePaise: int(0, 1_000_000),
        deliveryChargePerKmPaise: int(0, 100_000),
        deliveryChargeUnknownDistancePaise: int(0, 1_000_000),
        minBalancePaise: int(0, 100_000_000),
        lowBalanceThresholdPaise: int(0, 100_000_000),
        topupMinPaise: int(100, 10_000_000),
        topupMaxPaise: int(100, 100_000_000),
      })
      .refine((v) => v.topupMinPaise <= v.topupMaxPaise, {
        message: "The minimum top-up cannot be above the maximum.",
        path: ["topupMinPaise"],
      })
      .refine((v) => v.lowBalanceThresholdPaise >= v.minBalancePaise, {
        message: "Alert at or above the minimum balance, so the shop hears before it is blocked.",
        path: ["lowBalanceThresholdPaise"],
      }),
    // Agreed amounts: delivery charge ₹5 per km (no flat part; ₹25 when the
    // distance is unknown), ₹200 minimum, reminder at ₹300 (so a shop is warned
    // before it is blocked). Commission (1%) is the platform rate under Admin →
    // Finance → Commission, not set here.
    defaults: {
      enabled: false,
      deliveryChargePaise: 0,
      deliveryChargePerKmPaise: 500,
      deliveryChargeUnknownDistancePaise: 2_500,
      minBalancePaise: 20_000,
      lowBalanceThresholdPaise: 30_000,
      topupMinPaise: 10_000,
      topupMaxPaise: 5_000_000,
    },
  },
  returnPickup: {
    description: "Return pickups: how many days ahead a customer may schedule the pickup.",
    schema: z.object({ scheduleWithinDays: int(1, 30) }),
    defaults: { scheduleWithinDays: 3 },
  },
  grievances: {
    description: "Grievances: days after which an open grievance counts as overdue on the dashboard (consumer-rules redressal period).",
    schema: z.object({ overdueAfterDays: int(1, 90) }),
    defaults: { overdueAfterDays: 15 },
  },
  discovery: {
    description: "Shop discovery: distance (km) within which a shop is shown as nearby.",
    schema: z.object({ nearbyRadiusKm: z.number().min(0.5).max(50) }),
    defaults: { nearbyRadiusKm: 5 },
  },
  selfRegistration: {
    description:
      "Shop self-registration (Module 3, /shop/join): a shop registers with its name, an OTP-verified mobile and a referral code, picks a fee tier and pays online; the payment webhook approves it. enabled: the page accepts registrations. holdHours: how long an unpaid registration keeps its place on a referral code's usage limit. maxPendingPerMobile: unpaid registrations one mobile may have at once. classification: Kesari/Green given to a self-registered shop (operators can change it).",
    schema: z.object({
      enabled: z.boolean(),
      holdHours: int(1, 168),
      maxPendingPerMobile: int(1, 20),
      classification: z.enum(["KESARI", "GREEN"]),
    }),
    defaults: { enabled: false, holdHours: 24, maxPendingPerMobile: 3, classification: "GREEN" },
  },
  dealerProgramme: {
    description:
      "Dealer programme (docs/dealer-programme). leadWindowDays: how long a dealer's documented lead (with the owner's consent) reserves a shop that registers without a code. maxOpenLeadsPerDealer: open leads a dealer may hold at once (stops mass reservation). duplicateDistanceMeters: a new shop this close to another with a similar name (nameSimilarity 0–100) is flagged as a likely duplicate. assistedConsentMinutes: how long the owner's code keeps a dealer-assisted registration open. The programme itself is switched on in Admin → Settings → Feature flags.",
    schema: z.object({
      leadWindowDays: int(1, 365),
      maxOpenLeadsPerDealer: int(1, 10_000),
      duplicateDistanceMeters: int(10, 5_000),
      nameSimilarity: int(50, 100),
      assistedConsentMinutes: int(5, 24 * 60),
    }),
    defaults: { leadWindowDays: 30, maxOpenLeadsPerDealer: 200, duplicateDistanceMeters: 150, nameSimilarity: 80, assistedConsentMinutes: 60 },
  },
  dealerPerformanceScore: {
    description:
      "Dealer performance score (docs/dealer-programme, GKS-AN-001) — for analysis and ranking only; the onboarding rating drives commission. Weights in % (they must add up to 100): activatedShops — shops that went live, against the best dealer in the same district; registrationQuality — registrations not rejected, not duplicates and not reversed; activity30 — live shops with an order in the last 30 days; costPerActivatedShop — commission per live shop, cheapest in the district scores highest; coverage — areas of the dealer's territory with at least one of its shops (not a duplicate or rejected one). Shown in Admin → Dealers → Analytics.",
    schema: z
      .object({
        activatedShops: int(0, 100),
        registrationQuality: int(0, 100),
        activity30: int(0, 100),
        costPerActivatedShop: int(0, 100),
        coverage: int(0, 100),
      })
      .refine((w) => w.activatedShops + w.registrationQuality + w.activity30 + w.costPerActivatedShop + w.coverage === 100, { message: "The weights must add up to 100." }),
    defaults: { activatedShops: 35, registrationQuality: 20, activity30: 20, costPerActivatedShop: 15, coverage: 10 },
  },
  registrationFeeByTurnover: {
    description:
      "One-time shop registration fee on Add my shop (/shop/register), by the annual turnover the owner declares, in slabs (src/lib/registration-fee.ts): slabs is a list of { upToRupees, feePaise } — turnover up to a slab's upToRupees pays its feePaise; the last slab has upToRupees null and covers everything above. An admin adds or removes slabs (up to 20) in Admin → Registration fees → Fee by turnover. Fees are before GST (added at the PLATFORM_FEE_GST rate). enabled: off → the flat registration fee schedule (Admin → Registration fee) applies instead. Each shop keeps the fee it registered with; a change here never alters it. A value saved in the older three-slab form (slab1UpToRupees … slab3FeePaise) is read as the same three slabs.",
    schema: z.preprocess(
      upgradeLegacyTurnoverRule,
      z
        .object({
          enabled: z.boolean(),
          slabs: z
            .array(z.object({ upToRupees: int(1, 1_000_000_000_000).nullable(), feePaise: int(0, 100_000_000) }))
            .min(1)
            .max(MAX_TURNOVER_SLABS),
        })
        .superRefine((v, ctx) => {
          const problem = turnoverSlabsProblem(v.slabs);
          if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["slabs"] });
        }),
    ),
    // Owner, 28 Oct 2026: on — up to ₹2 crore, up to ₹10 crore, above ₹10 crore.
    // The fees are starting values; the admin sets them, and adds slabs, in Admin → Registration fees.
    defaults: {
      enabled: true,
      slabs: DEFAULT_TURNOVER_SLABS,
    },
  },
  shopProductMedia: {
    description:
      "Shop product photos and descriptions (Module 1): photos per shop listing, upload size, the three WebP sizes made from every photo, description lengths, and bulk ZIP/CSV limits. The first photo of a listing is its main photo; a listing with none shows the master product's photos.",
    schema: z.object({
      maxPhotos: int(1, 10),
      maxUploadBytes: int(100_000, 20_000_000),
      minDimensionPx: int(50, 2000),
      maxInputPixels: int(1_000_000, 200_000_000),
      thumbPx: int(64, 800),
      mediumPx: int(200, 2000),
      largePx: int(400, 4000),
      webpQuality: int(40, 100),
      shortDescriptionMax: int(20, 500),
      longDescriptionMax: int(100, 20_000),
      zipMaxBytes: int(1_000_000, 500_000_000),
      zipMaxFiles: int(1, 5000),
      csvMaxRows: int(1, 50_000),
    }),
    defaults: {
      maxPhotos: 5,
      maxUploadBytes: 5 * 1024 * 1024,
      minDimensionPx: 100,
      maxInputPixels: 50_000_000,
      thumbPx: 200,
      mediumPx: 600,
      largePx: 1200,
      webpQuality: 80,
      shortDescriptionMax: 160,
      longDescriptionMax: 4000,
      zipMaxBytes: 50 * 1024 * 1024,
      zipMaxFiles: 500,
      csvMaxRows: 5000,
    },
  },
  catalogue: {
    description: "Shop catalogue: stock given to each product when a shop adds a whole category and its inventory is filled in.",
    schema: z.object({ categoryFillStock: int(0, 100_000) }),
    defaults: { categoryFillStock: 100 },
  },
  uploads: {
    description:
      "File upload limits: spreadsheet size and rows (product, price and voucher sheets) and seller document size, in bytes.",
    schema: z.object({
      spreadsheetMaxBytes: int(100_000, 50_000_000),
      spreadsheetMaxRows: int(10, 100_000),
      sellerDocumentMaxBytes: int(100_000, 50_000_000),
    }),
    defaults: { spreadsheetMaxBytes: 2 * 1024 * 1024, spreadsheetMaxRows: 5_000, sellerDocumentMaxBytes: 5_000_000 },
  },
  productImport: {
    description:
      "Bulk product upload (docs/product-import-2026-10): a shop owner, operator or admin uploads an Amazon Seller Central inventory template, the GoKesari simple template or a CSV to create or update a shop's products and set its stock. maxFileBytes / maxRows bound one file; rows are written batchSize at a time, each batch in its own transaction; product images are downloaded after the import (imageMaxBytes each, imageTimeoutMs per download, at most maxImagesPerRow per row); uploaded files and staged rows are deleted retentionDays after the upload. With enabled off the Bulk Upload screens and API refuse new uploads.",
    schema: z.object({
      enabled: z.boolean(),
      maxFileBytes: int(100_000, 50_000_000),
      maxRows: int(1, 50_000),
      batchSize: int(10, 1000),
      retentionDays: int(1, 3650),
      imageMaxBytes: int(100_000, 20_000_000),
      imageTimeoutMs: int(1000, 120_000),
      maxImagesPerRow: int(0, 20),
    }),
    defaults: {
      enabled: true,
      maxFileBytes: 10 * 1024 * 1024,
      maxRows: 5_000,
      batchSize: 200,
      retentionDays: 90,
      imageMaxBytes: 5 * 1024 * 1024,
      imageTimeoutMs: 15_000,
      maxImagesPerRow: 9,
    },
  },
  opsExceptions: {
    description:
      "Operations exceptions queue: minutes / hours before an order is flagged (and when it becomes critical) at each stage. A dispute becomes critical after the settlement hold; the delivery-code lockout follows deliveryOtp.",
    schema: z.object({
      shopAcceptExpress: int(1, 240),
      shopAcceptOther: int(1, 240),
      shopAcceptCritical: int(1, 1440),
      shopAcceptSubscriptionHours: int(1, 72),
      shopAcceptSubscriptionCriticalHours: int(1, 72),
      prepGraceAfterPrepTime: int(0, 240),
      substitutionWait: int(1, 240),
      noRiderWarning: int(1, 240),
      noRiderCritical: int(1, 480),
      selfDeliveryReady: int(1, 480),
      riderPickupWait: int(1, 240),
      riderStaleLocation: int(1, 120),
      dropNotStarted: int(1, 240),
      outForDeliveryGrace: int(0, 240),
      failedDecisionGrace: int(0, 240),
      returnLegFallback: int(1, 240),
      returnedDecision: int(1, 1440),
      disputeWarningHours: int(1, 720),
      dispatchSweepIntervalSeconds: int(10, 3600),
      legSpeedKmh: int(5, 80),
    }),
    defaults: {
      shopAcceptExpress: 5,
      shopAcceptOther: 10,
      shopAcceptCritical: 30,
      shopAcceptSubscriptionHours: 4,
      shopAcceptSubscriptionCriticalHours: 8,
      prepGraceAfterPrepTime: 10,
      substitutionWait: 10,
      noRiderWarning: 5,
      noRiderCritical: 10,
      selfDeliveryReady: 30,
      riderPickupWait: 20,
      riderStaleLocation: 5,
      dropNotStarted: 10,
      outForDeliveryGrace: 10,
      failedDecisionGrace: 15,
      returnLegFallback: 15,
      returnedDecision: 60,
      disputeWarningHours: 24,
      dispatchSweepIntervalSeconds: 60,
      legSpeedKmh: 20,
    },
  },
  riskRules: {
    description:
      "Fraud / risk flags (GS-068): the counts, windows and amounts at which each rule raises a flag. Flags never act on their own except a HIGH flag pausing cash on delivery.",
    schema: z.object({
      codRefusals: z.object({ count: int(1, 100), days: int(1, 365) }),
      highRefundRate: z.object({ count: int(1, 100), days: int(1, 365), minPercent: int(1, 100) }),
      repeatedDisputes: z.object({ count: int(1, 100), days: int(1, 365) }),
      topupFailures: z.object({ count: int(1, 100), hours: int(1, 720) }),
      sharedPhone: z.object({ accounts: int(2, 100) }),
      highValueOutlier: z.object({
        recentDays: int(1, 90),
        minPaise: int(0, 100_000_000),
        multiple: int(2, 100),
        baselineDays: int(1, 365),
        minPriorOrders: int(1, 100),
        newCustomerPaise: int(0, 1_000_000_000),
      }),
      otpOverrides: z.object({ count: int(1, 100), days: int(1, 365) }),
      otpLockouts: z.object({ count: int(1, 100), days: int(1, 365) }),
      failedDeliveries: z.object({ count: int(1, 100), days: int(1, 365) }),
      codCashOverdueDays: int(1, 90),
      highRejection: z.object({ minOrders: int(1, 1000), percent: int(1, 100), days: int(1, 365) }),
      referralAbuse: z.object({ count: int(1, 100), rejected: int(1, 100), days: int(1, 365) }),
    }),
    defaults: {
      codRefusals: { count: 2, days: 90 },
      highRefundRate: { count: 3, days: 30, minPercent: 50 },
      repeatedDisputes: { count: 2, days: 30 },
      topupFailures: { count: 5, hours: 24 },
      sharedPhone: { accounts: 2 },
      highValueOutlier: { recentDays: 7, minPaise: 200_000, multiple: 5, baselineDays: 90, minPriorOrders: 3, newCustomerPaise: 1_000_000 },
      otpOverrides: { count: 3, days: 30 },
      otpLockouts: { count: 2, days: 30 },
      failedDeliveries: { count: 3, days: 7 },
      codCashOverdueDays: 7,
      highRejection: { minOrders: 10, percent: 30, days: 30 },
      referralAbuse: { count: 3, rejected: 1, days: 30 },
    },
  },
  tracking: {
    description:
      "Live delivery tracking (event layer). Once the rider starts the drop, the rider's phone sends its location every riderPingSeconds and the customer's open tracking map refreshes every buyerPollSeconds. Location is shown only to the order's customer, its shop and support, and is no longer accepted or shown once the order is delivered or cancelled.",
    schema: z.object({
      riderPingSeconds: int(5, 60),
      buyerPollSeconds: int(5, 60),
    }),
    defaults: { riderPingSeconds: 5, buyerPollSeconds: 5 },
  },
  /* -------------------------------- docs/four-features-2026-10 (all off by default) */
  fulfilmentOptions: {
    description:
      "Fulfilment options. When enabled, a shop marking an order ready chooses customer pickup (completed with a pickup code the customer shows), its own delivery person (the existing delivery-code completion) or a GoKesari delivery partner (the existing rider dispatch), with a date and time slot. Slots are slotMinutes long between firstSlotHour and lastSlotHour (IST), up to maxDaysAhead days ahead. A GoKesari delivery scheduled later starts its rider search gokesariLeadMinutes before the slot. With refundDeliveryFeeOnPickup, choosing pickup gives the customer their delivery fee back once (to the wallet; a cash order is charged that much less).",
    schema: z
      .object({
        enabled: z.boolean(),
        slotMinutes: z.union([z.literal(30), z.literal(60), z.literal(120)]),
        firstSlotHour: int(0, 23),
        lastSlotHour: int(1, 24),
        maxDaysAhead: int(0, 30),
        gokesariLeadMinutes: int(0, 240),
        refundDeliveryFeeOnPickup: z.boolean(),
      })
      .refine((v) => v.lastSlotHour > v.firstSlotHour, {
        message: "The last slot must end after the first one starts.",
        path: ["lastSlotHour"],
      }),
    defaults: { enabled: false, slotMinutes: 60, firstSlotHour: 7, lastSlotHour: 22, maxDaysAhead: 7, gokesariLeadMinutes: 45, refundDeliveryFeeOnPickup: true },
  },
  legalDocuments: {
    description:
      "Mandatory legal documents by shop category. When enabled, a shop that sells food needs an FSSAI licence, a pharmacy a drug licence and a doctor / clinic a medical registration (number, expiry or issuing council, and an uploaded copy). A new shop cannot be approved until they are submitted; a live shop gets graceDays to upload before it can no longer accept orders. Owners are reminded expiryReminderDays before a licence expires. The shop types and shop-category slugs that need each document are listed here. otherRequirements makes an optional licence (trade licence, legal metrology, fire NOC, seeds / fertiliser / pesticide) mandatory for the shop types or categories it lists; empty, they stay optional.",
    schema: z.object({
      enabled: z.boolean(),
      graceDays: int(0, 90),
      expiryReminderDays: int(1, 120),
      drugLicenceShopTypes: z.array(z.string().max(60)).max(20),
      drugLicenceCategorySlugs: z.array(z.string().max(80)).max(50),
      medicalRegistrationShopTypes: z.array(z.string().max(60)).max(20),
      medicalRegistrationCategorySlugs: z.array(z.string().max(80)).max(50),
      /** On top of the food detection seller verification already uses (food shop types and food aisles). */
      fssaiExtraCategorySlugs: z.array(z.string().max(80)).max(50),
      /**
       * The optional licences (trade licence, legal metrology, fire NOC, seeds / fertiliser /
       * pesticide) made mandatory for some shop types or category slugs. Empty: all optional.
       */
      otherRequirements: z
        .array(
          z.object({
            docType: z.enum(["TRADE_LICENCE", "LEGAL_METROLOGY", "FIRE_NOC", "AGRI_INPUT_LICENCE"]),
            shopTypes: z.array(z.string().max(60)).max(20),
            categorySlugs: z.array(z.string().max(80)).max(50),
          }),
        )
        .max(20),
    }),
    defaults: {
      enabled: false,
      graceDays: 15,
      expiryReminderDays: 30,
      drugLicenceShopTypes: ["PHARMACY"],
      drugLicenceCategorySlugs: ["pharmacy"],
      medicalRegistrationShopTypes: [],
      medicalRegistrationCategorySlugs: ["doctor-clinic"],
      fssaiExtraCategorySlugs: [],
      otherRequirements: [],
    },
  },
  shopMembership: {
    description:
      "Shop membership (D-69). Recording a registration fee or renewal payment extends the shop's membership by periodMonths (from the end of the current one, or from the payment when that has passed). When enabled, a shop whose membership ended more than graceDays ago is not online: customers see it as not taking orders and cannot check out from it, until a renewal is recorded. Shops with no end date (every shop registered before this rule, and shops that never paid a fee) are never affected. reminderDays: the owner's shop page warns this many days before the end.",
    schema: z.object({ enabled: z.boolean(), periodMonths: int(1, 60), graceDays: int(0, 90), reminderDays: int(0, 90) }),
    defaults: { enabled: true, periodMonths: 12, graceDays: 15, reminderDays: 30 },
  },
  bankAccounts: {
    description:
      "Bank account verification. When enabled, shop owners and customers are prompted to add a bank account (holder name, account number and IFSC, or a UPI ID) and verify it with a payment of verificationAmountPaise through the payment gateway (UPI, debit card, credit card or net banking), refunded automatically. requireVerifiedForShopPayouts stops a shop settlement being sent to the bank or marked paid until the shop has a verified account. nameMatchThreshold is the name-match score (0–100) needed when the gateway reports the payer's name.",
    schema: z.object({
      enabled: z.boolean(),
      verificationAmountPaise: int(100, 1000),
      requireVerifiedForShopPayouts: z.boolean(),
      requireVerifiedForBankRefunds: z.boolean(),
      nameMatchThreshold: int(50, 100),
      maxAttemptsPerDay: int(1, 20),
    }),
    defaults: {
      enabled: false,
      verificationAmountPaise: 100,
      requireVerifiedForShopPayouts: false,
      requireVerifiedForBankRefunds: true,
      nameMatchThreshold: 80,
      maxAttemptsPerDay: 5,
    },
  },
  bankRefunds: {
    description:
      "Refunds to a customer's bank. When enabled, a customer can have a refund (its customer-funded part, never promotional credit) sent to their bank account instead of keeping it in the wallet, within windowDays of the refund. The amount leaves the wallet at once; finance sends it from the bank and records the reference (Admin → Refunds to bank), or marks it failed and it returns to the wallet. bankAccounts.requireVerifiedForBankRefunds decides whether the account must be verified first. Update the Wallet Terms and Refund Policy before switching this on.",
    schema: z.object({
      enabled: z.boolean(),
      windowDays: int(1, 365),
      minAmountPaise: int(100, 1_000_000),
      /** Shown to the customer: when to expect the money. */
      expectedWorkingDays: int(1, 30),
    }),
    defaults: { enabled: false, windowDays: 30, minAmountPaise: 100, expectedWorkingDays: 5 },
  },
  shopReferral: {
    description:
      "Shop registration referral code requests. `required` is no longer read: whether a code is mandatory is the admin's Referral settings (Settings → Referral settings, referral_required_shop). Owners without one can request a code: the request is saved and emailed to notifyEmails; a second request from the same mobile within duplicateWindowHours is refused.",
    schema: z.object({
      required: z.boolean(),
      duplicateWindowHours: int(1, 720),
      notifyEmails: z.array(z.string().email()).min(1).max(5),
    }),
    defaults: { required: false, duplicateWindowHours: 24, notifyEmails: ["referrals@gokesari.com"] },
  },
  customerSignupReferral: {
    description:
      "Referral code at customer registration. `enabled` and `required` are no longer read: the code is always asked, and whether it is mandatory is the admin's Referral settings (Settings → Referral settings, referral_required_customer). A new customer's first-time setup asks for a referral code and checks it: a code GoKesari issued (Admin → Referral codes, the same codes shop registration uses) is recorded against the customer; a friend's code (customerReferrals on) starts the friend reward. Only before the customer's first order. With required on, a customer needs a code before their first order (checkout and new subscriptions are refused without one; browsing and search stay open); requiredFrom (YYYY-MM-DD, IST) limits that to customers who joined on or after the date, so existing customers are not stopped — leave it empty to require it of every customer without an order. A customer without a code can request one (location, PIN code, city, contact number), emailed to shopReferral.notifyEmails — one request per customer or mobile within requestDuplicateWindowHours.",
    schema: z.object({
      enabled: z.boolean(),
      required: z.boolean(),
      requiredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").nullable(),
      requestDuplicateWindowHours: int(1, 720),
    }),
    defaults: { enabled: false, required: false, requiredFrom: null, requestDuplicateWindowHours: 24 },
  },
  bankAccountCheck: {
    description:
      "Bank account check with Cashfree's Verification Suite (the owner's decision O-7). When enabled and the Verification Suite keys are set (CASHFREE_VERIFICATION_CLIENT_ID / _CLIENT_SECRET, or _APP_ID / _SECRET_KEY), a bank account (account number + IFSC) is checked with the bank as soon as it is saved: the bank says whether it is valid and whose name it is in. A valid account whose name matches (Cashfree's match, or bankAccounts.nameMatchThreshold) is verified at once, without the ₹1 payment; an invalid account or a name mismatch fails with the reason and the bank's name. Errors leave the account to the ₹1 check, as before. UPI IDs keep the ₹1 check. maxChecksPerDay limits checks per person (each costs a fee).",
    schema: z.object({ enabled: z.boolean(), maxChecksPerDay: int(1, 20) }),
    defaults: { enabled: false, maxChecksPerDay: 3 },
  },
  documentUpload: {
    description:
      "Shop document upload with auto-read (docs/document-upload-2026-10). With enabled on, shop registration shows \"Upload your documents\": the owner uploads a file or takes a photo of each mandatory document, the server reads it (number, name, address, validity), the owner reviews and clicks Verify & Approve. Unreadable, expired or wrong documents are refused with a request to re-upload; a name that scores below nameMatchWarnBelow (0–100) against the registered owner / shop name is flagged for the admin. With fssaiMandatoryForFood on, a food shop (dairy, bakery, grocery, sweets, fruits & vegetables, restaurants and the other food types, or any food aisle) cannot complete registration — profile completion or approval — without an FSSAI licence on file that has not expired. maxUploadsPerShopPerHour limits reads per shop; unconfirmed uploads are erased after draftRetentionDays.",
    schema: z.object({
      enabled: z.boolean(),
      fssaiMandatoryForFood: z.boolean(),
      nameMatchWarnBelow: int(0, 100),
      maxUploadBytes: int(500_000, 10_000_000),
      maxUploadsPerShopPerHour: int(1, 200),
      draftRetentionDays: int(1, 90),
    }),
    defaults: { enabled: true, fssaiMandatoryForFood: true, nameMatchWarnBelow: 70, maxUploadBytes: 10_000_000, maxUploadsPerShopPerHour: 30, draftRetentionDays: 7 },
  },
  /* >>> batch-2026-10 WS-A (payments, OTP, reference prices) — add entries below this line only */
  /** F1.7.3 / F1.8.4 (GS-028, NEW-007, SM-005): orders paid directly at a payment gateway. */
  onlinePayments: {
    description:
      "Pay online (UPI / card / netbanking) at checkout through the payment gateway chosen by PAYMENT_GATEWAY. " +
      "PRODUCTION STAYS OFF until the gateway is chosen, the merchant account is open, and the live keys and the webhook secret are set " +
      "(see docs/payments-gateway-2026-10.md). On staging it runs against the sandbox gateway. Off: checkout offers wallet and cash on delivery exactly as before.",
    schema: z.object({
      enabled: z.boolean(),
      /** Methods offered on the gateway page. */
      methods: z.array(z.enum(["UPI", "CARD", "NETBANKING"])).min(1).max(3),
      /** How long the customer has to pay before the attempt expires (and the order's stock is released). */
      intentExpiryMinutes: int(5, 1440),
      /** An attempt still CREATED / PENDING this long after it started is checked with the gateway by the reconciliation job. */
      reconcileAfterMinutes: int(1, 1440),
      /** The job stops asking about an attempt (and a refund) after this many checks; support is alerted instead. */
      maxReconcileAttempts: int(1, 500),
      /** The sandbox gateway is refused in production unless PAYMENT_GATEWAY=SANDBOX and this is on. */
      allowSandboxInProduction: z.boolean(),
    }),
    defaults: {
      enabled: false,
      methods: ["UPI", "CARD", "NETBANKING"],
      intentExpiryMinutes: 15,
      reconcileAfterMinutes: 10,
      maxReconcileAttempts: 48,
      allowSandboxInProduction: false,
    },
  },
  /** F1.1.2 (GS-001, GS-074): clean-up of used and expired sign-in codes. */
  otpHousekeeping: {
    description:
      "Expired and used one-time codes are deleted by the auth-housekeeping job after this many hours (the audit log keeps the record). " +
      "Keep it at least as long as the otp rule's resend window, which counts recent codes.",
    schema: z.object({
      purgeEnabled: z.boolean(),
      retainHours: int(1, 24 * 90),
    }),
    defaults: { purgeEnabled: true, retainHours: 24 },
  },
  /* <<< end WS-A */
  //
  /* >>> batch-2026-10 WS-B (dispatch, QR pickup, navigation) — add entries below this line only */
  dispatchBroadcast: {
    description:
      "Broadcast rider offers (F3.3.2). Off (default): one rider at a time, as before. On: when the rider offered an order has not accepted within singleOfferSeconds (or dispatch.offerTtlSeconds, if shorter), the offer goes to every eligible rider (approved, online, free — or busy within the dispatch busy-rider fallback — not among those who declined it, and allowed by the society) within the first radius in radiiKm around the shop. Every stepSeconds the radius widens to the next value, up to maxRadiusKm, adding at most maxRecipientsPerStep riders per step. The first rider to accept gets the order; everyone else sees \"Offer taken\" (for takenNoticeSeconds). After the last step nobody accepted: the normal rider search carries on. Riders' dashboards check for open offers every riderPollSeconds. Run by the timeout-sweep job (every minute).",
    schema: z
      .object({
        enabled: z.boolean(),
        /** How long the first, single rider has before the offer is broadcast. */
        singleOfferSeconds: int(15, 900),
        /** Broadcast radii around the shop, smallest first, one per step (km). */
        radiiKm: z.array(z.number().min(0.5).max(50)).min(1).max(10),
        /** How long each radius step stays open before the next (or, after the last, the broadcast ends). */
        stepSeconds: int(15, 900),
        /** Radii beyond this are not used. */
        maxRadiusKm: z.number().min(0.5).max(50),
        /** Most riders newly reached in one step (nearest first). */
        maxRecipientsPerStep: int(1, 200),
        /** How often an open rider dashboard checks for broadcast offers. */
        riderPollSeconds: int(3, 60),
        /** How long a rider still sees "Offer taken" after another rider accepted. */
        takenNoticeSeconds: int(10, 900),
      })
      .refine((v) => v.radiiKm.every((r, i) => i === 0 || r > v.radiiKm[i - 1]), {
        message: "List the radii smallest first, each larger than the one before.",
        path: ["radiiKm"],
      }),
    defaults: {
      enabled: false,
      singleOfferSeconds: 60,
      radiiKm: [2, 4, 6],
      stepSeconds: 60,
      maxRadiusKm: 6,
      maxRecipientsPerStep: 20,
      riderPollSeconds: 10,
      takenNoticeSeconds: 120,
    },
  },
  pickupQr: {
    description:
      "Pickup by QR code (F4.1.3). Off (default): the rider types the 4-digit pickup code the shop reads out, as before. On: every packed order (ready or rider assigned) shows a signed, single-use QR on the shop's order screen and its printable packing slip; the rider scans it with the phone camera to confirm pickup (the scan's time and the rider's location are recorded and the customer is told at once). A QR stops working after tokenTtlMinutes, once used, or when the order is no longer waiting for pickup. The typed code always remains as a fallback. With requireGps on, a scan without the rider's location is refused (the code still works). Needs the secret PICKUP_QR_SECRET in production.",
    schema: z.object({
      enabled: z.boolean(),
      tokenTtlMinutes: int(10, 2880),
      requireGps: z.boolean(),
    }),
    defaults: { enabled: false, tokenTtlMinutes: 720, requireGps: false },
  },
  riderNavigation: {
    description:
      "In-app turn-by-turn navigation for riders (F4.2.2). Off (default): riders get the \"Navigate\" links that open Google Maps, as before. On: the rider's delivery has an in-app navigation screen — the route to the shop, then to the customer (the customer's exact location only after pickup), next turn, remaining distance and time, voice prompts (voiceDefaultOn), and a fresh route when the rider is more than offRouteMeters off it (at most once per rerouteCooldownSeconds). provider: mock (straight line, for testing/offline), google (Routes API with GOOGLE_MAPS_SERVER_API_KEY) or osrm (an OSRM-compatible server at osrmBaseUrl). Routes are cached for cacheSeconds; a provider failure falls back to the straight-line route. \"Open in Google Maps\" always stays available.",
    schema: z.object({
      enabled: z.boolean(),
      provider: z.enum(["mock", "google", "osrm"]),
      osrmBaseUrl: z.string().url(),
      offRouteMeters: int(20, 1000),
      rerouteCooldownSeconds: int(5, 600),
      voiceDefaultOn: z.boolean(),
      cacheSeconds: int(0, 3600),
      timeoutMs: int(500, 10_000),
    }),
    defaults: {
      enabled: false,
      provider: "mock",
      osrmBaseUrl: "https://router.project-osrm.org",
      offRouteMeters: 60,
      rerouteCooldownSeconds: 20,
      voiceDefaultOn: true,
      cacheSeconds: 60,
      timeoutMs: 4000,
    },
  },
  /* <<< end WS-B */
  //
  /* >>> batch-2026-10 WS-C (cancellation fee, refunds, help desk) — add entries below this line only */
  afterPackingCancellation: {
    description:
      "F6.1.3 (NEW-006, D10): a customer may cancel an order AFTER it is packed (Ready, or a rider assigned) for a delivery/handling fee, shown before they confirm. Off: the original rule (packed orders cannot be cancelled by the customer). The default fee is FLAT (defaultFeePaise) or PERCENT of the goods (defaultFeeBp, 1000 = 10%) capped at defaultCapPaise. With shopOverrideAllowed, a shop owner sets its own fee within maxFeePaise / maxFeeBp (the server refuses anything higher; a lower limit set later also caps existing shop fees). The fee is never more than what was paid, is written to the order ledger, and goes to feeBeneficiary (SHOP: paid in its next settlement; PLATFORM: platform revenue). Cancelling before packing stays a full refund; after pickup the customer's goods-only refund is unchanged (the fee is not added on top).",
    schema: z.object({
      enabled: z.boolean(),
      defaultFeeType: z.enum(["FLAT", "PERCENT"]),
      defaultFeePaise: int(0, 1_000_000),
      defaultFeeBp: int(0, 10_000),
      defaultCapPaise: int(0, 1_000_000),
      shopOverrideAllowed: z.boolean(),
      maxFeePaise: int(0, 1_000_000),
      maxFeeBp: int(0, 10_000),
      feeBeneficiary: z.enum(["SHOP", "PLATFORM"]),
    }),
    defaults: {
      enabled: false,
      defaultFeeType: "FLAT",
      defaultFeePaise: 2_000,
      defaultFeeBp: 1_000,
      defaultCapPaise: 5_000,
      shopOverrideAllowed: true,
      maxFeePaise: 10_000,
      maxFeeBp: 2_000,
      feeBeneficiary: "SHOP",
    },
  },
  refundChoice: {
    description:
      "F6.2.3 (GS-073): where a customer's refund goes. The GoKesari wallet is always available and instant. originalMethodEnabled lets a customer whose order was paid online have the refund sent back to the original payment method through the payment gateway (keep OFF until a live gateway is configured). Orders paid from the wallet or in cash always refund to the wallet. A gateway refund is tried up to maxGatewayAttempts times by the aftercare job; if it still fails and fallbackToWallet is on, the amount is credited to the wallet instead. The customer is told of every refund status by email and push.",
    schema: z.object({
      originalMethodEnabled: z.boolean(),
      maxGatewayAttempts: int(1, 10),
      fallbackToWallet: z.boolean(),
    }),
    defaults: { originalMethodEnabled: false, maxGatewayAttempts: 3, fallbackToWallet: true },
  },
  helpdesk: {
    description:
      "F6.3.3 (SM-006): help desk and grievance portal. Consumer Protection (E-Commerce) Rules, 2020, Rule 4: acknowledge a complaint within 48 hours and redress it within one month of receipt — acknowledgeWithinHours / resolveWithinDays set the SLA clock each ticket gets when it is received (the clock is not paused while waiting for a reply). With escalateOnBreach, the hourly help-desk job escalates a ticket that misses either deadline and alerts administrators. A resolved ticket closes itself after autoCloseResolvedAfterDays; the requester may reopen it within reopenWithinDays of resolution. csatEnabled asks for a 1–5 rating when a ticket closes. ticketForGrievances: a complaint filed on the grievance form also opens a linked ticket (its GRV- number is kept). maxAttachmentBytes / maxAttachmentsPerTicket limit files (photos or PDF).",
    schema: z.object({
      enabled: z.boolean(),
      acknowledgeWithinHours: int(1, 48),
      resolveWithinDays: int(1, 30),
      escalateOnBreach: z.boolean(),
      autoCloseResolvedAfterDays: int(1, 60),
      reopenWithinDays: int(1, 60),
      csatEnabled: z.boolean(),
      ticketForGrievances: z.boolean(),
      maxAttachmentBytes: int(100_000, 10_000_000),
      maxAttachmentsPerTicket: int(1, 20),
    }),
    defaults: {
      enabled: true,
      acknowledgeWithinHours: 48,
      resolveWithinDays: 30,
      escalateOnBreach: true,
      autoCloseResolvedAfterDays: 7,
      reopenWithinDays: 14,
      csatEnabled: true,
      ticketForGrievances: true,
      maxAttachmentBytes: 5_000_000,
      maxAttachmentsPerTicket: 10,
    },
  },
  grievanceOfficer: {
    description:
      "The Grievance Officer shown on the Grievance Redressal page, the Contact page and the support portal, and checked on the compliance dashboard (IT Rules 2021 / Consumer Protection (E-Commerce) Rules 2020, Rule 4). A field left empty falls back to the value in src/lib/legal-docs.ts.",
    schema: z.object({
      name: z.string().max(120),
      designation: z.string().max(120),
      email: z.union([z.string().email(), z.literal("")]),
      phone: z.string().max(30),
      address: z.string().max(400),
      hours: z.string().max(200),
    }),
    defaults: {
      name: "Sonali",
      designation: "Grievance Officer",
      email: "grievance@gokesari.com",
      phone: "9175193009",
      address: "Flat No B-1102, Yin Yang CHS, Opp EoN IT Park Phase II, Kharadi, Pune 411014",
      hours: "Monday to Saturday, 10:00 am – 6:00 pm IST",
    },
  },
  /* <<< end WS-C */
  //
  /* >>> batch-2026-10 WS-D (operator-limited, product master data) — add entries below this line only */
  operatorLimited: {
    description:
      "Operator-Limited shop onboarding (F8.4.2). An Operator-Limited user onboards a shop for its owner only after the owner reads back the code emailed to them: the verified code is good for consentValidMinutes. The registration fee is paid online — a payment link emailed to the owner (valid paymentLinkExpiryHours) or in session. A fee that fails or whose link expires leaves the shop PENDING_APPROVAL for an administrator, who is told at once.",
    schema: z.object({
      consentValidMinutes: int(5, 1440),
      paymentLinkExpiryHours: int(1, 720),
    }),
    defaults: { consentValidMinutes: 60, paymentLinkExpiryHours: 72 },
  },
  pmdSources: {
    description:
      "Product master data sources and large imports (F9.1.2 / F9.1.4). manufacturerPortalEnabled: manufacturers upload their catalogue at /manufacturer or by API key (apiRequestsPerMinute per key). gs1Enabled: GS1 India DataKart look-ups (a mock answers until GS1_DATAKART_API_KEY / GS1_DATAKART_BASE_URL are set; the mock never runs in production). openFoodFactsEnabled: Open Food Facts barcode look-ups for packaged food — ODbL 1.0, offAttribution is stored with every record. Imports are staged and processed ingestBatchSize rows at a time by the pmd-ingest worker (ingestBatchesPerTick per run), resumable after an interruption; maxRowsPerFile caps one file. With imagesEnabled, image URLs are fetched (public addresses only), resized to imageMaxEdgePx and kept in the object store.",
    schema: z.object({
      manufacturerPortalEnabled: z.boolean(),
      gs1Enabled: z.boolean(),
      openFoodFactsEnabled: z.boolean(),
      offAttribution: z.string().min(10).max(500),
      offRequestsPerMinute: int(1, 600),
      apiRequestsPerMinute: int(1, 6000),
      maxRowsPerFile: int(100, 1_000_000),
      ingestBatchSize: int(10, 10_000),
      ingestBatchesPerTick: int(1, 1000),
      imagesEnabled: z.boolean(),
      imageMaxEdgePx: int(100, 4000),
      imageMaxBytes: int(100_000, 20_000_000),
      imagesPerRow: int(0, 10),
    }),
    defaults: {
      manufacturerPortalEnabled: true,
      gs1Enabled: false,
      openFoodFactsEnabled: false,
      offAttribution:
        "Data from Open Food Facts (https://world.openfoodfacts.org), © Open Food Facts contributors, available under the Open Database License (ODbL 1.0); product images under CC BY-SA.",
      offRequestsPerMinute: 60,
      apiRequestsPerMinute: 60,
      maxRowsPerFile: 200_000,
      ingestBatchSize: 1000,
      ingestBatchesPerTick: 5,
      imagesEnabled: true,
      imageMaxEdgePx: 800,
      imageMaxBytes: 5_000_000,
      imagesPerRow: 3,
    },
  },
  objectStore: {
    description:
      "Where imported product images are kept. Off: the platform's own store (database, or MEDIA_DIR on disk). s3Enabled: an S3-compatible bucket configured by OBJECT_STORE_ENDPOINT, OBJECT_STORE_BUCKET, OBJECT_STORE_REGION, OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY (ignored until all are set).",
    schema: z.object({ s3Enabled: z.boolean() }),
    defaults: { s3Enabled: false },
  },
  inventorySync: {
    description:
      "Inventory / accounting-software sync (Module 2: Tally, Odoo, Zoho Books…). Descoped — stock is the shop owner's responsibility. Off: the integration-sync job, automatic dispatch and the desktop connector stop, and the connect screen is hidden. No connection or data is deleted; switching it on resumes everything.",
    schema: z.object({ enabled: z.boolean() }),
    defaults: { enabled: false },
  },
  /* <<< end WS-D */
  //
  /* >>> batch-2026-10 WS-E (invoicing, payouts, statutory) — add entries below this line only */
  invoiceDelivery: {
    description:
      "F9.2.6 customer invoice extras (needs invoicing.enabled). Off: invoices are issued and shown exactly as before. On: the invoice PDF carries a QR code (the e-invoice signed QR when an IRN exists, else a B2C QR with the supplier GSTIN/PAN, invoice number, date, value and tax), a supplier without GSTIN is described as unregistered / PAN-only (or composition) on the bill of supply, the place of supply is the delivery address's state (from the PIN code when the address has no state; the shop's state for pickups — when it is truly unknown the shop's state is used and the invoice says so), the customer is emailed the PDF (emailCustomer) and the shop owner gets a copy with the order (copyToShopOwner), and a cancelled or fully refunded invoiced order gets a credit note (creditNoteOnCancellation). emailMaxAttempts: tries per email before it is given up. Confirm wording with the CA.",
    schema: z.object({
      enabled: z.boolean(),
      qrOnPdf: z.boolean(),
      emailCustomer: z.boolean(),
      copyToShopOwner: z.boolean(),
      pincodeStateLookup: z.boolean(),
      creditNoteOnCancellation: z.boolean(),
      emailMaxAttempts: int(1, 10),
    }),
    defaults: {
      enabled: false,
      qrOnPdf: true,
      emailCustomer: true,
      copyToShopOwner: true,
      pincodeStateLookup: true,
      creditNoteOnCancellation: true,
      emailMaxAttempts: 5,
    },
  },
  payouts: {
    description:
      "F10.2.4 automated shop payouts. Off (default): the weekly settlement batches under Admin → Finance are used, unchanged. On: every cycleDays days counted from anchorDate (YYYY-MM-DD, IST) the payout-cycle job closes the cycle — delivered orders held at least holdDays, pending refunds and adjustments, minus commission, GST on GoKesari's fees (when platformInvoicing is on), TCS and TDS (Admin → Statutory) — and drafts one payout batch (one item per shop). With makerChecker on, the person who created a batch cannot approve it. provider: BANK_FILE (download a bank bulk-upload file and mark each payment paid with its UTR), SANDBOX (simulated transfers and webhooks — never on gokesari.com), RAZORPAYX or CASHFREE (need their keys). Only shops with a verified bank account are paid; others, and amounts below minPayoutPaise, are held and carried into the next cycle. Failed transfers are retried retryMaxAttempts times, retryBackoffMinutes × attempt apart. transferMode is the bank rail (RTGS is used automatically from rtgsFromPaise). walletTopUpTargetPaise > 0: a shop whose prepaid wallet is below this is topped up from its payout. debitAccountNumber is GoKesari's account printed in the bank file.",
    schema: z.object({
      enabled: z.boolean(),
      cycleDays: int(1, 31),
      anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
      holdDays: int(0, 60),
      makerChecker: z.boolean(),
      retryMaxAttempts: int(1, 10),
      retryBackoffMinutes: int(1, 1440),
      minPayoutPaise: int(0, 10_000_000),
      provider: z.enum(["BANK_FILE", "SANDBOX", "RAZORPAYX", "CASHFREE"]),
      transferMode: z.enum(["NEFT", "IMPS", "RTGS"]),
      rtgsFromPaise: int(0, 1_000_000_000),
      sandboxAutoWebhook: z.boolean(),
      statementEmail: z.boolean(),
      walletTopUpTargetPaise: int(0, 100_000_000),
      debitAccountNumber: z.string().max(34),
    }),
    defaults: {
      enabled: false,
      // Weekly, every Saturday morning (owner, 19 Oct 2026): 17 Oct 2026 is a Saturday.
      cycleDays: 7,
      anchorDate: "2026-10-17",
      holdDays: 2,
      makerChecker: true,
      retryMaxAttempts: 3,
      retryBackoffMinutes: 30,
      minPayoutPaise: 100,
      provider: "BANK_FILE",
      transferMode: "NEFT",
      rtgsFromPaise: 20_000_000,
      sandboxAutoWebhook: true,
      statementEmail: true,
      walletTopUpTargetPaise: 0,
      debitAccountNumber: "",
    },
  },
  platformInvoicing: {
    description:
      "F10.2.5 GoKesari's own tax invoice to each shop for its fees (commission, delivery charges, registration fees, billing/inventory management), one per payout cycle, with credit and debit notes and a monthly GSTR-1-ready export. Keep OFF on production until GoKesari's GSTIN, legal name, address, state and invoice prefix are entered in platformTaxProfile and the CA has confirmed the SAC codes and rates (Admin → Statutory). When on, the GST on fees is deducted from the shop's payout. billingManagementFeePaise: a fixed inventory/billing management charge per shop per cycle (0 = none). includeRegistrationFees: registration fees the shop paid during the cycle are invoiced too (their GST is inside what was paid, so nothing more is deducted).",
    schema: z.object({
      enabled: z.boolean(),
      billingManagementFeePaise: int(0, 10_000_000),
      includeRegistrationFees: z.boolean(),
    }),
    defaults: { enabled: false, billingManagementFeePaise: 0, includeRegistrationFees: true },
  },
  platformTaxProfile: {
    description:
      "GoKesari's own GST identity for its invoices to shops: legal and trade name, GSTIN, PAN, registered address and two-letter state code (e.g. MH), and the document series prefixes (1–4 capital letters/digits; numbers read GKP/2627/000001 — at most 16 characters, unique per financial year). sacCodes: the SAC printed for each fee type (CA to confirm; defaults: 998599 other support services for commission, platform and registration fees, 996813 local delivery services for delivery charges, 998319 other IT services for billing/inventory management). GST rates by fee type are dated under Admin → Statutory (PLATFORM_FEE_GST).",
    schema: z.object({
      legalName: z.string().max(200),
      tradeName: z.string().max(200),
      gstin: z.string().max(15),
      pan: z.string().max(10),
      address: z.string().max(400),
      stateCode: z.string().max(2),
      email: z.string().max(200),
      invoicePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/, "1–4 capital letters or digits."),
      creditNotePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/, "1–4 capital letters or digits."),
      debitNotePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/, "1–4 capital letters or digits."),
      sacCodes: z.object({
        COMMISSION: z.string().regex(/^\d{4,8}$/),
        DELIVERY_CHARGE: z.string().regex(/^\d{4,8}$/),
        PLATFORM_FEE: z.string().regex(/^\d{4,8}$/),
        REGISTRATION_FEE: z.string().regex(/^\d{4,8}$/),
        BILLING_MANAGEMENT: z.string().regex(/^\d{4,8}$/),
      }),
    }),
    defaults: {
      // GoKesari's registered entity (owner, 19 Oct 2026); the PAN is characters 3-12 of the GSTIN.
      legalName: LEGAL_ENTITY.legalName,
      tradeName: "GoKesari",
      gstin: LEGAL_ENTITY.gstin,
      pan: LEGAL_ENTITY.gstin.slice(2, 12),
      address: LEGAL_ENTITY.registeredAddress,
      stateCode: "MH",
      email: "",
      invoicePrefix: "GKP",
      creditNotePrefix: "GKC",
      debitNotePrefix: "GKD",
      sacCodes: {
        COMMISSION: "998599",
        DELIVERY_CHARGE: "996813",
        PLATFORM_FEE: "998599",
        REGISTRATION_FEE: "998599",
        BILLING_MANAGEMENT: "998319",
      },
    },
  },
  /* <<< end WS-E */
  //
  /* >>> batch-2026-10 WS-F (notifications, push, broadcasts, mobile) — add entries below this line only */
  push: {
    description:
      "Mobile app push notifications (F13.1.2). With enabled off (the default) PUSH deliveries are skipped exactly as before. With it on, the PUSH channel sends through `provider`: mock (written to the test outbox at /admin/test-messages — refused on gokesari.com) or expo (Expo's push service; set EXPO_ACCESS_TOKEN if the Expo project requires access tokens). Push is on by default, for people who have the app signed in, in the categories listed in defaultOnCategories; everyone can switch it off per category in their notification settings. Expo's delivery receipts are checked receiptDelayMinutes after sending (cron push-receipts); a phone Expo reports as no longer registered stops receiving pushes.",
    schema: z.object({
      enabled: z.boolean(),
      provider: z.enum(["mock", "expo"]),
      defaultOnCategories: z.array(
        z.enum(["ORDERS", "RETURNS", "DELIVERY", "SHOP", "WALLET", "SUBSCRIPTIONS", "COMMUNITY", "ACCOUNT_SECURITY", "GENERAL", "ANNOUNCEMENTS"]),
      ),
      /** Expo asks to wait ~15 minutes before reading receipts. */
      receiptDelayMinutes: int(1, 1440),
      /** Active devices per person; registering one more retires the least recently seen. */
      maxDevicesPerUser: int(1, 50),
      /** Android notification channel the app creates (mobile/src/push.ts). */
      androidChannelId: z.string().min(1).max(64),
    }),
    defaults: {
      enabled: false,
      provider: "mock",
      defaultOnCategories: ["ORDERS", "RETURNS", "DELIVERY", "SHOP", "WALLET", "SUBSCRIPTIONS", "ACCOUNT_SECURITY", "ANNOUNCEMENTS"],
      receiptDelayMinutes: 15,
      maxDevicesPerUser: 10,
      androidChannelId: "default",
    },
  },
  broadcasts: {
    description:
      "Broadcast announcements (F3.3.2, /admin/broadcasts): admins and operators send a title, message, optional image and link to all customers, shop owners and/or riders, optionally only in some cities or PIN codes, now or at a scheduled time, with an expiry after which it disappears from the notification centre. Everyone gets it in the app; push and email follow each person's notification settings for \"Announcements\". Sending runs in chunks of chunkSize people: \"Send now\" writes up to immediateChunks chunks at once and the broadcast-dispatch job (every minute) writes the rest, up to dispatchChunksPerRun chunks per run. defaultExpiryDays fills in the expiry when none is given (0 = never expires).",
    schema: z.object({
      enabled: z.boolean(),
      chunkSize: int(10, 2000),
      immediateChunks: int(0, 20),
      dispatchChunksPerRun: int(1, 200),
      defaultExpiryDays: int(0, 365),
    }),
    defaults: { enabled: true, chunkSize: 200, immediateChunks: 2, dispatchChunksPerRun: 25, defaultExpiryDays: 30 },
  },
  /* <<< end WS-F */
  //
  /* >>> homepage UI/UX upgrade (docs/homepage-uiux-2026-10) */
  homeDiscovery: {
    description:
      "Home page layout (docs/homepage-uiux-2026-10). On: the product-discovery home — search with suggestions, hero banners (Admin → Home banners), categories, shops near you, Buy again / Popular in your area, Sell and Deliver links — with account items in the header menu and, on phones, a side drawer, bottom navigation and a floating cart bar. Off: the previous Tile Board home returns (nothing else changes). bannerSeconds: how long each banner shows before the next.",
    schema: z.object({ enabled: z.boolean(), bannerSeconds: int(3, 30) }),
    defaults: { enabled: true, bannerSeconds: 6 },
  },
  /* <<< end homepage UI/UX upgrade */
  //
  /* >>> gig worker flow (docs/gig-worker-2026-10) */
  riderVerification: {
    description:
      "Delivery partner verification (gig worker flow, docs/gig-worker-2026-10). gateAvailability — on: a partner can switch to Active or Ready only once their PAN and Aadhaar are Verified and their police verification form (and, with requireCharacterCertificate, their character certificate) is Approved, unless an admin overrides it for that partner; off: approved partners go online as before. maxDocumentBytes — largest police verification form or character certificate (PDF, JPG or PNG). aadhaarOtpMaxAttempts — wrong Aadhaar OTPs before the partner must ask for a new one (legacy OTP method only). aadhaarMethod — \"digilocker\": the partner shares their Aadhaar from DigiLocker (signs in there with an Aadhaar OTP); \"okyc_legacy\": the old OTP check (offline e-KYC), which Sandbox.co.in has discontinued — keep it only for a vendor that still offers it. Checks already Verified stay valid either way. digilockerProvider — \"kyc_provider\": DigiLocker through KYC_PROVIDER (Sandbox.co.in; Gridlines has none, so the check waits for an admin); \"mock\": a local fake DigiLocker page with Approve / Deny / Expire buttons, for test.gokesari.com and local work (refused on gokesari.com).",
    schema: z.object({
      gateAvailability: z.boolean(),
      requireCharacterCertificate: z.boolean(),
      maxDocumentBytes: int(100_000, 20_000_000),
      aadhaarOtpMaxAttempts: int(1, 10),
      aadhaarMethod: z.enum(["digilocker", "okyc_legacy"]),
      digilockerProvider: z.enum(["kyc_provider", "mock"]),
    }),
    defaults: {
      gateAvailability: true,
      requireCharacterCertificate: true,
      maxDocumentBytes: 5_000_000,
      aadhaarOtpMaxAttempts: 3,
      aadhaarMethod: "digilocker",
      digilockerProvider: "kyc_provider",
    },
  },
  riderZoning: {
    description:
      "Delivery zoning (gig worker flow): an order is offered only to a Ready partner whose live location is within radiusKm of both the pickup (the shop) and the delivery address — and, for the pickup, within the partner's own operating radius. Uses the partner's live location, never the registration address; a location older than maxLocationAgeMinutes is not live, so the partner gets no new offers until the phone sends a fresh one. Each location update re-checks the partner's open offers and withdraws any that are now out of range. Off: the shop-only radius check of before.",
    schema: z.object({
      enabled: z.boolean(),
      radiusKm: z.number().min(3).max(5),
      maxLocationAgeMinutes: int(1, 240),
    }),
    defaults: { enabled: true, radiusKm: 5, maxLocationAgeMinutes: 15 },
  },
  orderCompletion: {
    description:
      "Order completion (gig worker flow, feature 11). On: once a delivery is confirmed (the rider's delivered step, a shop's own delivery, or an operator's confirmation) the order is marked Completed and the customer and the shop each get a confirmation in the app, as a push notification (rule push) and as an SMS (when an SMS provider is set up). The order's status stays Delivered for returns, ratings, invoices and refunds. Off: delivered orders are not marked completed and no completion message is sent.",
    schema: z.object({ enabled: z.boolean(), push: z.boolean(), sms: z.boolean() }),
    defaults: { enabled: true, push: true, sms: true },
  },
  /* <<< end gig worker flow */
} as const satisfies Record<string, { description: string; schema: z.ZodType; defaults: unknown }>;

export type RuleKey = keyof typeof RULES;
export type RuleValue<K extends RuleKey> = z.infer<(typeof RULES)[K]["schema"]>;
