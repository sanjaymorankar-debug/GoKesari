"use client";

import { useState } from "react";
import clsx from "clsx";

import { Alert } from "@/components/ui";

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
      <div className="flex items-start justify-between gap-4">
        <div>
          <p id="marketing-consent-label" className="text-sm font-medium text-ink-800">
            Offers from GoKesari and its shops
          </p>
          <p id="marketing-consent-hint" className="mt-0.5 text-xs text-ink-500">
            Deals, discounts and campaigns. Off unless you turn it on, and you can turn it off at any time.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="w-6 text-right text-sm font-medium text-ink-700" aria-hidden>
            {granted ? "On" : "Off"}
          </span>
          {/* Withdrawing is the same single tap as agreeing (DPDPA §6). */}
          <button
            type="button"
            role="switch"
            aria-checked={granted}
            aria-labelledby="marketing-consent-label"
            aria-describedby="marketing-consent-hint"
            disabled={busy}
            onClick={() => change(!granted)}
            className={clsx(
              "tap-target inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              granted ? "bg-kesari-600" : "bg-ink-500",
            )}
          >
            <span
              className={clsx(
                "inline-block h-5 w-5 rounded-full bg-white shadow transition-transform",
                granted ? "translate-x-5" : "translate-x-0.5",
              )}
            />
          </button>
        </div>
      </div>
      <p className="mt-3 text-xs text-ink-500">
        Order, payment and delivery updates are always sent — they are not marketing. Choose how you get
        those under Notification settings below.
        {changedAt ? ` Last changed ${formatChangedAt(changedAt)}.` : null}
      </p>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}

/** "7 Oct 2026, 1:10 pm" in India time, so the server and the browser render the same text. */
function formatChangedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}
