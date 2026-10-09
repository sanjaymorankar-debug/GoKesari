import { CURRENT_POLICY_VERSION } from "@/lib/legal-docs";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Wallet Terms" };
// Refunds to bank (docs/four-features-2026-10, O-2): the wording follows the rule, so it is read per request.
export const dynamic = "force-dynamic";

export default async function WalletTermsPage() {
  // The owner's approved wording (9 Oct 2026) shows only while refunds to bank are offered.
  const bankRefunds = await getRule("bankRefunds").catch(() => null);
  return (
    <>
      <h1>Wallet Terms</h1>
      <p>Last updated: {CURRENT_POLICY_VERSION}</p>

      <p>
        <strong>
          The platform wallet is a spending ledger for this platform only. It
          is not a bank account, deposit, payment bank, or any form of RBI-
          regulated stored-value instrument (such as a Prepaid Payment
          Instrument/PPI).
        </strong>{" "}
        It exists to make repeat purchases and subscription payments on this
        platform faster, and to hold promotional credit.
      </p>

      <h2>What the wallet can be used for</h2>
      <ul>
        <li>Paying for orders and subscription deliveries on this platform.</li>
        <li>Holding a refund until you spend it on another order.</li>
        <li>Holding promotional/voucher credit issued by the platform.</li>
      </ul>

      <h2>What the wallet cannot be used for</h2>
      <ul>
        <li>
          <strong>It cannot be transferred to another customer.</strong>{" "}
          Wallet balances are not peer-to-peer transferable.
        </li>
        {bankRefunds?.enabled ? (
          <li>
            <strong>It cannot be withdrawn as cash.</strong> Money refunded to
            your wallet (not promotional credit, not top-ups) can be sent to
            your own verified bank account within {bankRefunds.windowDays} days
            of the refund; see the <a href="/legal/refund-policy">Refund Policy</a>.
          </li>
        ) : (
          <li>
            <strong>It cannot be withdrawn as cash</strong> or transferred to a
            bank account, UPI ID, or any external payment method.
          </li>
        )}
        <li>
          It is not interest-bearing and is not insured or guaranteed by any
          bank or deposit-insurance scheme.
        </li>
      </ul>
      <p>
        If cash-out or peer-to-peer transfer is ever introduced, it will only
        be enabled once the appropriate RBI-regulated payment framework is in
        place — not as a feature of this ledger as it exists today.
      </p>

      <h2>Two kinds of balance</h2>
      <p>
        Internally, wallet balance is tracked as customer-funded balance
        (money you added or that was refunded to you) and promotional credit
        (bonus/voucher credit issued by the platform) separately. When you
        spend from the wallet, promotional credit is used first, so your own
        money is preserved for longer. If an order paid partly from
        promotional credit is later refunded, the refund restores the same
        split rather than converting promotional credit into withdrawable
        money.
      </p>

      <h2>Adding funds</h2>
      <p>
        You add funds to the wallet via Cashfree. All top-ups are verified
        against Cashfree before your balance is credited — a payment that has
        not been confirmed by Cashfree never increases your balance.
      </p>

      <h2>Expiry and account closure</h2>
      <p>
        Customer-funded wallet balance does not expire. Promotional credit
        may carry its own expiry, shown when it is issued. If your account is
        closed with a remaining customer-funded balance, contact us via{" "}
        <a href="/legal/grievance-redressal">Grievance Redressal</a> to
        arrange resolution.
      </p>
    </>
  );
}
