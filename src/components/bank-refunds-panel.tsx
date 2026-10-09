"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { formatPaise } from "@/lib/money";

/** services/bank-refunds.ts CustomerBankRefunds, as the wallet page shows it. */
export interface BankRefundsInfo {
  windowDays: number;
  expectedWorkingDays: number;
  minAmountPaise: number;
  account: { label: string; status: "PENDING" | "VERIFIED" | "FAILED"; usable: boolean } | null;
  candidates: {
    refundTransactionId: string;
    orderNumber: string | null;
    description: string;
    refundedAt: string;
    refundPaise: number;
    sendablePaise: number;
  }[];
  requests: {
    id: string;
    status: "REQUESTED" | "PROCESSING" | "PAID" | "FAILED" | "CANCELLED";
    amountPaise: number;
    accountLabel: string;
    orderNumber: string | null;
    createdAt: string;
    payoutReference: string | null;
    failureReason: string | null;
  }[];
}

const STATUS = {
  REQUESTED: { label: "On its way", tone: "info" },
  PROCESSING: { label: "Sent from our bank", tone: "info" },
  PAID: { label: "Paid to your bank", tone: "success" },
  FAILED: { label: "Failed — back in wallet", tone: "danger" },
  CANCELLED: { label: "Cancelled — back in wallet", tone: "neutral" },
} as const;

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/**
 * Refunds to a customer's bank (docs/four-features-2026-10, rule bankRefunds):
 * a refund in the wallet can be sent to the customer's verified bank account
 * instead. The server re-checks the account, the amount and the time limit.
 */
export function BankRefundsPanel({ info }: { info: BankRefundsInfo }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const usable = info.account?.usable ?? false;

  async function post(url: string, body: unknown, done: string, fallback: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? fallback);
      setConfirming(null);
      setNotice(done);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 p-4" data-testid="bank-refunds">
      <h2 className="text-base font-semibold text-ink-900">Send a refund to your bank</h2>
      <p className="mt-1 text-sm text-ink-600">
        Refunds come to your wallet straight away. Within {info.windowDays} days you can have one sent to your bank account
        instead; it reaches you within {info.expectedWorkingDays} working days. Promotional credit stays in the wallet.
      </p>

      <div className="mt-3 text-sm" data-testid="bank-refund-account">
        {info.account ? (
          <p>
            To: <span className="font-medium">{info.account.label}</span>{" "}
            {info.account.status === "VERIFIED" ? <Badge tone="success">verified</Badge> : <Badge tone="warning">not verified</Badge>}{" "}
            <Link href="/profile/bank-account" className="text-xs font-medium text-kesari-700 hover:underline">
              Change
            </Link>
          </p>
        ) : null}
        {!usable ? (
          <div className="mt-2">
            <Alert tone="info" title={info.account ? "Verify your bank account first" : "Add your bank account first"}>
              Refunds can only be sent to a bank account you have verified (a ₹1 payment, refunded straight away).{" "}
              <Link href="/profile/bank-account" className="font-medium underline">
                {info.account ? "Verify it" : "Add it"}
              </Link>
            </Alert>
          </div>
        ) : null}
      </div>

      {error ? <div className="mt-3"><Alert tone="danger">{error}</Alert></div> : null}
      {notice ? <div className="mt-3"><Alert tone="success">{notice}</Alert></div> : null}

      {info.candidates.length > 0 ? (
        <ul className="mt-3 divide-y divide-cream-100 text-sm">
          {info.candidates.map((c) => {
            const tooSmall = c.sendablePaise < info.minAmountPaise;
            return (
              <li key={c.refundTransactionId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="bank-refund-candidate">
                <span>
                  <span className="block text-ink-900">{c.description}</span>
                  <span className="block text-xs text-ink-500">
                    {day(c.refundedAt)} · refund {formatPaise(c.refundPaise)}
                    {c.sendablePaise < c.refundPaise && c.sendablePaise > 0 ? ` · ${formatPaise(c.sendablePaise)} still in your wallet` : ""}
                    {c.sendablePaise === 0 ? " · already spent from your wallet" : ""}
                  </span>
                </span>
                {confirming === c.refundTransactionId ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-700">
                      Send {formatPaise(c.sendablePaise)} to {info.account?.label}?
                    </span>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void post(
                          "/api/bank-refunds",
                          { refundTransactionId: c.refundTransactionId },
                          `${formatPaise(c.sendablePaise)} is on its way to your bank.`,
                          "Could not send the refund to your bank.",
                        )
                      }
                    >
                      {busy ? "Sending…" : "Yes, send it"}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(null)}>
                      Keep in wallet
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="secondary" disabled={!usable || tooSmall || busy} onClick={() => setConfirming(c.refundTransactionId)}>
                    Send {formatPaise(c.sendablePaise)} to my bank
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-ink-500">No refunds from the last {info.windowDays} days to send.</p>
      )}

      {info.requests.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-ink-800">Refunds sent to your bank</h3>
          <ul className="mt-1 divide-y divide-cream-100 text-sm">
            {info.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid="bank-refund-request">
                <span>
                  <span className="font-medium text-ink-900">{formatPaise(r.amountPaise)}</span> to {r.accountLabel}
                  <span className="block text-xs text-ink-500">
                    {day(r.createdAt)}
                    {r.orderNumber ? ` · order ${r.orderNumber}` : ""}
                    {r.payoutReference ? ` · bank reference ${r.payoutReference}` : ""}
                    {r.status === "FAILED" && r.failureReason ? ` · ${r.failureReason}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  {r.status === "REQUESTED" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void post(`/api/bank-refunds/${r.id}/cancel`, {}, "Cancelled — the amount is back in your wallet.", "Could not cancel it.")}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
