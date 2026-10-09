"use client";

/**
 * Module 2: sync by file (myBillBook, Vyapar, other software). Upload the
 * item export → confirm which column is which → apply; download GoKesari
 * sales to import into the software.
 */
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

interface Upload {
  id: string;
  fileName: string;
  status: "UPLOADED" | "APPLIED" | "CANCELLED";
  headers: string[];
  sampleRows: string[][];
  rowCount: number;
  mapping: Record<string, string> | null;
  summary: Record<string, number> | null;
  running: boolean;
  fields: Record<string, { label: string; required: boolean; hint: string }>;
}

interface RecentUpload {
  id: string;
  fileName: string;
  status: string;
  rowCount: number;
  summary: Record<string, number> | null;
  createdAt: string;
  appliedAt: string | null;
}

export function FileSync({ shopId, label, recent, waiting }: { shopId: string; label: string; recent: RecentUpload[]; waiting: number }) {
  const router = useRouter();
  const base = `/api/shops/${shopId}/integration`;
  const [upload, setUpload] = useState<Upload | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // While an apply runs after the response, check back every few seconds.
  useEffect(() => {
    if (!upload?.running) return;
    const timer = setInterval(async () => {
      const res = await fetch(`${base}/imports/${upload.id}`);
      if (!res.ok) return;
      const next = (await res.json()) as Upload;
      if (!next.running) {
        setUpload(next);
        setNotice(next.status === "APPLIED" ? "Your items are updated." : "The file could not be applied — see the sync log.");
        router.refresh();
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [upload, base, router]);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${base}/imports`, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "The file could not be read.");
      return;
    }
    setUpload(body);
    setMapping(body.mapping ?? {});
  }

  async function apply() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    let res = await fetch(`${base}/imports/${upload.id}/mapping`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) }),
    });
    let body = await res.json().catch(() => null);
    if (res.ok) {
      res = await fetch(`${base}/imports/${upload.id}/apply`, { method: "POST" });
      body = await res.json().catch(() => null);
    }
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "Could not apply the file.");
      return;
    }
    setUpload({ ...upload, status: "APPLIED", running: true });
    setNotice(`Applying ${upload.rowCount} rows…`);
  }

  const download = (kind: string, scope: "new" | "range", format: "xlsx" | "csv") => {
    const q = new URLSearchParams({ kind, scope, format });
    if (scope === "range") {
      q.set("from", from);
      q.set("to", to);
    }
    // A file download, not a page: a temporary link keeps this page open.
    const link = document.createElement("a");
    link.href = `${base}/exports?${q.toString()}`;
    link.download = "";
    link.click();
    if (scope === "new") setTimeout(() => router.refresh(), 2500);
  };

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-ink-900">1. Update stock and prices from {label}</h2>
        <p className="text-sm text-ink-500">Export your items from {label} to Excel or CSV and upload the file. GoKesari matches them to your products and updates stock, prices and tax rates.</p>
        <input
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void send(f);
            e.target.value = "";
          }}
          className="block w-full text-sm"
        />
        {upload && upload.status === "UPLOADED" ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-700">
              <b>{upload.fileName}</b> — {upload.rowCount} rows. Check which column is which:
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(upload.fields).map(([field, info]) => (
                <Field key={field} label={`${info.label}${info.required ? " *" : ""}`} hint={info.hint || undefined}>
                  <select className={inputClass} value={mapping[field] ?? ""} onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}>
                    <option value="">— not in the file —</option>
                    {upload.headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead>
                  <tr>{upload.headers.map((h) => <th key={h} className="border-b px-2 py-1 text-left font-medium">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {upload.sampleRows.map((row, i) => (
                    <tr key={i}>{upload.headers.map((h, j) => <td key={h} className="border-b px-2 py-1">{row[j]}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <Button disabled={busy || !mapping.name} onClick={() => void apply()}>Apply {upload.rowCount} rows</Button>
              <Button variant="secondary" disabled={busy} onClick={async () => {
                await fetch(`${base}/imports/${upload.id}`, { method: "DELETE" });
                setUpload(null);
              }}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {upload?.status === "APPLIED" && upload.summary ? <Summary summary={upload.summary} /> : null}
        {recent.length ? (
          <ul className="divide-y divide-cream-200 text-sm">
            {recent.map((r) => (
              <li key={r.id} className="py-2">
                <span className="font-medium">{r.fileName}</span> <Badge tone={r.status === "APPLIED" ? "success" : r.status === "CANCELLED" ? "neutral" : "info"}>{r.status === "APPLIED" && !r.appliedAt ? "applying" : r.status.toLowerCase()}</Badge>
                {r.summary ? <Summary summary={r.summary} /> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-base font-semibold text-ink-900">2. Put GoKesari sales into {label}</h2>
        <p className="text-sm text-ink-500">
          {waiting > 0 ? `${waiting} invoices / credit notes are ready to download.` : "Nothing new to download."} “New” files contain only what you have not downloaded before, so importing them never duplicates a sale. Each row carries GoKesari&apos;s invoice number.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => download("invoices", "new", "xlsx")}>New invoices (Excel)</Button>
          <Button size="sm" variant="secondary" onClick={() => download("credit-notes", "new", "xlsx")}>New credit notes (Excel)</Button>
          <Button size="sm" variant="secondary" onClick={() => download("stock-out", "new", "xlsx")}>New stock movement (Excel)</Button>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-700">Download a date range again (CSV or Excel)</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Field label="From"><input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["invoices", "credit-notes", "stock-out"] as const).map((kind) => (
              <Button key={kind} size="sm" variant="secondary" disabled={!from || !to} onClick={() => download(kind, "range", "csv")}>
                {kind.replace("-", " ")} (CSV)
              </Button>
            ))}
          </div>
        </details>
      </Card>
    </div>
  );
}

function Summary({ summary }: { summary: Record<string, number> }) {
  return (
    <p className="mt-1 text-xs text-ink-500">
      {summary.seen ?? 0} items read · {summary.applied ?? 0} updated · {summary.unchanged ?? 0} unchanged · {(summary.suggested ?? 0) + (summary.unmatched ?? 0)} to match
      {summary.issues ? ` · ${summary.issues} with a problem` : ""}
      {summary.invalid ? ` · ${summary.invalid} rows skipped` : ""}
    </p>
  );
}
