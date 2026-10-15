"use client";

/**
 * "Import from GST portal" (docs/inventory-accounting-2026-10, Part 3): pull
 * GSTR-2B / 2A / 1 through the linked GSTIN, or — always available — upload
 * the JSON or Excel file downloaded from gst.gov.in. The import is
 * reconciled with the books right away; the result is announced and the
 * page refreshed.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

import { accountsApi, ApiError, uploadWithProgress } from "./api";

interface ImportResult {
  importId: string;
  returnType: "GSTR2B" | "GSTR2A" | "GSTR1";
  period: string;
  invoices: number;
  warnings: string[];
  recon: { period: string; source: string | null; counts: { MATCHED: number; AMOUNT_MISMATCH: number; MISSING_IN_BOOKS: number; MISSING_ON_PORTAL: number } } | null;
}

const RETURN_LABEL: Record<ImportResult["returnType"], string> = { GSTR2B: "GSTR-2B", GSTR2A: "GSTR-2A", GSTR1: "GSTR-1" };

export function GstImportPanel({ shopId, canPull, defaultPeriod, shopQuery = "" }: { shopId: string; canPull: boolean; defaultPeriod: string; shopQuery?: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pullType, setPullType] = useState<ImportResult["returnType"]>("GSTR2B");
  const [pullPeriod, setPullPeriod] = useState(defaultPeriod);
  const [uploadType, setUploadType] = useState<"" | ImportResult["returnType"]>("");
  const [uploadPeriod, setUploadPeriod] = useState(defaultPeriod);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState<"pull" | "upload" | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function run(kind: "pull" | "upload", action: () => Promise<ImportResult>) {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      setResult(await action());
      router.refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  const pull = () => run("pull", () => accountsApi<ImportResult>(shopId, "gst/pull", { method: "POST", body: { returnType: pullType, period: pullPeriod } }));

  const upload = () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose the file you downloaded from gst.gov.in.");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("period", uploadPeriod);
    if (uploadType) form.append("returnType", uploadType);
    setProgress(0);
    void run("upload", async () => {
      const r = await uploadWithProgress<ImportResult>(`/api/shops/${shopId}/accounts/gst/import`, form, setProgress);
      if (fileRef.current) fileRef.current.value = "";
      setFileName(null);
      return r;
    });
  };

  return (
    <div className="space-y-4 text-sm">
      {canPull ? (
        <form
          className="space-y-3 rounded-xl border border-[var(--gk-line)] bg-violet-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void pull();
          }}
        >
          <p className="font-semibold text-ink-900">Pull from the portal (linked GSTIN)</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label="Return">
              <select className={`${inputClass} min-h-11`} value={pullType} onChange={(e) => setPullType(e.target.value as ImportResult["returnType"])}>
                <option value="GSTR2B">GSTR-2B (your ITC statement)</option>
                <option value="GSTR2A">GSTR-2A</option>
                <option value="GSTR1">GSTR-1 (your sales return)</option>
              </select>
            </Field>
            <Field label="Month">
              <input type="month" className={`${inputClass} min-h-11`} value={pullPeriod} onChange={(e) => setPullPeriod(e.target.value)} required />
            </Field>
            <Button type="submit" disabled={busy !== null || !pullPeriod}>
              {busy === "pull" ? "Pulling…" : "Pull now"}
            </Button>
          </div>
        </form>
      ) : null}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          upload();
        }}
      >
        <p className="font-semibold text-ink-900">Upload the file from gst.gov.in</p>
        <ol className="list-decimal space-y-0.5 pl-5 text-ink-700">
          <li>
            Log in at <strong>gst.gov.in</strong> → <strong>Services</strong> → <strong>Returns</strong> → <strong>Returns Dashboard</strong>.
          </li>
          <li>Choose the year and month, then open <strong>GSTR-2B</strong> (or 2A / GSTR-1).</li>
          <li>
            <strong>Download</strong> — JSON or Excel — and choose that file here.
          </li>
        </ol>
        <Field label="Portal file (JSON or Excel)" hint={fileName ?? "From your phone's Downloads, or your computer"}>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.xlsx,.xls,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="block min-h-11 w-full text-sm file:mr-3 file:min-h-10 file:rounded-lg file:border-0 file:bg-kesari-600 file:px-3 file:font-semibold file:text-white"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            required
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Month">
            <input type="month" className={`${inputClass} min-h-11`} value={uploadPeriod} onChange={(e) => setUploadPeriod(e.target.value)} required />
          </Field>
          <Field label="Return">
            <select className={`${inputClass} min-h-11`} value={uploadType} onChange={(e) => setUploadType(e.target.value as "" | ImportResult["returnType"])}>
              <option value="">Auto-detect</option>
              <option value="GSTR2B">GSTR-2B</option>
              <option value="GSTR2A">GSTR-2A</option>
              <option value="GSTR1">GSTR-1</option>
            </select>
          </Field>
          <Button type="submit" disabled={busy !== null || !uploadPeriod}>
            {busy === "upload" ? (progress != null && progress < 100 ? `Uploading ${progress}%` : "Reading the file…") : "Import file"}
          </Button>
        </div>
        {progress != null ? (
          <div className="h-2 overflow-hidden rounded-full bg-cream-200" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <div className="h-full bg-kesari-600 transition-[width]" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
      </form>

      <div aria-live="polite" className="space-y-2">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {result ? (
          <Alert tone="success" title={`${RETURN_LABEL[result.returnType]} for ${result.period}: ${result.invoices} invoice(s) imported`}>
            {result.recon ? (
              <p>
                Reconciled: {result.recon.counts.MATCHED} matched, {result.recon.counts.AMOUNT_MISMATCH} amount mismatch, {result.recon.counts.MISSING_IN_BOOKS} missing in your books,{" "}
                {result.recon.counts.MISSING_ON_PORTAL} missing on the portal.{" "}
                <Link href={`/shop/accounts/gst/reconcile?period=${result.period}${shopQuery ? `&${shopQuery.slice(1)}` : ""}`} className="font-semibold underline">
                  See the details
                </Link>
              </p>
            ) : (
              <p>GSTR-1 is your own sales return; it is kept for reference and not reconciled with purchase bills.</p>
            )}
            {result.warnings.length ? (
              <ul className="mt-1 list-disc pl-5 text-amber-900">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
