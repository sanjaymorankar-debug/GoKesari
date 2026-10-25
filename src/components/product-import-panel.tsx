"use client";

/**
 * Bulk product upload (docs/product-import-2026-10): upload a spreadsheet →
 * it is checked in the background (nothing changes yet) → the preview with
 * every row and its warnings → choose how stock is applied → Import → the
 * result and its report. The same screen serves the shop owner and, with a
 * shop chosen, operators and admins; it works the same inside the Android and
 * iPhone apps (the file picker opens the phone's Files / Drive / WhatsApp
 * documents). Everything goes through /api/v1, as the apps' calls do.
 */
import clsx from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";
import { formatPaiseCompact } from "@/lib/money";
import { IMPORT_ACCEPT, plannedStock, type ImportCounts, type ImportRowPlan, type InventoryMode } from "@/lib/product-import";

interface JobView {
  id: string;
  shopId: string;
  shopName: string;
  userName: string | null;
  fileName: string;
  fileSizeBytes: number;
  sourceFormat: string | null;
  sheetName: string | null;
  inventoryMode: InventoryMode;
  status: "uploaded" | "parsing" | "preview_ready" | "importing" | "completed" | "failed" | "cancelled";
  counts: ImportCounts;
  messages: string[];
  errorMessage: string | null;
  imagesStatus: "none" | "queued" | "running" | "done";
  createdAt: string;
  finishedAt: string | null;
  purgedAt: string | null;
  stalled: boolean;
}

interface RowView {
  rowNumber: number;
  sku: string | null;
  action: "UPSERT" | "EDIT" | "DELETE";
  matchType: string | null;
  status: "ready" | "skipped" | "created" | "updated" | "deactivated" | "failed";
  messages: string[];
  plan: ImportRowPlan | null;
}

const PAGE_SIZE = 50;
const API = "/api/v1/product-imports";

