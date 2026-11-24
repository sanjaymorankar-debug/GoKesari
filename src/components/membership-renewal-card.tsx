import Link from "next/link";

import { MembershipRenewButton } from "@/components/membership-renew-button";
import { Alert, Badge, Card, Money } from "@/components/ui";
import { formatGstRate } from "@/lib/registration-fee";

/** What the owner's Registration page shows about the yearly membership (dates formatted on the server). */
export interface MembershipRenewalCardView {
  shopId: string;
  state: "NONE" | "ACTIVE" | "DUE_SOON" | "GRACE" | "LAPSED" | "EXEMPT";
  enforced: boolean;
  validUntil: string | null;
  offlineFrom: string | null;
  periodMonths: number;
  quote: { basePaise: number; gstRateBp: number; gstPaise: number; totalPaise: number; source: string };
  canRenew: boolean;
  refusalText: string | null;
  checkoutEnabled: boolean;
  /** The latest renewal attempt's outcome, when it did not go through or is being checked. */
  attempt: "FAILED" | "CHECKING" | null;
  history: {
    id: string;
    kind: string;
    from: string;
    to: string;
    feePaise: number;
    paidOn: string | null;
    reference: string | null;
    method: string | null;
    voided: string | null;
  }[];
}

const STATE: Record<MembershipRenewalCardView["state"], { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  ACTIVE: { label: "Active", tone: "success" },
  DUE_SOON: { label: "Renewal due soon", tone: "warning" },
  GRACE: { label: "Ended — in grace period", tone: "warning" },
  LAPSED: { label: "Ended — shop not online", tone: "danger" },
  NONE: { label: "No end date", tone: "neutral" },
  EXEMPT: { label: "Not required for this shop", tone: "info" },
};

/**
 * The yearly membership on Shop → Registration and fee (docs/shop-membership-renewal-2026-11): plan, fee,
 * expiry and renewal date, state, Renew now (while online renewal is open) and the renewal history with
 * receipts. When the membership is not enforced (rule off, or the shop is exempt) it says so instead of
 * warning that the shop will go offline.
 */
export function MembershipRenewalCard({ view }: { view: MembershipRenewalCardView }) {
  const ended = view.state === "GRACE" || view.state === "LAPSED";
  const notEnforced = !view.enforced && view.state !== "EXEMPT";
  const s = notEnforced && ended ? { label: "Ended — not enforced", tone: "info" as const } : STATE[view.state];
  return (
    <section id="membership" className="space-y-3" data-testid="membership-renewal">
      <h2 className="text-lg font-semibold text-ink-900">Yearly membership</h2>
      <Card className="space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-700">
            Plan: {view.periodMonths}-month membership{view.state === "EXEMPT" ? "" : ", renewed each period"}
          </p>
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-ink-500">Valid until</dt>
            <dd className="font-medium text-ink-900">{view.validUntil ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Renewal date</dt>
            <dd className="font-medium text-ink-900">{view.state === "EXEMPT" || !view.validUntil ? "—" : view.validUntil}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Renewal fee</dt>
            <dd className="font-medium text-ink-900">
              {view.state === "EXEMPT" ? "—" : <Money paise={view.quote.totalPaise} />}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Online after the end until</dt>
            <dd className="font-medium text-ink-900">{view.enforced && view.offlineFrom ? view.offlineFrom : "Not enforced"}</dd>
          </div>
        </dl>
        {view.state !== "EXEMPT" && view.quote.gstPaise > 0 ? (
          <p className="text-xs text-ink-500">
            <Money paise={view.quote.basePaise} /> + GST {formatGstRate(view.quote.gstRateBp)} <Money paise={view.quote.gstPaise} />
          </p>
        ) : null}

        {notEnforced && ended ? (
          <Alert tone="info">Your membership ended on {view.validUntil}. Membership is not enforced at the moment, so your shop stays online.</Alert>
        ) : null}
        {view.enforced && view.state === "GRACE" ? (
          <Alert tone="warning">
            Your membership ended on {view.validUntil}. Renew before {view.offlineFrom}, or customers won&apos;t be able to order from your shop.
          </Alert>
        ) : null}
        {view.enforced && view.state === "LAPSED" ? (
          <Alert tone="danger">Your membership ended on {view.validUntil}, so your shop is not online. Renew it to take orders again.</Alert>
        ) : null}
        {view.attempt === "FAILED" ? (
          <Alert tone="danger" title="Your last renewal payment did not go through">
            No money was taken for it. You can try again.
          </Alert>
        ) : null}
        {view.attempt === "CHECKING" ? (
          <Alert tone="info" title="Checking your payment…">
            If you completed the payment, it shows here within a minute.{" "}
            <Link href={`/shop/manage/registration?shop=${view.shopId}`} className="underline">
              Refresh
            </Link>
          </Alert>
        ) : null}

        {view.canRenew ? (
          <MembershipRenewButton shopId={view.shopId} amountPaise={view.quote.totalPaise} />
        ) : view.refusalText && view.state !== "EXEMPT" && view.state !== "ACTIVE" ? (
          <p className="text-sm text-ink-600" data-testid="membership-renew-unavailable">
            {view.refusalText}
          </p>
        ) : null}
      </Card>

      <h3 className="text-base font-semibold text-ink-900">Renewal history ({view.history.length})</h3>
      {view.history.length === 0 ? (
        <p className="text-sm text-ink-500">No membership periods recorded yet.</p>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-4 py-2">Period</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Fee</th>
                <th className="px-4 py-2">Paid</th>
                <th className="px-4 py-2">Receipt</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {view.history.map((h) => (
                <tr key={h.id} className={h.voided ? "text-ink-400 line-through" : undefined}>
                  <td className="px-4 py-2">
                    {h.from} – {h.to}
                    {h.voided ? <span className="block text-xs no-underline">Taken back: {h.voided}</span> : null}
                  </td>
                  <td className="px-4 py-2">{h.kind === "RENEWAL" ? "Renewal" : "Registration"}</td>
                  <td className="px-4 py-2">
                    <Money paise={h.feePaise} />
                  </td>
                  <td className="px-4 py-2">
                    {h.paidOn ?? "—"}
                    {h.method ? ` · ${h.method.replace(/_/g, " ")}` : ""}
                  </td>
                  <td className="px-4 py-2">
                    {h.reference && !h.voided ? (
                      <Link href={`/shop/membership/receipt/${h.id}`} className="text-kesari-700 hover:underline">
                        {h.reference}
                      </Link>
                    ) : (
                      (h.reference ?? "—")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
