/**
 * What happens when a payment for each purpose is captured (batch-2026-10).
 * Called by the payments service inside the transaction that marks the intent
 * CAPTURED, so the purpose's state change and the capture commit together.
 * Each workstream adds its handler in its own section.
 */
import type { DbClient } from "@/server/db";
import type { PaymentIntentRef, PaymentPurpose } from "./intents";
import { onShopRegistrationFeeCaptured } from "@/server/services/operator-limited"; // batch-2026-10 WS-D

/**
 * Work that must wait for the capture to commit (it locks rows the capture
 * transaction holds, or tells people about it). The payments service runs it
 * right after the commit, in the same request — never on a timer, which a
 * host may not run once the response is sent.
 */
export type AfterCommit = (task: () => Promise<void>) => void;

export type CapturedHandler = (intent: PaymentIntentRef, client: DbClient, afterCommit?: AfterCommit) => Promise<void>;

export const CAPTURED_HANDLERS: Partial<Record<PaymentPurpose, CapturedHandler>> = {
  /* >>> batch-2026-10 WS-A (payments, OTP, reference prices) — add entries below this line only */
  // Orders paid online: every order still waiting for this payment becomes CONFIRMED + paid
  // (order-payments.ts; imported lazily so this registry adds no import cycle).
  ORDER: async (intent, client) => (await import("./order-payments")).onOrderPaymentCaptured(intent, client),
  ORDER_GROUP: async (intent, client) => (await import("./order-payments")).onOrderPaymentCaptured(intent, client),
  /* <<< end WS-A */
  //
  /* >>> batch-2026-10 WS-D (operator-limited, product master data) — add entries below this line only */
  // F8.4.2: the registration fee of an operator-onboarded shop (link or in-session). Records the fee on the
  // shop's ledger in the capture transaction; the existing auto-approval rule runs after commit.
  SHOP_REGISTRATION_FEE: (intent, client, afterCommit) => onShopRegistrationFeeCaptured(intent, client, afterCommit),
  /* <<< end WS-D */
  //
  /* >>> dealer programme (docs/dealer-programme, step 7) */
  // A support-service request paid online: marked paid in the capture transaction; its ticket opens after commit.
  SUPPORT_SERVICE: async (intent, client, afterCommit) => (await import("@/server/services/support-services")).onSupportServicePaymentCaptured(intent, client as never, afterCommit),
  // 0151 territory dealers: a territory's yearly fee paid online — the territory is paid up in the capture transaction.
  TERRITORY_FEE: async (intent, client, afterCommit) => (await import("@/server/dealers/territory")).onTerritoryFeeCaptured(intent, client, afterCommit),
  /* <<< end dealer programme */
  //
  /* >>> consultant appointments (docs/consult-booking-2026-11) */
  // A booking's fee or advance (or its balance) paid online: the booking is confirmed in the capture transaction.
  CONSULT_BOOKING: async (intent, client, afterCommit) => (await import("@/server/consult/payments")).onConsultPaymentCaptured(intent, client, afterCommit),
  /* <<< consultant appointments */
  //
  /* >>> GoKesari Health (docs/health/) */
  // A medicines order from a forwarded prescription, an equipment rental (rent + deposit + delivery, or an extension), a Prime plan.
  HEALTH_RX_ORDER: async (intent, client, afterCommit) => (await import("@/server/health/rx-orders")).onRxOrderPaymentCaptured(intent, client, afterCommit),
  HEALTH_RENTAL: async (intent, client, afterCommit) => (await import("@/server/health/rentals")).onRentalPaymentCaptured(intent, client, afterCommit),
  HEALTH_PRIME: async (intent, client, afterCommit) => (await import("@/server/health/prime")).onPrimePaymentCaptured(intent, client, afterCommit),
  /* <<< GoKesari Health */
  //
  /* >>> franchise area booking (docs/franchise) */
  // A franchise booking (new areas or a renewal) paid online: the allocations become ACTIVE in the capture transaction.
  FRANCHISE_FEE: async (intent, client, afterCommit) => (await import("@/server/franchise/booking")).onFranchiseFeeCaptured(intent, client, afterCommit),
  /* <<< franchise area booking */
  //
  /* >>> dealer platform (docs/dealer-platform) */
  // A paid scheme's joining charge: marked paid in the capture transaction; the applicant then submits.
  DEALER_JOINING_FEE: async (intent, client) => (await import("@/server/dealers/scheme-registration")).onJoiningFeeCaptured(intent, client),
  /* <<< dealer platform */
  //
  /* >>> shop membership renewal (docs/shop-membership-renewal-2026-11) */
  // The yearly membership renewal paid online: on the shop's ledger (RENEWAL, ONLINE) and the membership extended, in the capture transaction.
  SHOP_MEMBERSHIP_RENEWAL: async (intent, client, afterCommit) => (await import("@/server/services/shop-membership-renewal")).onShopMembershipRenewalCaptured(intent, client, afterCommit),
  /* <<< shop membership renewal */
  //
  /* >>> PAY-2 top-ups via payment intents (docs/payments-topups-via-intents-2026-11) */
  // The payments row → SUCCESS and the wallet credit commit with the capture; the notice and voucher bonus run after it.
  WALLET_TOPUP: async (intent, client, afterCommit) => (await import("./topup-intents")).onTopUpCaptured(intent, client, afterCommit),
  SHOP_WALLET_TOPUP: async (intent, client, afterCommit) => (await import("./topup-intents")).onTopUpCaptured(intent, client, afterCommit),
  /* <<< PAY-2 */
  //
  /* >>> onboarding v2, Flow 2 (docs/onboarding-v2-2026-11) */
  // The shop registration fee paid on the registration draft (before the shop exists): the draft is marked paid in the
  // capture transaction; the fee goes on the shop's ledger when the shop is created from the draft.
  SHOP_REGISTRATION_DRAFT_FEE: async (intent, client) => (await import("@/server/onboarding-v2/shop-flow")).onDraftFeeCaptured(intent, client),
  /* <<< onboarding v2 */
};

/**
 * PAY-2: money the gateway took after an attempt had FAILED / EXPIRED. Without
 * an entry support is told (payment.attention) and nothing else happens; with
 * one, the purpose may still settle it (a top-up is credited). Returns true
 * when it did, so support is not alerted.
 */
export type LateCaptureHandler = (
  intent: import("@/server/db/schema").PaymentIntentRow,
  captured: { amountPaise: number; gatewayPaymentId: string | null },
  client: DbClient,
  afterCommit: AfterCommit,
) => Promise<boolean>;

export const LATE_CAPTURE_HANDLERS: Partial<Record<PaymentPurpose, LateCaptureHandler>> = {
  WALLET_TOPUP: async (intent, captured, client, afterCommit) => (await import("./topup-intents")).onTopUpLateCapture(intent, captured, client, afterCommit),
  SHOP_WALLET_TOPUP: async (intent, captured, client, afterCommit) => (await import("./topup-intents")).onTopUpLateCapture(intent, captured, client, afterCommit),
};
