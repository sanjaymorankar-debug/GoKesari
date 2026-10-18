"use client";

/** GS1 DataKart / Open Food Facts barcode look-up into staging (batch-2026-10 WS-D, F9.1.2). */
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

export function SourceLookupForm({ gs1, off }: { gs1: { enabled: boolean; mode: string }; off: { enabled: boolean } }) {
  const [source, setSource] = useState<"GS1" | "OFF">(gs1.enabled ? "GS1" : "OFF");
  const [codes, setCodes] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string; jobId?: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/pmd/sources/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, gtins: codes.split(/[\s,;]+/).filter(Boolean) }),
    });
    const data = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) setResult({ tone: "danger", text: data?.error?.message ?? "Look-up failed." });
    else {
      const running = data.job && (data.job.status === "QUEUED" || data.job.status === "RUNNING");
      setResult({
        tone: "success",
        text: `Found ${data.found}; not found ${data.notFound.length}. Mode: ${data.mode}.${running ? " Still importing in the background." : ""}`,
        jobId: data.job?.id,
      });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-cream-200 bg-white p-4">
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name="source" checked={source === "GS1"} onChange={() => setSource("GS1")} /> GS1 India DataKart {gs1.enabled ? `(${gs1.mode.toLowerCase()})` : "(off)"}
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input type="radio" name="source" checked={source === "OFF"} onChange={() => setSource("OFF")} /> Open Food Facts {off.enabled ? "" : "(off)"}
        </label>
      </div>
      <textarea className={inputClass} rows={4} placeholder="Barcodes (GTIN / EAN), one per line" value={codes} onChange={(e) => setCodes(e.target.value)} />
      <Button type="submit" disabled={busy}>Look up and stage</Button>
      {result ? (
        <Alert tone={result.tone}>
          {result.text} {result.jobId ? <a className="underline" href={`/admin/product-browser/jobs/${result.jobId}`}>Open the import</a> : null}
        </Alert>
      ) : null}
    </form>
  );
}
