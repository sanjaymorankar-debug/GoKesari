"use client";

/** Module 3 admin buttons: suspend a shop, resend / cancel a registration, track a commission. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

async function act(url: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, { method: "POST", headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.error?.message ?? "Could not complete that.";
}

export function SuspendShopButton({ shopId, shopName }: { shopId: string; shopName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="danger"
      disabled={busy}
      onClick={async () => {
        const reason = window.prompt(`Suspend ${shopName}? Reason (sent to the owner):`, "Self-registration under review by GoKesari support.");
        if (!reason) return;
        setBusy(true);
        const error = await act(`/api/shops/${shopId}/suspend`, { reason });
        setBusy(false);
        if (error) window.alert(error);
        router.refresh();
      }}
    >
      Suspend
    </Button>
  );
}

export function RegistrationActions({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const run = async (path: string, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    const error = await act(`/api/admin/shop-registrations/${id}/${path}`);
    setBusy(false);
    if (error) window.alert(error);
    router.refresh();
  };
  return (
    <span className="flex gap-1">
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run("resend-link")}>Resend link</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run("cancel", "Cancel this unpaid registration? Its place on the referral code is freed.")}>Cancel</Button>
    </span>
  );
}

const NEXT: Record<string, string[]> = { ACCRUED: ["APPROVED", "REVERSED"], APPROVED: ["PAID", "REVERSED"], PAID: [], REVERSED: [] };

export function CommissionStatus({ id, status, canChange }: { id: string; status: string; canChange: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!canChange || NEXT[status].length === 0) return <span className="text-xs">{status.toLowerCase()}</span>;
  return (
    <select
      className="rounded border border-cream-200 px-1 py-0.5 text-xs"
      value={status}
      disabled={busy}
      onChange={async (e) => {
        const next = e.target.value;
        const note = window.prompt(`Mark as ${next.toLowerCase()}? Note (optional, e.g. payment reference):`, "");
        if (note === null) return;
        setBusy(true);
        const res = await fetch(`/api/admin/referral-commissions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next, note: note || null }) });
        setBusy(false);
        if (!res.ok) window.alert((await res.json().catch(() => null))?.error?.message ?? "Could not change it.");
        router.refresh();
      }}
    >
      <option value={status}>{status.toLowerCase()}</option>
      {NEXT[status].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
    </select>
  );
}
