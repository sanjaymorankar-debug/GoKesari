"use client";

import { useState } from "react";

import { Alert, Button, Card } from "@/components/ui";

const CHOICES = [
  { decision: "approve", label: "Approve — share my Aadhaar", variant: "primary" },
  { decision: "mismatch", label: "Approve — Aadhaar in another name", variant: "secondary" },
  { decision: "deny", label: "Deny", variant: "secondary" },
  { decision: "expire", label: "Let the link expire", variant: "secondary" },
  { decision: "down", label: "DigiLocker is down", variant: "secondary" },
] as const;

export function MockDigilockerButtons({ session }: { session: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(decision: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/kyc-mock/digilocker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, decision }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.redirectUrl) throw new Error(payload?.error ?? "Could not record the choice.");
      window.location.assign(payload.redirectUrl);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <p className="text-sm text-ink-700">GoKesari asks to see your Aadhaar card, for delivery partner KYC.</p>
      <div className="flex flex-col gap-2">
        {CHOICES.map((c) => (
          <Button key={c.decision} variant={c.variant} disabled={busy} onClick={() => void choose(c.decision)} data-testid={`mock-digilocker-${c.decision}`}>
            {c.label}
          </Button>
        ))}
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
