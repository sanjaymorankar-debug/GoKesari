import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Refund & Cancellation Policy" };
// Refunds to bank (docs/four-features-2026-10, O-2): the wording follows the rule, so it is read per request.
export const dynamic = "force-dynamic";

export default async function RefundPolicyPage() {
  // The owner's approved wording (9 Oct 2026) shows only while refunds to bank are offered.
  const bankRefunds = await getRule("bankRefunds").catch(() => null);
  return (
    <>
      <h1>Refund &amp; Cancellation Policy</h1>
      <p>Last updated: {CURRENT_POLICY_VERSION}</p>

      <p>
        This policy explains how order cancellations and refunds work on the
        platform. Individual shops may publish additional return conditions
        on their shop page for perishable or made-to-order items — those are
        shown to you before you order and take precedence for that shop
        where they are stricter than this policy in your favour.
      </p>

      <h2>Cancelling an order</h2>
      <p>
        An order can be cancelled from your Orders page while it is still in
        a cancellable status (before the shop marks it out for delivery). Once
        an order has been dispatched for delivery it can no longer be
        cancelled through the app — contact the shop directly, or raise a{" "}
        <a href="/legal/grievance-redressal">grievance</a> if you believe it
        was dispatched in error.
      </p>

      <h2>How refunds are paid</h2>
      <p>
        When a paid order is cancelled or refunded, the amount is credited
        back to your platform wallet. If the original payment used a mix of
        your own funds and promotional/voucher credit, the refund restores
        that same split — promotional credit is never converted into
        real, withdrawable money by a refund. See our{" "}
        <a href="/legal/wallet-terms">Wallet Terms</a> for what the wallet
        is and is not.
      </p>
      {bankRefunds?.enabled ? (
        <p>
          Within {bankRefunds.windowDays} days of a refund you can ask for it to
          be sent to your verified bank account instead (My Wallet). It leaves
          your wallet straight away and reaches your bank within{" "}
          {bankRefunds.expectedWorkingDays} working days; if the transfer
          fails, it returns to your wallet.
        </p>
      ) : null}

      <h2>Food and perishable items</h2>
      <p>
        Because dairy, bakery, and other perishable food items cannot
        generally be resold once delivered, returns of delivered food items
        are only accepted where the item was incorrect, damaged, or unsafe on
        arrival. Report this within 24 hours of delivery using the order&apos;s
        &quot;Report an issue&quot; option or by raising a grievance.
      </p>

      <h2>Non-perishable items</h2>
      <p>
        For non-food items, the shop&apos;s stated return window (shown on
        the shop&apos;s page, where provided) applies. Where a shop has not
        stated a return window, contact the shop or raise a grievance and we
        will help coordinate a resolution.
      </p>

      <h2>Processing time</h2>
      <p>
        Wallet refunds are credited as soon as the cancellation or refund is
        approved — this is typically immediate for platform-approved
        cancellations. Refunds requiring shop confirmation (e.g. a damaged-item
        report) are processed once the shop or platform has reviewed the
        report.
      </p>
    </>
  );
}
