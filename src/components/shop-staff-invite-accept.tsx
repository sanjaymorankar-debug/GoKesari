"use client";

/** Module 10: accept an invitation to a shop's staff (by the e-mailed link's token, or by its id). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";

export function ShopStaffInviteAccept({ token, staffId, label = "Accept" }: { token?: string; staffId?: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/shop-staff/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(token ? { token } : { staffId }),
    });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "Could not accept the invitation.");
      return;
    }
    router.push(`/shop/staff-access?shopId=${body?.shopId ?? ""}`);
    router.refresh();
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button size="sm" disabled={busy} onClick={accept}>
        {label}
      </Button>
    </div>
  );
}
