/**
 * 1.8.0 (docs/payments-cashfree-audit-2026-11 at the repository root): the
 * website asks the app to take a Cashfree payment with Cashfree's own mobile
 * SDK — card, UPI (the phone's UPI apps by intent) and wallets — instead of
 * Cashfree's web checkout inside the WebView. The page sends only the
 * payment_session_id and order_id its server made (never a key); the app
 * reports "the payment flow finished" or the error, and the page then asks
 * its server, which asks Cashfree. Nothing here decides a payment succeeded.
 *
 * Plain TypeScript (no React Native imports) so it is unit-tested.
 */

export type CashfreeEnvironment = "SANDBOX" | "PRODUCTION";

export interface CashfreeCheckoutRequest {
  paymentSessionId: string;
  orderId: string;
  environment: CashfreeEnvironment;
  /** "web": Cashfree's full checkout (cards, UPI, wallets, net banking). "upi": straight to the UPI apps on the phone. */
  flow: "web" | "upi";
}

/** What the page gets back when the SDK's flow finishes: always confirm with the server next. */
export interface CashfreeCheckoutResult {
  status: "verify";
  orderId: string;
}

/** UPI apps the app may open (iOS LSApplicationQueriesSchemes; Cashfree's documented list). */
export const UPI_APP_SCHEMES = [
  "upi",
  "phonepe",
  "tez",
  "gpay",
  "paytmmp",
  "paytm",
  "bhim",
  "credpay",
  "amazonpay",
  "mobikwik",
  "myairtel",
  "navipay",
  "kiwi",
  "popclubapp",
  "super",
  "simplypayupi",
  "whatsapp",
] as const;

const SESSION_ID = /^[A-Za-z0-9_\-.=+/]{10,1000}$/;
const ORDER_ID = /^[A-Za-z0-9_-]{3,50}$/;

/**
 * Checks the page's request. The environment must match the build: the
 * production app (gokesari.com) never pays in the sandbox, the test app never
 * in production — so a misconfigured site cannot move pretend or real money
 * the wrong way through the app.
 */
export function parseCashfreeCheckoutRequest(
  message: Record<string, unknown>,
  appVariant: "production" | "preview",
): { ok: true; request: CashfreeCheckoutRequest } | { ok: false; error: string } {
  const paymentSessionId = typeof message.paymentSessionId === "string" ? message.paymentSessionId : "";
  const orderId = typeof message.orderId === "string" ? message.orderId : "";
  const mode = message.mode === "production" ? "PRODUCTION" : message.mode === "sandbox" ? "SANDBOX" : null;
  if (!SESSION_ID.test(paymentSessionId)) return { ok: false, error: "The payment session is missing or not valid." };
  if (!ORDER_ID.test(orderId)) return { ok: false, error: "The order id is missing or not valid." };
  if (!mode) return { ok: false, error: "The payment environment is missing." };
  if (appVariant === "production" && mode !== "PRODUCTION") return { ok: false, error: "This app takes real payments only." };
  if (appVariant === "preview" && mode !== "SANDBOX") return { ok: false, error: "The test app takes sandbox payments only." };
  const flow = message.flow === "upi" ? "upi" : "web";
  return { ok: true, request: { paymentSessionId, orderId, environment: mode, flow } };
}

/** Cashfree's error (CFErrorResponse fields) → a sentence for the customer, and whether they simply closed it. */
export function describeCashfreeError(error: { message?: string | null; code?: string | null; status?: string | null } | null | undefined): {
  message: string;
  cancelled: boolean;
} {
  const code = (error?.code ?? "").toLowerCase();
  const text = (error?.message ?? "").trim();
  const cancelled = /cancel|dropped|back_pressed|user_dropped|closed/.test(code) || /cancel|closed by user|back pressed/i.test(text);
  if (cancelled) return { message: "Payment was cancelled.", cancelled: true };
  return { message: text || "The payment did not go through.", cancelled: false };
}
