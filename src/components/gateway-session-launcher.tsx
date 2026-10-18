"use client";

/**
 * Opens a gateway's own checkout for an SDK-session payment (batch-2026-10
 * WS-A). Cashfree: its hosted JS checkout in this tab ("_self"), which comes
 * back to /orders/payment-return. Card, UPI and bank details are typed into
 * the gateway's page only — never into GoKesari.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, Button } from "@/components/ui";
import { openCashfreeCheckout } from "@/lib/cashfree-checkout";

export function GatewaySessionLauncher({
  gateway,
  sessionToken,
  mode,
  returnPath,
}: {
  gateway: string;
  sessionToken: string;
  mode: "sandbox" | "production";
  returnPath: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const open = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      if (gateway !== "CASHFREE") throw new Error("This payment gateway's checkout is not available in the app yet.");
      await openCashfreeCheckout({ paymentSessionId: sessionToken, redirectTarget: "_self" }, mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The payment page could not be opened.");
    } finally {
      setBusy(false);
    }
  }, [gateway, sessionToken, mode]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void open();
  }, [open]);

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-ink-600">Opening the secure payment page…</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void open()} disabled={busy}>
          Open payment page
        </Button>
        <Link href={returnPath} className="inline-flex min-h-11 items-center px-2 text-sm underline">
          I have paid — check status
        </Link>
      </div>
    </div>
  );
}
