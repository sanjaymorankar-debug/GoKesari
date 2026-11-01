"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? "Something went wrong.");
  return payload;
}

/** Admin: start or resume a month's run now (docs/gig-bank-payouts-2026-10). */
export function RunMonthButton({ defaultMonth }: { defaultMonth: string }) {
  const router = useRouter();
  const [month, setMonth] = useState(defaultMonth);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input type="month" className={inputClass.replace("w-full", "w-44")} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month to pay" />
        <Button
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Pay every eligible rider what is unpaid for ${month}? A month already paid is never paid again.`)) return;
            setBusy(true);
            setMessage(null);
            try {
              const r = await post("/api/admin/rider-payouts/runs", { month });
              setMessage({ tone: "success", text: r.skipped ? r.skipped : r.alreadyDone ? "That month was already paid." : `${r.created} payment(s) created, ${r.skipped} carried forward.` });
              router.refresh();
            } catch (caught) {
              setMessage({ tone: "danger", text: caught instanceof Error ? caught.message : "Could not start the run." });
            } finally {
              setBusy(false);
            }
          }}
        >
          Run now
        </Button>
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </div>
  );
}

/** Finance: retry a transfer or hand it back to the rider's balance. */
export function TransferReviewActions({ transferId, canRetry }: { transferId: string; canRetry: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: "retry" | "release") {
    const note = action === "release" ? window.prompt("Why is it returned to the rider's balance?") : null;
    if (action === "release" && note === null) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/admin/rider-payouts/transfers/${transferId}`, { action, ...(note ? { note } : {}) });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not do that.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canRetry ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => act("retry")}>
          Retry
        </Button>
      ) : null}
      <Button size="sm" variant="danger" disabled={busy} onClick={() => act("release")}>
        Return to balance
      </Button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </div>
  );
}
