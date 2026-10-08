"use client";

/**
 * Module 1: bulk photos (ZIP named by SKU/barcode) and descriptions (CSV) for
 * a shop. Upload → check (nothing changes yet) → Apply, with live progress.
 */
import { useCallback, useEffect, useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import type { MediaImportView } from "@/server/services/shop-media-import";

type Item = MediaImportView["items"][number];

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  MATCHED: "info",
  APPLIED: "success",
  UNMATCHED: "warning",
  INVALID: "danger",
  DUPLICATE: "warning",
  FAILED: "danger",
  SKIPPED: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  MATCHED: "Ready",
  APPLIED: "Done",
  UNMATCHED: "Not found",
  INVALID: "Cannot use",
  DUPLICATE: "Duplicate",
  FAILED: "Failed",
  SKIPPED: "Skipped",
};

interface PastUpload {
  id: string;
  status: string;
  archiveName: string | null;
  csvName: string | null;
  totals: Record<string, number>;
  createdAt: string;
}

export function ShopMediaImport({
  shopId,
  limits,
  past,
  initial,
}: {
  shopId: string;
  limits: { maxPhotos: number; zipMaxMb: number; zipMaxFiles: number; maxUploadMb: number };
  past: PastUpload[];
  /** An upload to open straight away (from a notification link). */
  initial: MediaImportView | null;
}) {
  const base = `/api/shops/${shopId}/media-imports`;
  const [zip, setZip] = useState<File | null>(null);
  const [csv, setCsv] = useState<File | null>(null);
  const [mode, setMode] = useState<"REPLACE" | "ADD">("REPLACE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<MediaImportView | null>(initial);
  const [filter, setFilter] = useState<string>("all");

  const load = useCallback(
    async (id: string) => {
      const res = await fetch(`${base}/${id}`, { cache: "no-store" });
      if (res.ok) setCurrent(await res.json());
    },
    [base],
  );

  // While applying, refresh every 2 seconds until it finishes.
  const applying = current?.import.status === "APPLYING";
  const currentId = current?.import.id;
  useEffect(() => {
    if (!applying || !currentId) return;
    const t = setInterval(() => void load(currentId), 2000);
    return () => clearInterval(t);
  }, [applying, currentId, load]);

  async function check() {
    if (!zip && !csv) {
      setError("Choose a ZIP of photos, a CSV of descriptions, or both.");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    if (zip) form.append("zip", zip);
    if (csv) form.append("csv", csv);
    form.append("photoMode", mode);
    const res = await fetch(base, { method: "POST", body: form });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "The upload could not be checked.");
      return;
    }
    setCurrent(body);
    setFilter("all");
  }

  async function apply() {
    if (!current) return;
    if (
      current.replaces.length > 0 &&
      !window.confirm(`This replaces your own photos of ${current.replaces.length} product(s). Continue?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}/${current.import.id}/apply`, { method: "POST" });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) setError(body?.error?.message ?? "Could not start applying.");
    await load(current.import.id);
  }

  async function cancel() {
    if (!current) return;
    setBusy(true);
    const res = await fetch(`${base}/${current.import.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not cancel.");
    }
    await load(current.import.id);
  }

  const items = current?.items ?? [];
  const counts = items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.status]: (acc[i.status] ?? 0) + 1 }), {});
  const shown = filter === "all" ? items : items.filter((i) => i.status === filter);
  const ready = counts.MATCHED ?? 0;
  const stalled = Boolean(current?.stalled);

  return (
    <div className="space-y-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {!current || ["APPLIED", "PARTIAL", "CANCELLED", "FAILED"].includes(current.import.status) ? (
        <Card className="space-y-4 p-4">
          <div>
            <h2 className="font-semibold text-ink-900">1. Photos (ZIP)</h2>
            <p className="text-xs text-ink-500">
              Name each photo by product code or barcode: <code>P00012.jpg</code>, <code>P00012_2.jpg</code> (2nd photo),{" "}
              <code>8901234567890.png</code>. Up to {limits.maxPhotos} per product, {limits.maxUploadMb} MB each; ZIP up to{" "}
              {limits.zipMaxMb} MB and {limits.zipMaxFiles} photos.
            </p>
            <input
              type="file"
              accept=".zip,application/zip"
              className="mt-2 block w-full text-sm"
              onChange={(e) => setZip(e.target.files?.[0] ?? null)}
              data-testid="zip-input"
            />
          </div>
          <div>
            <h2 className="font-semibold text-ink-900">2. Descriptions (CSV)</h2>
            <p className="text-xs text-ink-500">
              Columns: <code>sku_or_barcode</code>, <code>short_description</code>, <code>long_description</code>. An empty cell leaves
              that text unchanged.{" "}
              <a className="text-kesari-700 underline" href={`${base}/template`}>
                Download the template
              </a>
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              className="mt-2 block w-full text-sm"
              onChange={(e) => setCsv(e.target.files?.[0] ?? null)}
              data-testid="csv-input"
            />
          </div>
          <fieldset className="text-sm">
            <legend className="font-semibold text-ink-900">Photos already in your shop</legend>
            <label className="mt-1 flex items-center gap-2">
              <input type="radio" checked={mode === "REPLACE"} onChange={() => setMode("REPLACE")} /> Replace them with the ZIP&apos;s photos
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={mode === "ADD"} onChange={() => setMode("ADD")} /> Keep them and add the ZIP&apos;s photos
            </label>
          </fieldset>
          <Button size="lg" onClick={check} disabled={busy}>
            {busy ? "Checking…" : "Check upload"}
          </Button>
          <p className="text-xs text-ink-500">Nothing in your shop changes until you press Apply on the next step.</p>
        </Card>
      ) : null}

      {current ? (
        <Card className="space-y-3 p-4" data-testid="import-preview">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-semibold text-ink-900">
                {current.import.archiveName ?? current.import.csvName ?? "Upload"}{" "}
                <Badge tone={current.import.status === "APPLIED" ? "success" : current.import.status === "PARTIAL" ? "warning" : "neutral"}>
                  {current.import.status.toLowerCase()}
                </Badge>
              </h2>
              <p className="text-xs text-ink-500">
                {current.import.photoMode === "REPLACE" ? "Replaces existing photos" : "Adds to existing photos"} ·{" "}
                {new Date(current.import.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
              </p>
            </div>
            {current.import.status === "VALIDATED" ? (
              <div className="flex gap-2">
                <Button onClick={apply} disabled={busy || ready === 0}>
                  Apply {ready} change{ready === 1 ? "" : "s"}
                </Button>
                <Button variant="ghost" onClick={cancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
            ) : null}
            {stalled ? (
              <Button onClick={apply} disabled={busy}>
                Resume
              </Button>
            ) : null}
          </div>

          {applying ? (
            <Alert tone="info">
              Applying… {counts.APPLIED ?? 0} done, {ready} to go. You can leave this page; you will get a notification when it finishes.
            </Alert>
          ) : null}
          {current.replaces.length > 0 && current.import.status === "VALIDATED" ? (
            <Alert tone="warning" title="These products' own photos will be replaced">
              {current.replaces.map((r) => `${r.productName} (${r.photos})`).join(", ")}
            </Alert>
          ) : null}

          <div className="flex flex-wrap gap-2" role="group" aria-label="Show">
            {["all", ...Object.keys(counts)].map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={
                  filter === key
                    ? "rounded-full bg-kesari-600 px-3 py-1 text-xs font-medium text-white"
                    : "rounded-full border border-cream-200 bg-white px-3 py-1 text-xs font-medium text-ink-700"
                }
              >
                {key === "all" ? `All (${items.length})` : `${STATUS_LABEL[key] ?? key} (${counts[key]})`}
              </button>
            ))}
          </div>

          <ul className="divide-y divide-cream-100 text-sm">
            {shown.slice(0, 500).map((item: Item) => (
              <li key={item.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink-800">
                    {item.kind === "PHOTO" ? "📷" : "📝"} {item.sourceName}
                  </p>
                  <p className="text-xs text-ink-500">
                    {item.productName ? `${item.productName} (${item.productCode})` : item.matchKey ? `“${item.matchKey}”` : ""}
                    {item.kind === "PHOTO" && item.position ? ` · photo ${item.position}` : ""}
                    {item.message ? ` · ${item.message}` : ""}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[item.status] ?? "neutral"}>{STATUS_LABEL[item.status] ?? item.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {past.length > 0 ? (
        <Card className="p-4">
          <h2 className="mb-2 font-semibold text-ink-900">Earlier uploads</h2>
          <ul className="divide-y divide-cream-100 text-sm">
            {past.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <button type="button" className="min-w-0 truncate text-left text-kesari-700 hover:underline" onClick={() => void load(p.id)}>
                  {p.archiveName ?? p.csvName ?? "Upload"}
                </button>
                <span className="text-xs text-ink-500">
                  {p.status.toLowerCase()} · {p.totals.applied ?? 0} applied ·{" "}
                  {new Date(p.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