const STATUS_TONE: Record<JobView["status"], "neutral" | "info" | "success" | "warning" | "danger"> = {
  uploaded: "info",
  parsing: "info",
  preview_ready: "warning",
  importing: "info",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
};
const STATUS_LABEL: Record<JobView["status"], string> = {
  uploaded: "Uploaded",
  parsing: "Checking",
  preview_ready: "Ready to import",
  importing: "Importing",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const ROW_TONE: Record<RowView["status"], "neutral" | "info" | "success" | "warning" | "danger"> = {
  ready: "info",
  skipped: "neutral",
  created: "success",
  updated: "success",
  deactivated: "warning",
  failed: "danger",
};
const OUTCOME_LABEL: Record<string, string> = { create: "New", update: "Update", deactivate: "Deactivate", skip: "Skip" };
const ACTION_LABEL: Record<RowView["action"], string> = { UPSERT: "Create or update", EDIT: "Edit only", DELETE: "Delete" };

const money = (p: number | null | undefined) => (p == null ? "—" : formatPaiseCompact(p));
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? fallback;
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: number; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) {
  const tones = {
    neutral: "border-cream-200 bg-white",
    success: "border-leaf-300 bg-leaf-50",
    warning: "border-amber-200 bg-amber-50",
    danger: "border-red-200 bg-red-50",
    info: "border-sky-200 bg-sky-50",
  } as const;
  return (
    <div className={clsx("rounded-xl border p-3 shadow-sm", tones[tone])} data-testid={`stat-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      <p className="text-2xl font-semibold tabular-nums text-ink-900">{value.toLocaleString("en-IN")}</p>
      <p className="text-xs font-medium text-ink-600">{label}</p>
    </div>
  );
}

export function ProductImportPanel({
  shopId,
  shopName,
  limits,
  initialHistory,
  initialJobId,
}: {
  shopId: string;
  shopName: string;
  limits: { maxMb: number; maxRows: number; enabled: boolean };
  initialHistory: JobView[];
  /** An import to open straight away (from a notification or the history). */
  initialJobId?: string | null;
}) {
  const [job, setJob] = useState<JobView | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<{ jobId: string; importedAt: string } | null>(null);
  const [history, setHistory] = useState<JobView[]>(initialHistory);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<InventoryMode>("SET");
  const [rows, setRows] = useState<RowView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<string>("all");
  const inputRef = useRef<HTMLInputElement>(null);

  const loadJob = useCallback(async (id: string) => {
    const res = await fetch(`${API}/${id}`, { cache: "no-store" });
    if (res.ok) {
      const view = (await res.json()) as JobView;
      setJob(view);
      return view;
    }
    setError(await readError(res, "The upload could not be loaded."));
    return null;
  }, []);

  const loadRows = useCallback(async (id: string, p: number, f: string) => {
    const res = await fetch(`${API}/${id}/rows?status=${encodeURIComponent(f)}&page=${p}&pageSize=${PAGE_SIZE}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { rows: RowView[]; total: number };
    setRows(body.rows);
    setTotal(body.total);
  }, []);

  const loadHistory = useCallback(async () => {
    const res = await fetch(`/api/v1/shops/${shopId}/product-imports`, { cache: "no-store" });
    if (res.ok) setHistory(((await res.json()) as { imports: JobView[] }).imports);
  }, [shopId]);

  // Data loads run from a timer callback, never synchronously inside the effect.
  useEffect(() => {
    if (!initialJobId) return;
    const t = setTimeout(() => void loadJob(initialJobId), 0);
    return () => clearTimeout(t);
  }, [initialJobId, loadJob]);

  // While the file is being checked or imported, refresh every 1.5 seconds.
  const working = job && (job.status === "uploaded" || job.status === "parsing" || job.status === "importing" || job.imagesStatus === "running" || job.imagesStatus === "queued");
  const jobId = job?.id;
  useEffect(() => {
    if (!working || !jobId) return;
    const t = setInterval(() => void loadJob(jobId), 1500);
    return () => clearInterval(t);
  }, [working, jobId, loadJob]);

  // Rows: on the preview and the result, page by page.
  const status = job?.status;
  useEffect(() => {
    if (!jobId || !(status === "preview_ready" || status === "completed")) return;
    const t = setTimeout(() => void loadRows(jobId, page, filter), 0);
    return () => clearTimeout(t);
  }, [jobId, status, page, filter, loadRows]);

  useEffect(() => {
    if (!(status === "completed" || status === "cancelled" || status === "failed")) return;
    const t = setTimeout(() => void loadHistory(), 0);
    return () => clearTimeout(t);
  }, [status, loadHistory]);

  function choose(f: File | null) {
    setError(null);
    if (!f) return setFile(null);
    if (!/\.(xlsx|xlsm|csv)$/i.test(f.name)) {
      setError("Choose an Excel file (.xlsx or .xlsm) or a CSV file.");
      return;
    }
    if (f.size > limits.maxMb * 1024 * 1024) {
      setError(`The file is too large: the limit is ${limits.maxMb} MB.`);
      return;
    }
    setFile(f);
  }

  async function upload() {
    if (!file) {
      setError("Choose a file first.");
      return;
    }
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/v1/shops/${shopId}/product-imports`, { method: "POST", body: form });
    setBusy(false);
    if (!res.ok) {
      setError(await readError(res, "The file could not be uploaded."));
      return;
    }
    const body = (await res.json()) as { job: JobView; duplicateOf: { jobId: string; importedAt: string } | null };
    setJob(body.job);
    setDuplicateOf(body.duplicateOf);
    setFile(null);
    setPage(1);
    setFilter("all");
    if (inputRef.current) inputRef.current.value = "";
  }

  async function commit() {
    if (!job) return;
    if (duplicateOf && !window.confirm(`This file was already imported on ${when(duplicateOf.importedAt)}. Import it again?`)) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`${API}/${job.id}/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inventoryMode: mode }),
    });
    setBusy(false);
    if (!res.ok) setError(await readError(res, "The import could not be started."));
    setPage(1);
    setFilter("all");
    await loadJob(job.id);
  }

  async function cancel() {
    if (!job) return;
    setBusy(true);
    const res = await fetch(`${API}/${job.id}/cancel`, { method: "POST" });
    setBusy(false);
    if (!res.ok) setError(await readError(res, "The upload could not be cancelled."));
    await loadJob(job.id);
  }

  function startOver() {
    setJob(null);
    setDuplicateOf(null);
    setRows([]);
    setError(null);
  }

  const counts = job?.counts;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const preview = job?.status === "preview_ready";
  const done = job?.status === "completed";
  const progress = useMemo(() => {
    if (!job || !counts || counts.totalRows === 0) return 0;
    return Math.min(100, Math.round((counts.processedRows / counts.totalRows) * 100));
  }, [job, counts]);

  return (
    <div className="space-y-5" data-testid="product-import-panel">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!limits.enabled ? <Alert tone="warning">Bulk upload is switched off at the moment.</Alert> : null}

      {/* ------------------------------------------------------------- upload */}
      {!job || job.status === "cancelled" || job.status === "failed" ? (
        <Card className="space-y-4 p-4" data-testid="product-import-upload">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-ink-900">Upload a product file for {shopName}</h2>
              <p className="text-xs text-ink-500">
                Excel (.xlsx, .xlsm) or CSV, up to {limits.maxMb} MB and {limits.maxRows.toLocaleString("en-IN")} rows. Every column is optional.
              </p>
            </div>
            <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100" href={`${API}/template`} data-testid="download-template">
              Download GoKesari template
            </a>
          </div>
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(e.dataTransfer.files?.[0] ?? null);
            }}
            className={clsx(
              "flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center",
              dragging ? "border-kesari-500 bg-kesari-50" : "border-cream-200 bg-cream-50 hover:bg-cream-100",
            )}
            data-testid="dropzone"
          >
            <p className="text-sm font-medium text-ink-800">{file ? file.name : "Drop the file here, or tap to choose it"}</p>
            <p className="mt-1 text-xs text-ink-500">{file ? `${(file.size / 1024).toFixed(0)} KB` : "From your computer, or on a phone from Files, Drive, WhatsApp or e-mail"}</p>
            <input
              ref={inputRef}
              type="file"
              accept={IMPORT_ACCEPT}
              className="sr-only"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
              data-testid="import-file-input"
            />
          </div>
          <Button size="lg" onClick={upload} disabled={busy || !file || !limits.enabled} data-testid="upload-button">
            {busy ? "Uploading…" : "Upload and check"}
          </Button>
          <details className="rounded-lg bg-cream-50 p-3 text-sm text-ink-700">
            <summary className="cursor-pointer font-medium">How it works</summary>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              <li>
                <strong>Amazon Seller Central inventory files are supported directly</strong> — upload the .xlsm or .xlsx as it is. Macros in the file are never run.
              </li>
              <li>Or use the GoKesari template. All columns are optional; a blank cell never deletes what is saved.</li>
              <li>A row finds its product by your SKU, then the barcode, then name + brand. Nothing matched? A new product is added for you to sell straight away (it waits for catalogue approval).</li>
              <li>Quantity is your stock: set to the file&apos;s number, or added to current stock — you choose before importing.</li>
              <li>Nothing in your shop changes until you check the preview and press Import.</li>
            </ul>
          </details>
        </Card>
      ) : null}

      {/* ------------------------------------------------------------- job */}
      {job ? (
        <Card className="space-y-4 p-4" data-testid="product-import-job">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate font-semibold text-ink-900">
                {job.fileName} <Badge tone={STATUS_TONE[job.status]}>{STATUS_LABEL[job.status]}</Badge>
              </h2>
              <p className="text-xs text-ink-500">
                {job.shopName} · uploaded {when(job.createdAt)}
                {job.userName ? ` by ${job.userName}` : ""}
                {job.sourceFormat ? ` · ${job.sourceFormat === "AMAZON_TEMPLATE" ? "Amazon template" : job.sourceFormat === "GOKESARI_TEMPLATE" ? "GoKesari template" : job.sourceFormat === "CSV" ? "CSV" : "spreadsheet"}` : ""}
              </p>
            </div>
            {done || job.status === "cancelled" || job.status === "failed" ? (
              <Button variant="secondary" onClick={startOver}>
                Upload another file
              </Button>
            ) : null}
          </div>

          {job.status === "uploaded" || job.status === "parsing" ? (
            <div className="space-y-2" aria-live="polite">
              <p className="text-sm text-ink-700">Checking the file… {counts?.parsedRows ? `${counts.parsedRows} rows read` : ""}</p>
              <div className="h-2 w-full overflow-hidden rounded bg-cream-100">
                <div className="h-2 w-1/3 animate-pulse rounded bg-kesari-500" />
              </div>
            </div>
          ) : null}

          {job.status === "failed" ? <Alert tone="danger" title="The file could not be imported">{job.errorMessage ?? "Something went wrong."}</Alert> : null}
          {job.stalled ? <Alert tone="warning">This has made no progress for a few minutes. {job.status === "importing" ? "Press Import again to resume — rows already done are kept." : "Reload the page to start the check again."}</Alert> : null}

          {job.messages.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-600">
              {job.messages.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : null}

          {preview || job.status === "importing" || done ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {done ? (
                <>
                  <Stat label="Created" value={counts!.created} tone="success" />
                  <Stat label="Updated" value={counts!.updated} tone="success" />
                  <Stat label="Deactivated" value={counts!.deactivated} tone="warning" />
                  <Stat label="Skipped" value={counts!.skipped} />
                  <Stat label="Failed" value={counts!.failed} tone={counts!.failed ? "danger" : "neutral"} />
                  <Stat label="With warnings" value={counts!.withWarnings} tone={counts!.withWarnings ? "warning" : "neutral"} />
                </>
              ) : (
                <>
                  <Stat label="Total rows" value={counts!.totalRows} tone="info" />
                  <Stat label="New products" value={counts!.newProducts} tone="success" />
                  <Stat label="Updates" value={counts!.updates} tone="success" />
                  <Stat label="Deactivations" value={counts!.deactivations} tone="warning" />
                  <Stat label="Skipped" value={counts!.skipped} />
                  <Stat label="With warnings" value={counts!.withWarnings} tone={counts!.withWarnings ? "warning" : "neutral"} />
                </>
              )}
            </div>
          ) : null}

          {job.status === "importing" ? (
            <div className="space-y-1" aria-live="polite">
              <p className="text-sm text-ink-700">
                Importing… {counts?.processedRows ?? 0} of {counts?.totalRows ?? 0} rows ({progress}%)
              </p>
              <div className="h-2 w-full overflow-hidden rounded bg-cream-100">
                <div className="h-2 rounded bg-kesari-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-3">
              {duplicateOf ? (
                <Alert tone="warning" title="Already imported">
                  This file was already imported on {when(duplicateOf.importedAt)}. Import it again?
                </Alert>
              ) : null}
              <fieldset className="rounded-lg border border-cream-200 p-3 text-sm" data-testid="inventory-mode">
                <legend className="px-1 font-semibold text-ink-900">Stock from the file&apos;s Quantity</legend>
                <label className="mt-1 flex min-h-11 items-center gap-2">
                  <input type="radio" name="inventoryMode" checked={mode === "SET"} onChange={() => setMode("SET")} /> Set stock to file quantity (recommended)
                </label>
                <label className="flex min-h-11 items-center gap-2">
                  <input type="radio" name="inventoryMode" checked={mode === "ADD"} onChange={() => setMode("ADD")} /> Add file quantity to current stock
                </label>
              </fieldset>
              <div className="flex flex-wrap gap-2">
                <Button size="lg" onClick={commit} disabled={busy} data-testid="commit-button">
                  {busy ? "Starting…" : duplicateOf ? "Import again" : `Import ${counts!.newProducts + counts!.updates + counts!.deactivations} rows`}
                </Button>
                <Button variant="secondary" size="lg" onClick={cancel} disabled={busy}>
                  Cancel
                </Button>
              </div>
              <p className="text-xs text-ink-500">Nothing in your shop has changed yet.</p>
            </div>
          ) : null}

          {done ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="result-actions">
              <a className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800" href={`${API}/${job.id}/report?format=xlsx`} data-testid="report-xlsx">
                Download result report (Excel)
              </a>
              <a className="inline-flex min-h-11 items-center rounded-lg border border-cream-200 bg-white px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100" href={`${API}/${job.id}/report?format=csv`}>
                CSV
              </a>
              {job.imagesStatus === "queued" || job.imagesStatus === "running" ? (
                <span className="text-xs text-ink-600">Downloading product images… ({counts!.imagesQueued})</span>
              ) : job.imagesStatus === "done" ? (
                <span className="text-xs text-ink-600">
                  Images: {counts!.imagesSaved} added{counts!.imagesFailed ? `, ${counts!.imagesFailed} could not be used (see the rows)` : ""}.
                </span>
              ) : null}
            </div>
          ) : null}

          {/* --------------------------------------------------------- rows */}
          {preview || done ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={filter === "warnings"}
                    onChange={(e) => {
                      setFilter(e.target.checked ? "warnings" : "all");
                      setPage(1);
                    }}
                    data-testid="warnings-only"
                  />
                  Only rows with warnings
                </label>
                {done ? (
                  <select
                    className="min-h-11 rounded-lg border border-cream-200 bg-white px-2 text-sm"
                    value={filter === "warnings" ? "all" : filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setPage(1);
                    }}
                    aria-label="Show rows"
                  >
                    {["all", "created", "updated", "deactivated", "skipped", "failed"].map((s) => (
                      <option key={s} value={s}>
                        {s === "all" ? "All rows" : s[0].toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                ) : null}
                <span className="text-xs text-ink-500">{total.toLocaleString("en-IN")} rows</span>
              </div>

              {/* Wide screens: a table. */}
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left text-sm" data-testid="import-rows-table">
                  <thead className="bg-cream-50 text-xs uppercase text-ink-600">
                    <tr>
                      <th className="px-2 py-2">Row #</th>
                      <th className="px-2 py-2">SKU</th>
                      <th className="px-2 py-2">Name</th>
                      <th className="px-2 py-2">Brand</th>
                      <th className="px-2 py-2">Category</th>
                      <th className="px-2 py-2 text-right">MRP</th>
                      <th className="px-2 py-2 text-right">Price</th>
                      <th className="px-2 py-2">Qty</th>
                      <th className="px-2 py-2">Action</th>
                      <th className="px-2 py-2">Warnings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const next = r.plan ? plannedStock(r.plan, done ? job.inventoryMode : mode) : null;
                      return (
                        <tr key={r.rowNumber} className="border-t border-cream-100 align-top">
                          <td className="px-2 py-2 tabular-nums">{r.rowNumber}</td>
                          <td className="px-2 py-2 font-mono text-xs">{r.sku ?? r.plan?.sku ?? "—"}</td>
                          <td className="px-2 py-2">{r.plan?.name ?? "—"}</td>
                          <td className="px-2 py-2">{r.plan?.brand ?? "—"}</td>
                          <td className="px-2 py-2">{r.plan?.category ?? "—"}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{money(r.plan?.mrpPaise)}</td>
                          <td className="px-2 py-2 text-right tabular-nums">{money(r.plan?.pricePaise)}</td>
                          <td className="px-2 py-2 tabular-nums">
                            {r.plan ? `${r.plan.currentQty ?? "new"} → ${next ?? "unchanged"}` : "—"}
                          </td>
                          <td className="px-2 py-2">
                            {done || r.status === "skipped" ? (
                              <Badge tone={ROW_TONE[r.status]}>{r.status}</Badge>
                            ) : (
                              <Badge tone="info">{OUTCOME_LABEL[r.plan?.outcome ?? "skip"]}</Badge>
                            )}
                            <span className="mt-0.5 block text-[11px] text-ink-500">{ACTION_LABEL[r.action]}</span>
                          </td>
                          <td className="px-2 py-2 text-xs text-ink-700">
                            {r.messages.length ? (
                              <ul className="list-disc space-y-0.5 pl-4">
                                {r.messages.map((m) => (
                                  <li key={m}>{m}</li>
                                ))}
                              </ul>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Phones (and the apps): one card per row. */}
              <ul className="space-y-2 md:hidden" data-testid="import-rows-cards">
                {rows.map((r) => {
                  const next = r.plan ? plannedStock(r.plan, done ? job.inventoryMode : mode) : null;
                  return (
                    <li key={r.rowNumber} className="rounded-xl border border-cream-200 bg-white p-3 text-sm shadow-sm">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-ink-900">{r.plan?.name ?? r.sku ?? `Row ${r.rowNumber}`}</p>
                          <p className="text-xs text-ink-500">
                            Row {r.rowNumber}
                            {r.sku ? ` · ${r.sku}` : ""}
                            {r.plan?.brand ? ` · ${r.plan.brand}` : ""}
                          </p>
                        </div>
                        {done || r.status === "skipped" ? (
                          <Badge tone={ROW_TONE[r.status]}>{r.status}</Badge>
                        ) : (
                          <Badge tone="info">{OUTCOME_LABEL[r.plan?.outcome ?? "skip"]}</Badge>
                        )}
                      </div>
                      {r.plan ? (
                        <p className="mt-1 text-xs text-ink-700">
                          MRP {money(r.plan.mrpPaise)} · Price {money(r.plan.pricePaise)} · Qty {r.plan.currentQty ?? "new"} → {next ?? "unchanged"}
                          {r.plan.category ? ` · ${r.plan.category}` : ""}
                        </p>
                      ) : null}
                      {r.messages.length ? (
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-amber-800">
                          {r.messages.map((m) => (
                            <li key={m}>{m}</li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {pages > 1 ? (
                <div className="flex items-center justify-between gap-2">
                  <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <span className="text-xs text-ink-600">
                    Page {page} of {pages}
                  </span>
                  <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ------------------------------------------------------------- history */}
      <Card className="p-4" data-testid="product-import-history">
        <h2 className="mb-2 font-semibold text-ink-900">Import history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-ink-500">No uploads yet.</p>
        ) : (
          <ul className="divide-y divide-cream-100 text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button type="button" className="min-h-11 min-w-0 text-left" onClick={() => void loadJob(h.id)}>
                  <span className="block truncate font-medium text-kesari-700 underline">{h.fileName}</span>
                  <span className="block text-xs text-ink-500">
                    {when(h.createdAt)}
                    {h.userName ? ` · ${h.userName}` : ""} · {h.shopName}
                    {h.status === "completed"
                      ? ` · ${h.counts.created} created, ${h.counts.updated} updated, ${h.counts.deactivated} deactivated, ${h.counts.failed} failed`
                      : ` · ${h.counts.totalRows} rows`}
                  </span>
                </button>
                <span className="flex items-center gap-2">
                  <Badge tone={STATUS_TONE[h.status]}>{STATUS_LABEL[h.status]}</Badge>
                  {h.status === "completed" && !h.purgedAt ? (
                    <a className="text-xs text-kesari-700 underline" href={`${API}/${h.id}/report?format=xlsx`}>
                      Report
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
