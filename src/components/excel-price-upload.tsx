"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Alert, Badge, Button, Card, Money } from "@/components/ui";

interface PreviewRow {
  rowNumber: number;
  productCode: string;
  productName: string;
  unit: string;
  category?: string;
  pricePaise: number | null;
  previousPricePaise: number | null;
  differencePaise: number | null;
  status:
    | "VALID"
    | "NO_CHANGE"
    | "INVALID_PRICE"
    | "DUPLICATE"
    | "NOT_FOUND"
    | "MISSING_FIELD"
    | "NEW_PRODUCT";
  errorMessage: string | null;
}

interface Preview {
  uploadId: string;
  fileName: string;
  rows: PreviewRow[];
  counts: {
    total: number;
    valid: number;
    unchanged: number;
    invalid: number;
    duplicate: number;
    notFound: number;
    newProducts: number;
  };
}

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  VALID: "Update",
  NO_CHANGE: "No change",
  INVALID_PRICE: "Invalid price",
  DUPLICATE: "Duplicate",
  NOT_FOUND: "Not found",
  MISSING_FIELD: "Missing field",
  NEW_PRODUCT: "New",
};

/**
 * Excel price upload (§2.3, §8, §24).
 *
 * Two explicit steps, mirroring the server: upload validates and returns a
 * preview; a second click applies it. Nothing about the shop's live prices
 * changes until that second click, which is what the preview exists to inform.
 */
export function ExcelPriceUpload({
  shopId,
  /** False for an operator: their upload becomes a proposal, not a live change. */
  appliesImmediately,
  /** GOODS uploads may create brand-new products; PRICES only ever update existing ones. */
  uploadType = "PRICES",
}: {
  shopId: string;
  appliesImmediately: boolean;
  uploadType?: "PRICES" | "GOODS";
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const form = new FormData();
      form.append("shopId", shopId);
      form.append("file", file);
      form.append("uploadType", uploadType);

      const response = await fetch("/api/excel-uploads", {
        method: "POST",
        body: form,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That file could not be read.");
      }
      setPreview(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!preview) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/excel-uploads/${preview.uploadId}/apply`,
        { method: "POST" },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? "That did not work.");
      }
      const parts: string[] = [];
      if (payload.applied) parts.push(`${payload.applied} price(s) updated`);
      if (payload.created) parts.push(`${payload.created} product(s) added`);
      if (payload.pending) parts.push(`${payload.pending} change(s) sent for approval`);
      setNotice(
        parts.length > 0
          ? `${parts.join(", ")}.${payload.wentLive ? " Now live." : ""}`
          : "Nothing to apply.",
      );
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  async function discard(): Promise<void> {
    if (!preview) return;
    await fetch(`/api/excel-uploads/${preview.uploadId}/apply`, {
      method: "DELETE",
    });
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink-900">
          {uploadType === "GOODS" ? "Upload product list (Excel)" : "Upload price list (Excel)"}
        </h2>
        <a
          href={`/api/shops/${shopId}/price-template${uploadType === "GOODS" ? "?type=goods" : ""}`}
          className="text-sm font-medium text-kesari-600 hover:underline"
        >
          Download template →
        </a>
      </div>

      {error ? <Alert tone="danger" title="Could not process">{error}</Alert> : null}
      {notice ? <Alert tone="success" title="Done">{notice}</Alert> : null}

      {!preview ? (
        <Card className="p-4">
          <p className="mb-3 text-sm text-ink-600">
            {uploadType === "GOODS"
              ? "Download the template, add or edit rows, then upload it here. Rows with a known Product ID update that product's price; rows without one create a new product. Nothing is saved until you confirm the preview."
              : "Download the template, edit the Price column in rupees, then upload it here. You will see exactly what changes before anything is saved."}
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
          {busy ? (
            <p className="mt-2 text-sm text-ink-500">Validating…</p>
          ) : null}
        </Card>
      ) : (
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-ink-900">
              {preview.fileName}
            </span>
            <Badge>{preview.counts.total} rows</Badge>
            <Badge>{preview.counts.valid - preview.counts.newProducts} to update</Badge>
            {preview.counts.newProducts > 0 ? (
              <Badge>{preview.counts.newProducts} new</Badge>
            ) : null}
            <Badge>{preview.counts.unchanged} unchanged</Badge>
            {preview.counts.invalid > 0 ? (
              <Badge>{preview.counts.invalid} invalid</Badge>
            ) : null}
            {preview.counts.duplicate > 0 ? (
              <Badge>{preview.counts.duplicate} duplicate</Badge>
            ) : null}
            {preview.counts.notFound > 0 ? (
              <Badge>{preview.counts.notFound} not found</Badge>
            ) : null}
          </div>

          <div className="max-h-96 overflow-auto rounded-lg border border-cream-200">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Existing</th>
                  <th className="px-3 py-2">Uploaded</th>
                  <th className="px-3 py-2">Difference</th>
                  <th className="px-3 py-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-3 py-2 text-ink-500">{row.rowNumber}</td>
                    <td className="px-3 py-2">
                      <span className="font-medium text-ink-900">
                        {row.productName || row.productCode || "—"}
                      </span>
                      <span className="ml-1 text-xs text-ink-500">
                        {row.productCode}
                      </span>
                      {row.errorMessage ? (
                        <p className="text-xs text-red-700">{row.errorMessage}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      {row.previousPricePaise != null ? (
                        <Money paise={row.previousPricePaise} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {row.pricePaise != null ? (
                        <Money paise={row.pricePaise} />
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {row.differencePaise != null && row.differencePaise !== 0 ? (
                        <span
                          className={
                            row.differencePaise > 0
                              ? "text-kesari-600"
                              : "text-green-700"
                          }
                        >
                          {row.differencePaise > 0 ? "+" : ""}
                          <Money paise={row.differencePaise} />
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
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
              {appliesImmediately
                ? `Apply ${preview.counts.valid} change(s)`
                : `Submit ${preview.counts.valid} change(s) for approval`}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={discard}>
              Discard
            </Button>
            {preview.counts.valid === 0 ? (
              <span className="text-sm text-ink-500">
                Nothing to apply — no row contains a valid price change.
              </span>
            ) : null}
          </div>

          <p className="mt-2 text-xs text-ink-500">
            Only rows marked &ldquo;Update&rdquo; are applied. Invalid, duplicate
            and unknown rows are skipped and never overwrite existing prices.
          </p>
        </Card>
      )}
    </section>
  );
}
