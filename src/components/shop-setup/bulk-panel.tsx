"use client";

/**
 * Excel / CSV: download, upload, preview, confirm, result. Used by step 2 and
 * by My products. Downloads are plain attachment links and the upload is a
 * normal file input, so the phone apps' file picker and share sheet handle them.
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { postJson } from "@/components/save-changes-bar";
import { Alert, Button, Card } from "@/components/ui";
import type { UploadView } from "@/server/services/shop-bulk-upload";
import { ResultSummary } from "./result-summary";

interface HistoryRow {
  id: string;
  fileName: string;
  status: string;
  counts: UploadView["counts"];
  uploadedBy: string;
  createdAtIst: string;
}

const STATUS_WORD: Record<string, string> = {
  CHECKING: "Checking",
  READY: "Waiting for you",
  REJECTED: "Not accepted",
  APPLYING: "Importing",
  DONE: "Imported",
  CANCELLED: "Cancelled",
  FAILED: "Stopped",
};

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-cream-50 p-3 text-center">
      <p className="text-2xl font-bold text-ink-900">{value}</p>
      <p className="text-xs text-ink-500">{label}</p>
    </div>
  );
}

export function BulkPanel({
  shopId,
  kind,
  maxRows,
  maxFileMb,
  hasCategories,
  chooseHref,
  needsHref,
  productsHref,
}: {
  shopId: string;
  kind: "template" | "mine";
  maxRows: number;
  maxFileMb: number;
  hasCategories: boolean;
  chooseHref: string;
  needsHref: string;
  productsHref: string;
}) {
  const router = useRouter();
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [upload, setUpload] = useState<UploadView | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const base = `/api/shops/${shopId}/product-setup`;

  const loadHistory = useCallback(async () => {
    const response = await fetch(`${base}/uploads`);
    if (response.ok) setHistory((await response.json()).uploads);
  }, [base]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads from the server; state is set after the await
    void loadHistory();
  }, [loadHistory]);

  const uploadId = upload?.id;
  const working = upload?.status === "CHECKING" || upload?.status === "APPLYING";
  useEffect(() => {
    if (!uploadId || !working) return;
    const timer = setInterval(async () => {
      const response = await fetch(`${base}/uploads/${uploadId}`);
      if (!response.ok) return;
      const next = (await response.json()) as UploadView;
      setUpload(next);
      if (next.status !== "CHECKING" && next.status !== "APPLYING") {
        void loadHistory();
        router.refresh();
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [uploadId, working, base, loadHistory, router]);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    setUpload(null);
    setConfirmPause(false);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch(`${base}/uploads`, { method: "POST", body: form });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error?.message ?? "The file could not be uploaded.");
      const view = await fetch(`${base}/uploads/${payload.uploadId}`);
      setUpload((await view.json()) as UploadView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The file could not be uploaded.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function confirm() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      setUpload(await postJson<UploadView>(`${base}/uploads/${upload.id}/confirm`, "POST", { confirmPause }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import could not start.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!upload) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`${base}/uploads/${upload.id}/cancel`, "POST");
      setUpload(null);
      void loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  if (kind === "template" && !hasCategories) {
    return (
      <Alert tone="warning" title="Choose a category first">
        The file lists the products of the categories you sell. <a className="font-medium underline" href={chooseHref}>Choose categories</a>
      </Alert>
    );
  }

  const c = upload?.counts;
  const importable = c ? c.goLive + c.needsStock + c.needsPrice + c.outOfStock + c.update + c.pause : 0;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <h3 className="font-semibold text-ink-900">1. Download</h3>
        <p className="text-sm text-ink-500">
          {kind === "template" ? "A file with the products of your chosen categories." : "A file with the products in your shop."} Fill in the white columns only.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex gap-3 text-sm text-ink-700">
            <legend className="sr-only">File type</legend>
            {(["xlsx", "csv"] as const).map((f) => (
              <label key={f} className="flex min-h-11 items-center gap-1.5">
                <input type="radio" name="bulk-format" className="accent-kesari-600" checked={format === f} onChange={() => setFormat(f)} />
                {f === "xlsx" ? "Excel (.xlsx)" : "CSV"}
              </label>
            ))}
          </fieldset>
          <a
            href={`${base}/download?kind=${kind}&format=${format}`}
            className="inline-flex min-h-11 items-center rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800"
          >
            {kind === "template" ? "Download template" : "Download my products"}
          </a>
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold text-ink-900">2. {kind === "template" ? "Upload your file" : "Upload updates"}</h3>
        <p className="text-sm text-ink-500">
          Excel (.xlsx) or CSV, up to {maxRows.toLocaleString("en-IN")} products and {maxFileMb} MB. Nothing is saved until you confirm.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          disabled={busy || working}
          aria-label="Choose your file"
          className="block w-full text-sm text-ink-700 file:mr-3 file:min-h-11 file:rounded-lg file:border-0 file:bg-cream-100 file:px-4 file:text-sm file:font-medium"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void send(file);
          }}
        />
      </Card>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {upload?.status === "CHECKING" ? (
        <Alert tone="info">Checking your file… you can stay on this page.</Alert>
      ) : null}

      {upload?.status === "REJECTED" || upload?.status === "FAILED" ? <Alert tone="danger">{upload.failure}</Alert> : null}

      {upload?.status === "APPLYING" ? (
        <Card className="space-y-2 p-4" role="status">
          <p className="text-sm text-ink-700">
            Importing… {upload.appliedRows} of {upload.totalRows}. You can leave this page; we will notify you when it is done.
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-cream-100">
            <div className="h-full bg-kesari-600" style={{ width: `${upload.totalRows ? (upload.appliedRows / upload.totalRows) * 100 : 0}%` }} />
          </div>
        </Card>
      ) : null}

      {upload?.status === "READY" && c ? (
        <Card className="space-y-4 p-4" data-testid="upload-preview">
          <h3 className="font-semibold text-ink-900">3. Check and confirm</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Count label="Will go live" value={c.goLive} />
            <Count label="Needs stock" value={c.needsStock} />
            <Count label="Needs price" value={c.needsPrice} />
            <Count label="Will update" value={c.update} />
            <Count label="Will pause" value={c.pause} />
            <Count label="Errors" value={c.errors} />
          </div>
          {c.pause > 0 ? (
            <label className="flex items-start gap-2 text-sm text-ink-700">
              <input type="checkbox" className="mt-0.5 size-5 accent-kesari-600" checked={confirmPause} onChange={(e) => setConfirmPause(e.target.checked)} />
              <span>
                Yes, pause {c.pause} {c.pause === 1 ? "product" : "products"} marked No. Customers will stop seeing them; nothing is deleted.
              </span>
            </label>
          ) : null}
          {upload.errorCount > 0 ? (
            <div className="space-y-2">
              <ul className="max-h-64 space-y-1 overflow-y-auto text-sm" data-testid="upload-errors">
                {upload.errors.map((e) => (
                  <li key={`${e.row}-${e.message}`} className="text-ink-700">
                    <span className="font-medium">Row {e.row}:</span> {e.message}
                  </li>
                ))}
              </ul>
              {upload.errorCount > upload.errors.length ? (
                <p className="text-xs text-ink-500">Showing {upload.errors.length} of {upload.errorCount}. The error file has them all.</p>
              ) : null}
              <a className="inline-flex min-h-11 items-center text-sm font-medium text-kesari-700 underline" href={`${base}/uploads/${upload.id}/errors`}>
                Download error file
              </a>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || importable === 0} onClick={confirm}>
              {upload.errorCount > 0 ? "Import valid rows and skip errors" : "Import"}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {upload?.status === "DONE" && upload.result ? (
        <div className="space-y-2">
          <ResultSummary
            live={upload.result.live ?? 0}
            needs={upload.result.needsStockOrPrice ?? 0}
            outOfStock={upload.result.outOfStock ?? 0}
            needsHref={needsHref}
            productsHref={productsHref}
          />
          {upload.errorCount > 0 ? (
            <a className="inline-flex min-h-11 items-center text-sm font-medium text-kesari-700 underline" href={`${base}/uploads/${upload.id}/errors`}>
              Download error file ({upload.errorCount} rows skipped)
            </a>
          ) : null}
        </div>
      ) : null}

      {history.length > 0 ? (
        <details className="rounded-2xl border border-cream-200 bg-white p-4 text-sm">
          <summary className="min-h-6 cursor-pointer font-medium text-ink-900">Upload history</summary>
          <ul className="mt-3 divide-y divide-cream-100">
            {history.map((h) => (
              <li key={h.id} className="py-2">
                <span className="block break-all font-medium text-ink-900">{h.fileName}</span>
                <span className="block text-xs text-ink-500">
                  {h.createdAtIst} IST · {h.uploadedBy} · {STATUS_WORD[h.status] ?? h.status} · {h.counts.totalRows} rows, {h.counts.errors} errors
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
