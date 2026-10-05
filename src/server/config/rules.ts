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
  statusModels: {
    description:
      "Lifecycle status models for shops, riders and subscriptions: when enforcement is on, the database refuses a status change that is not in the allowed-transition table (it is always logged).",
    schema: z.object({
      /** Read by the database trigger (migration 0042). Off: disallowed changes go through, logged as unenforced. */
      enforceTransitions: z.boolean(),
    }),
    defaults: { enforceTransitions: true },
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
} as const satisfies Record<string, { description: string; schema: z.ZodType; defaults: unknown }>;

export type RuleKey = keyof typeof RULES;
export type RuleValue<K extends RuleKey> = z.infer<(typeof RULES)[K]["schema"]>;
