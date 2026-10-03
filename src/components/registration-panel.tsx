import {
  Badge,
  Card,
  ClassificationBadge,
  EmptyState,
  Money,
  StatusBadge,
} from "@/components/ui";
import { shopTypeLabel } from "@/lib/shop-types";

export interface RegistrationDetails {
  registrationNumber: string;
  registrationDate: string | null;
  shopName: string;
  ownerName: string;
  phone: string;
  email: string | null;
  address: string;
  shopType: string;
  classification: "KESARI" | "GREEN" | null;
  status: string;
  referralCode: string | null;
  registrationFeePaise: number | null;
  amountPaidPaise: number;
  feePaymentStatus: string;
}

export interface PaymentRow {
  id: string;
  reference: string;
  paymentType: string;
  amountPaise: number;
  method: string;
  transactionId: string | null;
  paidAt: string;
  note: string | null;
  receiptUrl: string | null;
}

const FEE_STATUS_COPY: Record<string, string> = {
  PENDING: "Pending",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
};

/**
 * Shop owner's registration details and payment history (§2.5, §3).
 *
 * Deliberately read-only. Registration fee, payment status, referral code,
 * classification and approval status are all operator/admin-controlled — the
 * owner sees them but there is no control here to change them, matching the
 * server, which would refuse anyway.
 */
export function RegistrationPanel({
  details,
  payments,
}: {
  details: RegistrationDetails;
  payments: PaymentRow[];
}) {
  const fee = details.registrationFeePaise ?? 0;
  const outstanding = Math.max(0, fee - details.amountPaidPaise);

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Registration details
        </h2>
        <Card className="p-4">
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Registration number" value={details.registrationNumber} />
            <Field
              label="Registration date"
              value={
                details.registrationDate
                  ? new Date(details.registrationDate).toLocaleDateString("en-IN")
                  : "—"
              }
            />
            <Field label="Shop name" value={details.shopName} />
            <Field label="Owner name" value={details.ownerName} strong />
            <Field label="Mobile" value={details.phone} />
            <Field label="Email" value={details.email ?? "—"} />
            <Field label="Address" value={details.address} />
            <Field label="Shop type" value={shopTypeLabel(details.shopType)} />
            <Field label="Referral code" value={details.referralCode ?? "—"} />

            <div>
              <dt className="text-xs text-ink-500">Classification</dt>
              <dd className="mt-1">
                <ClassificationBadge value={details.classification} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Shop status</dt>
              <dd className="mt-1">
                <StatusBadge status={details.status} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Fee payment status</dt>
              <dd className="mt-1">
                <Badge>
                  {FEE_STATUS_COPY[details.feePaymentStatus] ??
                    details.feePaymentStatus}
                </Badge>
              </dd>
            </div>
          </dl>

          <p className="mt-4 border-t border-cream-200 pt-3 text-xs text-ink-500">
            Registration fee, payment status, referral code and classification are
            maintained by the operations team. Contact support if any of them
            looks wrong.
          </p>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Registration fee
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Registration fee" value={<Money paise={fee} />} />
          <Tile
            label="Amount paid"
            value={<Money paise={details.amountPaidPaise} />}
          />
          <Tile
            label="Outstanding"
            value={<Money paise={outstanding} />}
            warn={outstanding > 0}
          />
          <Tile
            label="Status"
            value={
              FEE_STATUS_COPY[details.feePaymentStatus] ??
              details.feePaymentStatus
            }
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-ink-900">
          Payment history ({payments.length})
        </h2>
        {payments.length === 0 ? (
          <EmptyState title="No payments recorded yet." />
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-4 py-2">Payment ID</th>
                  <th className="px-4 py-2">Date</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Method</th>
                  <th className="px-4 py-2">Reference</th>
                  <th className="px-4 py-2">Receipt</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-2 font-medium text-ink-900">
                      {p.reference}
                    </td>
                    <td className="px-4 py-2">
                      {new Date(p.paidAt).toLocaleDateString("en-IN")}
                    </td>
                    <td className="px-4 py-2">
                      <Badge>{p.paymentType.replace(/_/g, " ")}</Badge>
                    </td>
                    <td
                      className={`px-4 py-2 font-medium ${
                        p.amountPaise < 0 ? "text-red-700" : "text-ink-900"
                      }`}
                    >
                      <Money paise={p.amountPaise} />
                    </td>
                    <td className="px-4 py-2">{p.method.replace(/_/g, " ")}</td>
                    <td className="px-4 py-2 text-ink-500">
                      {p.transactionId ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      {p.receiptUrl ? (
                        <a
                          href={p.receiptUrl}
                          className="text-kesari-600 hover:underline"
                        >
                          View
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </div>
  );
}

function Field({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className={`mt-1 text-sm ${strong ? "font-bold" : "font-medium"} text-ink-900`}>{value}</dd>
    </div>
  );
}

function Tile({
  label,
  value,
  warn = false,
}: {
  label: string;
  value: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs text-ink-500">{label}</p>
      <p
        className={`mt-1 text-xl font-bold ${
          warn ? "text-kesari-600" : "text-ink-900"
        }`}
      >
        {value}
      </p>
    </Card>
  );
}
