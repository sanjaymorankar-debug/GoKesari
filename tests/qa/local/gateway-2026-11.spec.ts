/**
 * An online payment never expires in under 15 minutes (TC-PAY-037, F17 of
 * docs/payments-cashfree-audit-2026-11): the attempt's expiry is the rule
 * onlinePayments.intentExpiryMinutes (15 by default) from its creation, and a
 * Cashfree order gets at least 16 minutes (cashfreeOrderExpiryTime in
 * src/server/payments/gateway/cashfree.ts; Cashfree refuses under 15), the
 * attempt storing the expiry Cashfree returns.
 *
 * Local tier: the expiry is in no customer-facing answer, so it is read from
 * payment_intents. Rule onlinePayments is switched on (default expiry 15) and
 * restored; the attempt is let expire on the sandbox page afterwards.
 */
import { pageAs } from "../lib/actors";
import { db } from "../lib/db";
import { sellable } from "../lib/flows";
import { onlineCheckout, paySandbox, withRule } from "../lib/money-helpers";
import { expect, qa } from "../lib/record";

const local = { tier: "local" as const, timeout: 240_000 };

qa("TC-PAY-037", "an online payment's expiry is at least 15 minutes after the attempt is created (a Cashfree order: at least 16, F17)", async ({ browser }) => {
  return withRule("onlinePayments", { enabled: true, intentExpiryMinutes: 15 }, async () => {
    const listing = await sellable("A", 3);
    const checkout = await onlineCheckout("customer", [{ listing }]);
    const [row] = await db()<{ gateway: string; status: string; created_at: Date; expires_at: Date | null }[]>`
      select gateway, status, created_at, expires_at from payment_intents where id = ${checkout.payment.intentId}`;
    expect(row, "the payment attempt").toBeTruthy();
    expect(row.expires_at, "the attempt has an expiry").toBeTruthy();
    const minutes = (row.expires_at!.getTime() - row.created_at.getTime()) / 60_000;
    const floor = row.gateway === "CASHFREE" ? 16 : 15;
    // A second of slack: the expiry is computed in the app, created_at by the database, a moment apart.
    expect(minutes, `${row.gateway}: minutes from creation to expiry`).toBeGreaterThanOrEqual(floor - 1 / 60);
    if (row.gateway === "SANDBOX") {
      const { context, page } = await pageAs(browser, "customer");
      try {
        await paySandbox(page, checkout.payment, "expire");
      } finally {
        await context.close();
      }
    }
    return `${checkout.orders[0].orderNumber}: ${row.gateway} attempt ${row.status}, created ${row.created_at.toISOString()}, expires ${row.expires_at!.toISOString()} = ${minutes.toFixed(2)} min (floor ${floor})`;
  });
}, { ...local, partial: "the local server pays through the SANDBOX gateway (expiry = the rule's 15 minutes); the Cashfree order's 16-minute floor itself runs only with PAYMENT_GATEWAY=CASHFREE and is covered by tests/unit/cashfree-audit-2026-11.test.ts; staging shows the expiry in no customer-facing answer" });
