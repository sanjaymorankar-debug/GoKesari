"use client";

import { useRef, useState } from "react";

import { Alert, Button } from "@/components/ui";
import { formatPaiseCompact } from "@/lib/money";

/**
 * Starts the online payment of a shop's registration fee and sends the browser
 * to the gateway. The amount shown is the server's; the request carries none.
 * Busy from the first tap until the page navigates away, so a double tap
 * starts one payment (the server reuses an open one as well).
 */
export function RegistrationFeePayButton({ shopId, amountPaise }: { shopId: string; amountPaise: number }) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shopId}/registration-fee`, { method: "POST" }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    if (response?.ok && typeof payload?.redirectUrl === "string") {
      window.location.assign(payload.redirectUrl);
      return; // stays busy: the page is leaving
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
      <Button type="button" size="lg" className="w-full" disabled={busy} aria-busy={busy} onClick={() => void pay()}>
        {busy ? "Opening payment…" : `Pay ${formatPaiseCompact(amountPaise)} now`}
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
