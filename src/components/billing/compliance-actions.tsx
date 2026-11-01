"use client";

/**
 * Billing v2 (docs/billing §5.7): buttons on Admin → Compliance. They only
 * call the API; the server builds every return and records every filing.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

async function call(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? "That did not work.");
}

export function GenerateReturnButton({ returnType, period, label }: { returnType: string; period: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        data-testid={`generate-${returnType}-${period}`}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await call("/api/admin/compliance", { returnType, period });
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "That did not work.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : label}
      </Button>
      {error ? <span className="text-xs text-red-700">{error}</span> : null}
    </span>
  );
}

export function MarkFiledForm({ filingId }: { filingId: string }) {
  const router = useRouter();
  const [ack, setAck] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await call(`/api/admin/compliance/filings/${filingId}/filed`, { acknowledgement: ack });
          router.refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : "That did not work.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="sr-only" htmlFor={`ack-${filingId}`}>
        ARN / acknowledgement
      </label>
      <input id={`ack-${filingId}`} className={`${inputClass} h-8 w-48 text-sm`} placeholder="ARN / acknowledgement" value={ack} onChange={(e) => setAck(e.target.value)} />
      <Button size="sm" type="submit" disabled={busy || ack.trim().length < 5}>
        Mark filed
      </Button>
      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}
    </form>
  );
}
