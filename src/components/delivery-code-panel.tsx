"use client";

import { useState } from "react";

import { Button } from "@/components/ui";

/**
 * The customer's delivery code on an order that is on the way. The code is
 * stored only as a hash, so the page cannot show the one that was emailed;
 * "Get a new code" issues a fresh one (the old one stops working), emails it
 * and shows it here once. Rate-limited by the server.
 */
export function DeliveryCodePanel({
  orderId,
  maskedEmail,
  locked,
  ticketNumber,
  resendsLeft,
}: {
  orderId: string;
  maskedEmail: string;
  locked: boolean;
  ticketNumber: string | null;
  resendsLeft: number;
}) {
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(resendsLeft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (locked) {
    return (
      <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="delivery-code-locked">
        Too many wrong delivery codes were entered, so this delivery is on hold. Our support team will contact you
        {ticketNumber ? ` (ticket ${ticketNumber})` : ""}.
      </p>
    );
  }

  async function newCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/orders/${orderId}/delivery-code`, { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "Could not get a new code.");
      setCode(payload.code);
      setLeft(payload.resendsLeft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not get a new code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg bg-leaf-50 px-3 py-2 text-sm text-leaf-700" data-testid="delivery-otp">
      {code ? (
        <p>
          Delivery code: <span className="font-mono text-lg font-bold tracking-widest">{code}</span> — share it with the
          rider only when you receive your order. Your earlier code no longer works.
        </p>
      ) : (
        <p>
          Your delivery code was emailed to {maskedEmail}. Share it with the rider only when you receive your order.
        </p>
      )}
      {left > 0 ? (
        <div className="mt-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void newCode()}>
            {busy ? "Sending…" : code ? "Get another code" : "Get a new code"}
          </Button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-red-700">{error}</p> : null}
    </div>
  );
}
