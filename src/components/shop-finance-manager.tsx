"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Money, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

export interface FinanceShopRow {
  id: string;
  name: string;
  registrationNumber: string;
  ownerName: string;
  phone: string;
  city: string;
  registrationDate: string | null;
  registrationFeePaise: number | null;
  amountPaidPaise: number;
  feePaymentStatus: string;
  referralCode: string | null;
  status: string;
}

const FEE_STATUSES = [
  "PENDING",
  "PARTIALLY_PAID",
  "PAID",
  "REFUNDED",
  "CANCELLED",
] as const;

const METHODS = [
  "CASH",
  "UPI",
  "BANK_TRANSFER",
  "CARD",
  "CHEQUE",
  "RAZORPAY",
  "OTHER",
] as const;

/**
 * Operator/admin view of registration fees and payments (§4.2, §13, §14).
 *
 * Filters are the §13 list verbatim — "fee = ₹5,000", "paid < fee", "pending" —
 * because those are the questions the report is actually asked.
 */
export function ShopFinanceManager({
  shops,
  canRecordPayment,
}: {
  shops: FinanceShopRow[];
  canRecordPayment: boolean;
}) {
  const router = useRouter();
  const [feeFilter, setFeeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [underpaidOnly, setUnderpaidOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [openFor, setOpenFor] = useState<string | null>(null);

  const filtered = shops.filter((s) => {
    if (statusFilter && s.feePaymentStatus !== statusFilter) return false;
    if (underpaidOnly && s.amountPaidPaise >= (s.registrationFeePaise ?? 0)) {
      return false;
    }
    if (feeFilter) {
      const rupees = Number(feeFilter.replace(/[₹,\s]/g, ""));
      if (Number.isFinite(rupees) && s.registrationFeePaise !== rupeesToPaise(rupees)) {
        return false;
      }
    }
    if (query) {
      const term = query.toLowerCase();
      const haystack = [s.name, s.ownerName, s.phone, s.registrationNumber, s.city]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });

  const totals = filtered.reduce(
    (acc, s) => {
      acc.expected += s.registrationFeePaise ?? 0;
      acc.collected += s.amountPaidPaise;
      return acc;
    },
    { expected: 0, collected: 0 },
  );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-xs text-ink-500">Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Shop, owner, phone, reg. no."
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Registration fee (₹)</span>
            <input
              value={feeFilter}
              onChange={(e) => setFeeFilter(e.target.value)}
              placeholder="5000"
              inputMode="decimal"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-500">Payment status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={inputClass}
            >
              <option value="">All</option>
              {FEE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input
              type="checkbox"
              checked={underpaidOnly}
              onChange={(e) => setUnderpaidOnly(e.target.checked)}
              className="h-4 w-4 accent-kesari-600"
            />
            <span className="text-sm text-ink-700">Paid less than fee</span>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-4 border-t border-cream-200 pt-3 text-sm">
          <span className="text-ink-500">
            {filtered.length} shop{filtered.length === 1 ? "" : "s"}
          </span>
          <span>
            Expected <Money paise={totals.expected} />
          </span>
          <span>
            Collected <Money paise={totals.collected} />
          </span>
          <span className="text-kesari-700">
            Outstanding{" "}
            <Money paise={Math.max(0, totals.expected - totals.collected)} />
          </span>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <EmptyState title="No shops match those filters." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-cream-100 text-xs uppercase text-ink-500">
              <tr>
                <th className="px-4 py-2">Reg. no.</th>
                <th className="px-4 py-2">Shop</th>
                <th className="px-4 py-2">Fee</th>
                <th className="px-4 py-2">Paid</th>
                <th className="px-4 py-2">Outstanding</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Referral</th>
                {canRecordPayment ? <th className="px-4 py-2" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-cream-200">
              {filtered.map((s) => {
                const fee = s.registrationFeePaise ?? 0;
                const outstanding = Math.max(0, fee - s.amountPaidPaise);
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td className="px-4 py-2 font-medium text-ink-900">
                        {s.registrationNumber}
                      </td>
                      <td className="px-4 py-2">
                        <span className="font-medium text-ink-900">{s.name}</span>
                        <p className="text-xs text-ink-500">
                          {s.ownerName} · {s.phone} · {s.city}
                        </p>
                      </td>
                      <td className="px-4 py-2">
                        <Money paise={fee} />
                      </td>
                      <td className="px-4 py-2">
                        <Money paise={s.amountPaidPaise} />
                      </td>
                      <td
                        className={`px-4 py-2 ${
                          outstanding > 0 ? "text-kesari-700" : "text-ink-500"
                        }`}
                      >
                        <Money paise={outstanding} />
                      </td>
                      <td className="px-4 py-2">
                        <Badge>{s.feePaymentStatus.replace(/_/g, " ")}</Badge>
                      </td>
                      <td className="px-4 py-2 text-ink-500">
                        {s.referralCode ?? "—"}
                      </td>
                      {canRecordPayment ? (
                        <td className="px-4 py-2">
                          <Button
                            variant="secondary"
                            onClick={() =>
                              setOpenFor(openFor === s.id ? null : s.id)
                            }
                          >
                            {openFor === s.id ? "Close" : "Record payment"}
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                    {openFor === s.id ? (
                      <tr key={`${s.id}-form`}>
                        <td colSpan={canRecordPayment ? 8 : 7} className="bg-cream-50 px-4 py-3">
                          <RecordPaymentForm
                            shopId={s.id}
                            suggestedPaise={outstanding}
                            onDone={() => {
                              setOpenFor(null);
                              router.refresh();
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export function RecordPaymentForm({
  shopId,
  suggestedPaise,
  onDone,
}: {
  shopId: string;
  suggestedPaise: number;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState(
    suggestedPaise > 0 ? String(suggestedPaise / 100) : "",
  );
  const [method, setMethod] = useState<(typeof METHODS)[number]>("CASH");
  const [paymentType, setPaymentType] = useState("REGISTRATION_FEE");
  const [transactionId, setTransactionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const rupees = Number(amount.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setError("Enter a payment amount in rupees.");
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/shop-payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId,
          paymentType,
          amountPaise: rupeesToPaise(rupees),
          method,
          transactionId: transactionId || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That did not work.");
      }
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger" title="Could not record">{error}</Alert> : null}
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="block">
          <span className="text-xs text-ink-500">Amount (₹)</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink-500">Type</span>
          <select
            value={paymentType}
            onChange={(e) => setPaymentType(e.target.value)}
            className={inputClass}
          >
            <option value="REGISTRATION_FEE">Registration fee</option>
            <option value="RENEWAL">Renewal</option>
            <option value="ADJUSTMENT">Adjustment</option>
            <option value="REFUND">Refund</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-ink-500">Method</span>
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as (typeof METHODS)[number])}
            className={inputClass}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-ink-500">Transaction ref.</span>
          <input
            value={transactionId}
            onChange={(e) => setTransactionId(e.target.value)}
            placeholder="UTR / UPI ref"
            className={inputClass}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={busy} onClick={submit}>
          Record payment
        </Button>
        <p className="text-xs text-ink-500">
          Payment records cannot be edited or deleted. A mistake is corrected by
          recording a reversal.
        </p>
      </div>
    </div>
  );
}
