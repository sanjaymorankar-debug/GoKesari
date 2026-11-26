"use client";

/** The account recovery form (docs/flows-v3/wave1.md; flag flow_f17). Posts to /api/account/recover. */
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function RecoverForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/account/recover", { method: "POST", body: new FormData(event.currentTarget) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
        throw new Error(fields ? Object.values(fields).join(" ") : (payload?.error?.message ?? "Could not send the request."));
      }
      setDone(payload.ticketNumber);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Alert tone="success" title={`Request ${done} received`}>
        Our support team will check your details and write to you at the e-mail you gave. Keep this number for reference.
      </Alert>
    );
  }

  return (
    <Card className="p-5">
      <form className="space-y-4" onSubmit={submit} data-testid="recover-form">
        <Field label="Your name">
          <input name="name" className={inputClass} required minLength={2} maxLength={120} autoComplete="name" />
        </Field>
        <Field label="E-mail we can reach you at now">
          <input name="contactEmail" type="email" className={inputClass} required maxLength={200} autoComplete="email" />
        </Field>
        <Field label="Phone we can reach you at now (optional)">
          <input name="contactPhone" type="tel" className={inputClass} maxLength={20} autoComplete="tel" />
        </Field>
        <Field label="Mobile number of the account">
          <input name="oldMobile" type="tel" className={inputClass} maxLength={20} />
        </Field>
        <Field label="E-mail of the account">
          <input name="oldEmail" type="email" className={inputClass} maxLength={200} />
        </Field>
        <Field label="What happened?">
          <textarea name="description" className={inputClass} required minLength={10} maxLength={3000} rows={4} />
        </Field>
        <Field label="Identity document (photo or PDF)">
          <input name="idProof" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required className="block w-full text-sm" />
        </Field>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send request"}
        </Button>
      </form>
    </Card>
  );
}
