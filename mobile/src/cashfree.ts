/**
 * 1.8.0: Cashfree payments with Cashfree's React Native SDK (react-native-cashfree-pg-sdk),
 * started by the website through the bridge (cashfree-request.ts explains the contract).
 *
 *  - "web" → CFPaymentGatewayService.doWebPayment: Cashfree's checkout in the SDK's own
 *    screen — cards, UPI (it opens the phone's UPI apps by intent), wallets, net banking.
 *  - "upi" → doUPIPayment with CFUPIIntentCheckoutPayment: straight to the UPI apps.
 *
 * One payment at a time. The callback is registered before the payment starts and removed
 * when it ends (Cashfree's rule). onVerify only means "the flow finished": the page always
 * confirms with the GoKesari server, which asks Cashfree (never trusting the phone).
 * No key is ever in the app: the session id is all the SDK needs.
 */
import { CFEnvironment, CFSession, CFUPIIntentCheckoutPayment } from "cashfree-pg-api-contract";
import { CFPaymentGatewayService, type CFErrorResponse } from "react-native-cashfree-pg-sdk";

import { describeCashfreeError, type CashfreeCheckoutRequest, type CashfreeCheckoutResult } from "./cashfree-request";

let inFlight = false;

export class CashfreeCheckoutError extends Error {
  readonly cancelled: boolean;
  readonly orderId: string | null;
  constructor(message: string, cancelled: boolean, orderId: string | null) {
    super(message);
    this.name = cancelled ? "AbortError" : "PaymentError";
    this.cancelled = cancelled;
    this.orderId = orderId;
  }
}

export function runCashfreeCheckout(request: CashfreeCheckoutRequest): Promise<CashfreeCheckoutResult> {
  if (inFlight) return Promise.reject(new CashfreeCheckoutError("A payment is already open.", false, null));
  inFlight = true;
  return new Promise<CashfreeCheckoutResult>((resolve, reject) => {
    const done = () => {
      inFlight = false;
      try {
        CFPaymentGatewayService.removeCallback();
      } catch {
        /* already removed */
      }
    };
    CFPaymentGatewayService.setCallback({
      onVerify(orderID: string) {
        done();
        resolve({ status: "verify", orderId: orderID || request.orderId });
      },
      onError(error: CFErrorResponse, orderID: string) {
        done();
        const { message, cancelled } = describeCashfreeError({ message: error?.getMessage?.(), code: error?.getCode?.(), status: error?.getStatus?.() });
        reject(new CashfreeCheckoutError(message, cancelled, orderID || request.orderId));
      },
    });
    try {
      const environment = request.environment === "PRODUCTION" ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
      const session = new CFSession(request.paymentSessionId, request.orderId, environment);
      if (request.flow === "upi") CFPaymentGatewayService.doUPIPayment(new CFUPIIntentCheckoutPayment(session, null));
      else CFPaymentGatewayService.doWebPayment(session);
    } catch (error) {
      done();
      reject(new CashfreeCheckoutError(error instanceof Error ? error.message : "The payment could not be started.", false, request.orderId));
    }
  });
}
