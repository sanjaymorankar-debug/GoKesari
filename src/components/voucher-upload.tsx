"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Alert, Badge, Button, Card, Money } from "@/components/ui";

interface PreviewRow {
  rowNumber: number;
  name: string;
  code: string;
  bonusPercent: number | null;
  minimumTopupPaise: number | null;
  maximumBonusPaise: number | null;
  startDate: string | null;
  endDate: string | null;
  status: "VALID" | "DUPLICATE_IN_FILE" | "DUPLICATE_EXISTING" | "INVALID";
  errorMessage: string | null;
}

interface Preview {
  uploadId: string;
  fileName: string;
  rows: PreviewRow[];
  counts: { total: number; valid: number; invalid: number; duplicate: number };
}

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  VALID: "Create",
  DUPLICATE_IN_FILE: "Duplicate in file",
  DUPLICATE_EXISTING: "Already exists",
  INVALID: "Invalid",
};

/** Voucher list Excel upload (§16). Validate-then-confirm, same discipline as every other upload in this app. */
export function VoucherUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/voucher-uploads", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "That file could not be read.");
      setPreview(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/voucher-uploads/${preview.uploadId}/apply`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? "That did not work.");
      setNotice(`${payload.created} voucher(s) created.`);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink-900">Upload voucher list</h2>
        <a href="/api/voucher-uploads/template" className="text-sm font-medium text-kesari-600 hover:underline">
          Download template →
        </a>
      </div>

      {error ? <Alert tone="danger" title="Could not process">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Done">{notice}</Alert> : null}

      {!preview ? (
        <Card className="p-4">
          <p className="mb-3 text-sm text-ink-600">
            Download the template, fill in Voucher Name, Code, Bonus %, Min
            Top-Up, Max Bonus, Start and End Date, then upload it here.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xlsm"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            className="block w-full text-sm text-ink-600 file:mr-3 file:rounded-lg file:border-0 file:bg-kesari-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-kesari-800"
          />
        </Card>
      ) : (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink-900">{preview.fileName}</span>
            <Badge>{preview.counts.total} rows</Badge>
            <Badge>{preview.counts.valid} to create</Badge>
            {preview.counts.invalid > 0 ? <Badge>{preview.counts.invalid} invalid</Badge> : null}
            {preview.counts.duplicate > 0 ? <Badge>{preview.counts.duplicate} duplicate</Badge> : null}
          </div>

          <div className="max-h-96 overflow-auto rounded-lg border border-cream-200">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Voucher</th>
                  <th className="px-3 py-2">Bonus</th>
                  <th className="px-3 py-2">Min / Max</th>
                  <th className="px-3 py-2">Valid</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-3 py-2 text-ink-500">{row.rowNumber}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-ink-900">{row.name || "—"}</span>
                      <span className="ml-1 text-xs text-ink-500">{row.code}</span>
                      {row.errorMessage ? <p className="text-xs text-red-700">{row.errorMessage}</p> : null}
                    </td>
                    <td className="px-3 py-2">{row.bonusPercent != null ? `${row.bonusPercent}%` : "—"}</td>
                    <td className="px-3 py-2 text-xs">
                      {row.minimumTopupPaise != null ? <Money paise={row.minimumTopupPaise} /> : "—"}
                      {row.maximumBonusPaise != null ? (
                        <>
                          {" / "}
                          <Money paise={row.maximumBonusPaise} />
                        </>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-xs">{row.startDate} → {row.endDate}</td>
                    <td className="px-3 py-2">
                      <Badge>{STATUS_LABEL[row.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button disabled={busy || preview.counts.valid === 0} onClick={confirm}>
              Create {preview.counts.valid} voucher(s)
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              Discard
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            Only rows marked &ldquo;Create&rdquo; are applied. Invalid and
            duplicate rows are skipped and never overwrite existing vouchers.
          </p>
        </Card>
      )}
    </section>
  );
}
