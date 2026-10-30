/**
 * PaymentGateway — the one interface every payment provider implements
 * (batch-2026-10, F1.7.3 / F1.8.4 / GS-028 / SM-005).
 *
 *   payments service → getPaymentGateway() → SandboxGateway   (default, tests, staging)
 *                                          → Cashfree / Razorpay / PhonePe / HDFC PG adapters
 *
 * The provider is chosen by configuration only (PAYMENT_GATEWAY + its keys);
 * no business code names a vendor. Card data never reaches this server: every
 * adapter hands back a hosted-checkout URL or an SDK session token.
 */

export type GatewayName = "SANDBOX" | "CASHFREE" | "RAZORPAY" | "PHONEPE" | "HDFC";

export type PaymentMethodKind = "UPI" | "CARD" | "NETBANKING";

/** The gateway's view of one order (a payment attempt). */
export type GatewayOrderStatus = "CREATED" | "PENDING" | "AUTHORIZED" | "CAPTURED" | "FAILED" | "EXPIRED";

export type GatewayRefundStatus = "PENDING" | "SUCCESS" | "FAILED";

export interface GatewayCustomer {
  id: string;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface CreateGatewayOrderInput {
  /** Our id for the attempt; adapters send it as the gateway's merchant order id (idempotent at the gateway). */
  merchantOrderId: string;
  amountPaise: number;
  customer: GatewayCustomer;
  /** Where the hosted checkout sends the customer back. */
  returnUrl: string;
  /** Webhook URL for this attempt. */
  notifyUrl: string;
  methods?: PaymentMethodKind[];
  expiresAt?: Date;
  /** Shown on the gateway page / statement. */
  description: string;
  metadata?: Record<string, string>;
}

export type GatewayCheckout =
  | { kind: "HOSTED_URL"; url: string }
  /** For a mobile/web SDK: the token the SDK opens the checkout with. */
  | { kind: "SDK_SESSION"; sessionToken: string; url?: string };

export interface GatewayOrder {
  gatewayOrderId: string;
  status: GatewayOrderStatus;
  checkout: GatewayCheckout;
  expiresAt: Date | null;
}

export interface GatewayOrderState {
  gatewayOrderId: string;
  status: GatewayOrderStatus;
  amountPaise: number;
  gatewayPaymentId: string | null;
  method: PaymentMethodKind | null;
  failureReason?: string | null;
}

export interface CreatePaymentLinkInput {
  merchantLinkId: string;
  amountPaise: number;
  customer: GatewayCustomer;
  description: string;
  expiresAt: Date;
  notifyUrl: string;
  returnUrl?: string;
}

export interface GatewayPaymentLink {
  gatewayLinkId: string;
  url: string;
  expiresAt: Date;
}

export interface GatewayRefundInput {
  gatewayOrderId: string;
  gatewayPaymentId: string | null;
  /** Our refund id — the idempotency key at the gateway. */
  merchantRefundId: string;
  amountPaise: number;
  reason: string;
}

export interface GatewayRefund {
  gatewayRefundId: string;
  status: GatewayRefundStatus;
}

export type GatewayWebhookKind =
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_CAPTURED"
  | "PAYMENT_FAILED"
  | "ORDER_EXPIRED"
  | "LINK_PAID"
  | "REFUND_SUCCESS"
  | "REFUND_FAILED"
  | "UNKNOWN";

export interface GatewayWebhookEvent {
  /** The gateway's event id — the idempotency key for processing. */
  eventId: string;
  kind: GatewayWebhookKind;
  /** merchantOrderId / merchantLinkId / merchantRefundId as we sent it, when the payload carries it. */
  merchantRef: string | null;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  gatewayRefundId: string | null;
  amountPaise: number | null;
  occurredAt: Date;
  raw: unknown;
}

export interface PaymentGateway {
  readonly name: GatewayName;
  /** Keys present (a sandbox is always configured). */
  isConfigured(): boolean;
  createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder>;
  /** Server-side truth for reconciliation — never trust the client or the webhook alone. */
  fetchOrder(gatewayOrderId: string): Promise<GatewayOrderState>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<GatewayPaymentLink>;
  refund(input: GatewayRefundInput): Promise<GatewayRefund>;
  fetchRefund(gatewayOrderId: string, merchantRefundId: string): Promise<GatewayRefund>;
  /** Signature check over the raw body; false on any mismatch or a stale timestamp. */
  verifyWebhook(rawBody: string, headers: Headers): boolean;
  parseWebhook(rawBody: string, headers: Headers): GatewayWebhookEvent;
}

export class GatewayNotConfiguredError extends Error {
  constructor(name: GatewayName) {
    super(`Payment gateway ${name} is selected but its keys are not set.`);
  }
}
