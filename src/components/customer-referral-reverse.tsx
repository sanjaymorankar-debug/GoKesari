"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

/**
 * D-25: reverse a rewarded referral found fraudulent. Both rewards are taken
 * back from the wallets (never below zero); the reason is kept in the audit log.
 */
export function ReverseReferralButton({ referralId }: { referralId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/customer-referrals/${referralId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reverse", reason: reason.trim() }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "The reward could not be reversed.");
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The reward could not be reversed.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Reverse reward
      </Button>
    );
  }
  return (
    <div className="mt-1 space-y-1">
      <label className="block text-xs text-ink-600">
        Why is this referral fraudulent?
        <textarea className={inputClass} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </label>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="danger" disabled={busy || reason.trim().length < 5} onClick={submit}>
          {busy ? "Reversing…" : "Take back both rewards"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
