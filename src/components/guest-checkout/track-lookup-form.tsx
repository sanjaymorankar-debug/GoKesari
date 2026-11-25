"use client";

/**
 * docs/guest-checkout-2026-11: the /track form. Reference + last 4 digits of the mobile opens the
 * tracking page at once; reference + e-mail sends a code first. POST /api/track/lookup.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

type Mode = "mobile" | "email";

export function TrackLookupForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("mobile");
  const [reference, setReference] = useState("");
  const [last4, setLast4] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(body: Record<string, string>) {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/track/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference, ...body }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not look up the order.");
        return;
      }
      if (payload?.url) router.push(payload.url);
      else if (payload?.maskedEmail) setCodeSentTo(payload.maskedEmail);
    } catch {
      setError("Could not look up the order. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="track-lookup">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Field label="Order reference">
        <input className={inputClass} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="GK-20261123-AB12CD" data-testid="track-reference" />
      </Field>
      <div className="flex gap-2 text-sm" role="tablist">
        {(["mobile", "email"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setError(null);
            }}
            className={`rounded-full px-3 py-1.5 ${mode === m ? "bg-kesari-600 text-white" : "bg-cream-100 text-ink-700"}`}
          >
            {m === "mobile" ? "Mobile number" : "E-mail + code"}
          </button>
        ))}
      </div>
      {mode === "mobile" ? (
        <>
          <Field label="Last 4 digits of your mobile number">
            <input className={inputClass} inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} data-testid="track-last4" />
          </Field>
          <Button className="w-full" disabled={busy || !reference.trim() || last4.trim().length !== 4} onClick={() => submit({ mode: "mobile", last4 })}>
            Track order
          </Button>
        </>
      ) : codeSentTo ? (
        <>
          <p className="text-sm text-ink-700">
            If <strong>{codeSentTo}</strong> is the e-mail on this order, a code is on its way.
          </p>
          <Field label="Code">
            <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} data-testid="track-code" />
          </Field>
          <Button className="w-full" disabled={busy || !code.trim()} onClick={() => submit({ mode: "email-code", email, code })}>
            Track order
          </Button>
        </>
      ) : (
        <>
          <Field label="E-mail used for the order">
            <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="track-email" />
          </Field>
          <Button className="w-full" disabled={busy || !reference.trim() || !email.trim()} onClick={() => submit({ mode: "email", email })}>
            Send code
          </Button>
        </>
      )}
    </Card>
  );
}
