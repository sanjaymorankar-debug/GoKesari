"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

/**
 * Admin: exempt one shop from the yearly membership, or end the exemption, with a reason (audited on the
 * server, which also checks the role). docs/shop-membership-renewal-2026-11.
 */
export function MembershipExemptionToggle({ shopId, shopName, exempt }: { shopId: string; shopName: string; exempt: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/shop-memberships", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopId, exempt: !exempt, reason: reason.trim() }),
    }).catch(() => null);
    const payload = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    if (!res?.ok) {
      setError(payload?.error?.message ?? "That did not work. Please try again.");
      return;
    }
    setOpen(false);
    setReason("");
    router.refresh();
  }

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {exempt ? "End exemption" : "Exempt"}
      </Button>
    );
  }
  return (
    <div className="min-w-56 space-y-2">
      <label className="block text-xs text-ink-600">
        {exempt ? `Why end ${shopName}'s exemption?` : `Why exempt ${shopName}?`}
        <input className={inputClass} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || reason.trim().length < 5} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
