"use client";

import { useState } from "react";

import { Alert, Button } from "@/components/ui";

/**
 * Opt in or out of marketing messages (GS-070). Off by default — silence or
 * a pre-ticked box is not consent under DPDPA §6 — and withdrawing takes the
 * same single click as granting. Order, wallet and delivery messages are not
 * marketing and are unaffected either way.
 */
export function MarketingConsentToggle({
  initialGranted,
  lastChangedAt,
}: {
  initialGranted: boolean;
  lastChangedAt: string | null;
}) {
  const [granted, setGranted] = useState(initialGranted);
  const [changedAt, setChangedAt] = useState(lastChangedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/consents/marketing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ granted: next }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "Your choice could not be saved.");
      }
      setGranted(payload.granted);
      setChangedAt(payload.lastChangedAt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your choice could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="marketing-consent">
      <p className="text-sm text-ink-700">
        {granted
          ? "You have agreed to receive offers and promotional messages from Gokesari and its shops."
          : "You are not receiving offers or promotional messages."}
      </p>
      <p className="mt-1 text-xs text-ink-500">
        Order, payment and delivery updates are always sent — they are not marketing.
        {changedAt ? ` Last changed ${new Date(changedAt).toLocaleString("en-IN")}.` : null}
      </p>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      <div className="mt-3">
        <Button
          variant={granted ? "secondary" : "primary"}
          size="sm"
          disabled={busy}
          onClick={() => change(!granted)}
        >
          {granted ? "Stop marketing messages" : "Yes, send me offers"}
        </Button>
      </div>
    </div>
  );
}
