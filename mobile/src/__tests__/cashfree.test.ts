/**
 * 1.8.0: Cashfree payments through Cashfree's mobile SDK, started by the
 * website through the bridge (docs/payments-cashfree-audit-2026-11 at the
 * repository root). The SDK itself needs a device; this checks the parts that
 * decide what the app accepts: the request check (build ↔ environment), the
 * error wording, the page API the bridge installs, and the UPI scheme list.
 */
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { buildBridgeScript } from "../bridge-script";
import { describeCashfreeError, parseCashfreeCheckoutRequest, UPI_APP_SCHEMES } from "../cashfree-request";

const SESSION = "session_abc123DEF456-xyz_789=";

describe("Cashfree checkout request from the page", () => {
  it("accepts a production payment in the production app and a sandbox one in the test app", () => {
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: SESSION, orderId: "topup_1731_ab12", mode: "production" }, "production")).toEqual({
      ok: true,
      request: { paymentSessionId: SESSION, orderId: "topup_1731_ab12", environment: "PRODUCTION", flow: "web" },
    });
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: SESSION, orderId: "gk_1", mode: "sandbox", flow: "upi" }, "preview")).toEqual({
      ok: true,
      request: { paymentSessionId: SESSION, orderId: "gk_1", environment: "SANDBOX", flow: "upi" },
    });
  });

  it("refuses the sandbox in the production app and production in the test app", () => {
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: SESSION, orderId: "gk_1", mode: "sandbox" }, "production")).toMatchObject({ ok: false });
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: SESSION, orderId: "gk_1", mode: "production" }, "preview")).toMatchObject({ ok: false });
  });

  it("refuses a missing or odd session, order id or environment", () => {
    expect(parseCashfreeCheckoutRequest({ orderId: "gk_1", mode: "production" }, "production")).toMatchObject({ ok: false });
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: "x", orderId: "gk_1", mode: "production" }, "production")).toMatchObject({ ok: false });
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: SESSION, orderId: "a b<script>", mode: "production" }, "production")).toMatchObject({ ok: false });
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: SESSION, orderId: "gk_1", mode: "live" }, "production")).toMatchObject({ ok: false });
    expect(parseCashfreeCheckoutRequest({ paymentSessionId: 42, orderId: "gk_1", mode: "production" }, "production")).toMatchObject({ ok: false });
  });

  it("tells a cancelled checkout from a failed payment", () => {
    expect(describeCashfreeError({ code: "action_cancelled", message: "payment cancelled by user" })).toEqual({ message: "Payment was cancelled.", cancelled: true });
    expect(describeCashfreeError({ code: "payment_failed", message: "Card declined by bank" })).toEqual({ message: "Card declined by bank", cancelled: false });
    expect(describeCashfreeError(null)).toEqual({ message: "The payment did not go through.", cancelled: false });
  });

  it("lists the UPI apps Cashfree documents, upi first", () => {
    expect(UPI_APP_SCHEMES[0]).toBe("upi");
    for (const scheme of ["phonepe", "tez", "paytmmp", "bhim", "credpay", "amazonpay"]) expect(UPI_APP_SCHEMES).toContain(scheme);
  });
});

describe("page bridge: cashfreeCheckout", () => {
  const TOKEN = "per-launch-secret";
  function loadPage() {
    const posted: Record<string, unknown>[] = [];
    const window: Record<string, unknown> = {
      location: { origin: "https://gokesari.com", href: "https://gokesari.com/wallet" },
      ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
    };
    const document = { styleSheets: [], addEventListener: () => {} };
    runInNewContext(buildBridgeScript({ siteOrigin: "https://gokesari.com", token: TOKEN, platform: "android", version: "1.8.0" }), {
      window,
      document,
      navigator: {},
      DOMException,
      URL,
      Promise,
      setTimeout,
    });
    return {
      posted,
      app: window.__gokesariApp as {
        capabilities: string[];
        cashfreeCheckout(o: Record<string, unknown>): Promise<unknown>;
        receive(m: unknown): void;
      },
    };
  }

  it("announces the capability and sends only the session, order, mode and flow", async () => {
    const { app, posted } = loadPage();
    expect([...app.capabilities]).toContain("cashfree-native-checkout");
    const result = app.cashfreeCheckout({ paymentSessionId: SESSION, orderId: "topup_1", mode: "production", flow: "upi", secret: "never" });
    const sent = posted[posted.length - 1];
    expect(sent).toEqual({ type: "cashfree.checkout", id: expect.any(Number), token: TOKEN, paymentSessionId: SESSION, orderId: "topup_1", mode: "production", flow: "upi" });
    app.receive({ type: "reply", id: sent.id, result: { status: "verify", orderId: "topup_1" } });
    await expect(result).resolves.toEqual({ status: "verify", orderId: "topup_1" });
  });

  it("rejects with the app's error (a cancelled payment is an AbortError)", async () => {
    const { app, posted } = loadPage();
    const result = app.cashfreeCheckout({ paymentSessionId: SESSION, orderId: "topup_1", mode: "production" });
    const sent = posted[posted.length - 1];
    app.receive({ type: "reply", id: sent.id, error: { name: "AbortError", message: "Payment was cancelled." } });
    await expect(result).rejects.toEqual({ name: "AbortError", message: "Payment was cancelled." });
  });
});
