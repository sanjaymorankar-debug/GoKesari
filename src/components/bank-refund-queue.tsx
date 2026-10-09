"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, inputClass } from "@/components/ui";
import { formatPaise } from "@/lib/money";

export interface BankRefundQueueRow {
  id: string;
  status: "REQUESTED" | "PROCESSING" | "PAID" | "FAILED" | "CANCELLED";
  amountPaise: number;
  accountLabel: string;
  accountHolderName: string;
  orderNumber: string | null;
  customerName: string | null;
  customerEmail: string;
  createdAt: string;
  payoutReference: string | null;
  failureReason: string | null;
}

interface PayoutDetails {
  method: "BANK_ACCOUNT" | "UPI";
  accountHolderName: string;
  accountNumber: string | null;
  ifsc: string | null;
  upiId: string | null;
}

const TONE = { REQUESTED: "warning", PROCESSING: "info", PAID: "success", FAILED: "danger", CANCELLED: "neutral" } as const;
const LABEL = { REQUESTED: "To send", PROCESSING: "Sent from bank", PAID: "Paid", FAILED: "Failed", CANCELLED: "Cancelled" } as const;

/**
 * Finance: refunds customers asked to receive in their bank (docs/four-features-2026-10,
 * rule bankRefunds). Send it from the bank like a settlement, then record the
 * bank's reference — or mark it failed and it returns to the customer's wallet.
 */
export function BankRefundQueue({ rows, canManage }: { rows: BankRefundQueueRow[]; canManage: boolean }) {
  if (rows.length === 0) return <EmptyState title="No refunds to bank here." />;
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <RefundRow key={row.id} row={row} canManage={canManage} />
      ))}
    </div>
  );
}

function RefundRow({ row, canManage }: { row: BankRefundQueueRow; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<PayoutDetails | null>(null);
  const [mode, setMode] = useState<"pay" | "fail" | null>(null);
  const [text, setText] = useState("");
  const open = row.status === "REQUESTED" || row.status === "PROCESSING";

  async function call(url: string, init: RequestInit, fallback: string): Promise<unknown> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, init);
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? fallback);
      return payload;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const decide = async (body: Record<string, unknown>) => {
    const done = await call(
      `/api/admin/bank-refunds/${row.id}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      "Could not update the refund.",
    );
    if (done) {
      setMode(null);
      setText("");
      router.refresh();
    }
  };

  return (
    <Card className="p-4 text-sm" data-testid="bank-refund-row">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold text-ink-900">{formatPaise(row.amountPaise)}</p>
          <p className="text-ink-700">
            {row.customerName ?? row.customerEmail}
            {row.orderNumber ? ` · order ${row.orderNumber}` : ""}
          </p>
          <p className="text-xs text-ink-500">
            To {row.accountHolderName}, {row.accountLabel} · asked {new Date(row.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
          </p>
          {row.payoutReference ? <p className="text-xs text-ink-600">Bank reference {row.payoutReference}</p> : null}
          {row.failureReason ? <p className="text-xs text-red-700">{row.failureReason}</p> : null}
        </div>
        <Badge tone={TONE[row.status]}>{LABEL[row.status]}</Badge>
      </div>

      {error ? <div className="mt-2"><Alert tone="danger">{error}</Alert></div> : null}

      {details ? (
        <div className="mt-2 rounded-lg border border-cream-200 bg-cream-50 p-2 font-mono text-xs" data-testid="bank-refund-details">
          <p>Name: {details.accountHolderName}</p>
          {details.method === "UPI" ? <p>UPI ID: {details.upiId}</p> : <p>Account: {details.accountNumber} · IFSC {details.ifsc}</p>}
        </div>
      ) : null}

      {canManage && open ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!details ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                const shown = (await call(`/api/admin/bank-refunds/${row.id}/account`, { method: "GET" }, "Could not load the account.")) as PayoutDetails | null;
                if (shown) setDetails(shown);
              }}
            >
              Show account details
            </Button>
          ) : null}
          {row.status === "REQUESTED" ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide({ action: "process" })}>
              Mark sent from bank
            </Button>
          ) : null}
          {mode ? (
            <span className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} w-56`}
                placeholder={mode === "pay" ? "Bank reference (UTR)" : "Why it failed"}
                aria-label={mode === "pay" ? "Bank reference (UTR)" : "Why it failed"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <Button
                size="sm"
                variant={mode === "pay" ? "primary" : "danger"}
                disabled={busy || text.trim().length < (mode === "pay" ? 4 : 3)}
                onClick={() => void decide(mode === "pay" ? { action: "pay", reference: text } : { action: "fail", reason: text })}
              >
                {mode === "pay" ? "Save as paid" : "Mark failed"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode(null)}>
                Cancel
              </Button>
            </span>
          ) : (
            <>
              <Button size="sm" disabled={busy} onClick={() => setMode("pay")}>
                Paid
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("fail")}>
                Failed
              </Button>
            </>
          )}
        </div>
      ) : null}
    </Card>
  );
}
