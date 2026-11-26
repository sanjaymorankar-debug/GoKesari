"use client";

/**
 * docs/guest-checkout-2026-11: the /track form. Reference + last 4 digits of the mobile opens the
 * tracking page at once; reference + e-mail sends a code first. POST /api/track/lookup.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";
import { type Lang, tr } from "@/lib/board/i18n";
import { errorText } from "@/lib/board/error-text";
import { GC } from "@/lib/guest-checkout-i18n";

type Mode = "mobile" | "email";

export function TrackLookupForm({ lang = "en" }: { lang?: Lang }) {
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
        setError(payload?.error?.message ? errorText(payload.error.message, lang, payload.error.code) : tr(GC.trackFailed, lang));
        return;
      }
      if (payload?.url) router.push(payload.url);
      else if (payload?.maskedEmail) setCodeSentTo(payload.maskedEmail);
    } catch {
      setError(tr(GC.trackOffline, lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="track-lookup">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Field label={tr(GC.trackReference, lang)}>
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
            {tr(m === "mobile" ? GC.trackByMobile : GC.trackByEmail, lang)}
          </button>
        ))}
      </div>
      {mode === "mobile" ? (
        <>
          <Field label={tr(GC.trackLast4, lang)}>
            <input className={inputClass} inputMode="numeric" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value)} data-testid="track-last4" />
          </Field>
          <Button className="w-full" disabled={busy || !reference.trim() || last4.trim().length !== 4} onClick={() => submit({ mode: "mobile", last4 })}>
            {tr(GC.trackButton, lang)}
          </Button>
        </>
      ) : codeSentTo ? (
        <>
          <p className="text-sm text-ink-700">
            {tr(GC.trackCodeSentA, lang)} <strong>{codeSentTo}</strong> {tr(GC.trackCodeSentB, lang)}
          </p>
          <Field label={tr(GC.trackCode, lang)}>
            <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} data-testid="track-code" />
          </Field>
          <Button className="w-full" disabled={busy || !code.trim()} onClick={() => submit({ mode: "email-code", email, code })}>
            {tr(GC.trackButton, lang)}
          </Button>
        </>
      ) : (
        <>
          <Field label={tr(GC.trackEmail, lang)}>
            <input className={inputClass} type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="track-email" />
          </Field>
          <Button className="w-full" disabled={busy || !reference.trim() || !email.trim()} onClick={() => submit({ mode: "email", email })}>
            {tr(GC.sendCode, lang)}
          </Button>
        </>
      )}
    </Card>
  );
}
