"use client";

import { useRef, useState } from "react";

import { Alert, Button } from "@/components/ui";
import { formatPaiseCompact } from "@/lib/money";

/**
 * Renew now (docs/shop-membership-renewal-2026-11): starts the online payment of the yearly membership
 * renewal and sends the browser to the gateway. The amount shown is the server's; the request carries
 * none. Busy from the first tap until the page leaves, so a double tap starts one payment (the server
 * also reuses an open one for the same period).
 */
export function MembershipRenewButton({ shopId, amountPaise }: { shopId: string; amountPaise: number }) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function renew() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shopId}/membership-renewal`, { method: "POST" }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (response?.ok && typeof payload?.redirectUrl === "string") {
      window.location.assign(payload.redirectUrl);
      return;
    }
    setError(
      response
        ? (payload?.error?.message ?? "Could not start the payment. Please try again.")
        : "Could not reach the server. Check your connection and try again.",
    );
    busyRef.current = false;
    setBusy(false);
  }

  return (
    <div className="space-y-3">
      <Button type="button" size="lg" className="w-full sm:w-auto" disabled={busy} aria-busy={busy} onClick={() => void renew()} data-testid="membership-renew-now">
        {busy ? "Opening payment…" : `Renew now — pay ${formatPaiseCompact(amountPaise)}`}
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
