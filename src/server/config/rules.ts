/**
 * Registry of admin-configurable business rules and their code defaults.
 * Add a new rule group here; services read it with `getRule("<key>")`
 * (services/settings.ts). Nothing below is a hard-coded business decision —
 * each is only the value used until an admin changes it.
 */
import { z } from "zod";

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
      expiryMinutes: 10,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
      maxResendsPerWindow: 5,
      resendWindowMinutes: 60,
      maxRequestsPerIpPerWindow: 20,
      smsEnabled: false,
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
    description: "Notification delivery: retry schedule and batch size for outbound channels.",
    schema: z.object({
      /** Delivery attempts per outbound notification before it is marked dead. */
      maxAttempts: int(1, 10),
      /** Seconds to wait before attempt 2, 3, ...; the last value repeats. */
      retryBackoffSeconds: z.array(int(10, 86_400)).min(1).max(10),
      batchSize: int(1, 500),
    }),
    defaults: { maxAttempts: 4, retryBackoffSeconds: [60, 300, 1800], batchSize: 50 },
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
    }),
    defaults: {
      // 48 h matches the return window, so a dispute and a return on the same
      // order age out on the same clock.
      escalateAfterHours: 48,
      // ₹2,000. Above this an administrator decides, not operations.
      escalateAbovePaise: 200_000,
      resolveTargetHours: 120,
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
      "Shop acceptance timeout (NEW-007). Off: an order waits for the shop indefinitely (operations sees it in the exceptions queue — the original behaviour). On: a shop must accept a new order within the set minutes — counted from when it opens, for an order placed while closed — or the order is cancelled with a full refund and the customer is told. The shop gets a reminder part-way through. Subscription orders are not affected.",
    schema: z.object({
      enabled: z.boolean(),
      /** Minutes the shop has to accept a new order. */
      acceptMinutes: int(1, 240),
      /** Remind the shop when this share of the time has passed (0.5 = half-way). */
      reminderAtFraction: z.number().min(0.1).max(0.95),
    }),
    defaults: { enabled: false, acceptMinutes: 10, reminderAtFraction: 0.5 },
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
} as const satisfies Record<string, { description: string; schema: z.ZodType; defaults: unknown }>;

export type RuleKey = keyof typeof RULES;
export type RuleValue<K extends RuleKey> = z.infer<(typeof RULES)[K]["schema"]>;
