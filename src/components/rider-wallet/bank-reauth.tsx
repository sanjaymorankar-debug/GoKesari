"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

/**
 * A delivery partner confirms it's them (emailed code) before changing or
 * removing a verified bank account (docs/gig-bank-payouts-2026-10). The
 * change itself happens in the bank account form below, within 10 minutes.
 */
export function BankReauth({ canRemove }: { canRemove: boolean }) {
  const router = useRouter();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [until, setUntil] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, method: string, body?: unknown) {
    const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message ?? "Something went wrong.");
    return payload;
  }

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      {until ? (
        <Alert tone="success">
          Confirmed. Change your bank details below (or remove the account) before{" "}
          {new Date(until).toLocaleTimeString("en-IN", { timeStyle: "short", timeZone: "Asia/Kolkata" })}.
        </Alert>
      ) : (
        <p className="text-sm text-ink-600">Your account is verified. To change or remove it, first confirm it&apos;s you with a code we email you.</p>
      )}
      {!until && !sentTo ? (
        <Button variant="secondary" disabled={busy} onClick={() => run(async () => setSentTo((await post("/api/gig/bank-account/reauth", "POST", {})).codeSent?.maskedEmail ?? "your email"))}>
          Email me a code
        </Button>
      ) : null}
      {!until && sentTo ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => setUntil((await post("/api/gig/bank-account/reauth", "POST", { code })).expiresAt));
          }}
        >
          <div className="min-w-[10rem] flex-1">
            <Field label="Code" hint={`Sent to ${sentTo}.`}>
              <input className={inputClass} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Confirmation code" />
            </Field>
          </div>
          <Button type="submit" disabled={busy || code.trim().length < 4}>
            Confirm
          </Button>
        </form>
      ) : null}
      {until && canRemove ? (
        <Button
          variant="danger"
          size="sm"
          disabled={busy}
          onClick={() =>
            run(async () => {
              if (!window.confirm("Remove this bank account? Payouts stop until you add and verify another one.")) return;
              await post("/api/gig/bank-account", "DELETE");
              setUntil(null);
              setSentTo(null);
              router.refresh();
            })
          }
        >
          Remove this bank account
        </Button>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
