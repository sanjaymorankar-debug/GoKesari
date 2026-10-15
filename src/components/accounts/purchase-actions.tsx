"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

import { accountsApi, ApiError } from "./api";

/** Cancel a confirmed purchase (reverses stock, books and ITC) — with a reason. */
export function CancelPurchase({ shopId, purchaseId }: { shopId: string; purchaseId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Cancel bill
      </Button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded-xl border border-red-200 bg-red-50 p-3">
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-red-900">Why cancel? The stock, the supplier&apos;s account and the GST credit are reversed.</span>
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} maxLength={300} />
      </label>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button
          variant="danger"
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await accountsApi(shopId, `purchases/${purchaseId}`, { method: "DELETE", body: { reason } });
              router.refresh();
              setOpen(false);
            } catch (e) {
              setError(e instanceof ApiError ? e.message : "Could not cancel.");
            } finally {
              setBusy(false);
            }
          }}
        >
          Cancel this bill
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
    </div>
  );
}
