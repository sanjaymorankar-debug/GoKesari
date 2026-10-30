"use client";

/**
 * Shop registration (0120, docs/shop-onboarding-wizard-2026-10/FLOW_2026-10-30.md): "Scan or
 * upload a copy". The owner adds photos of the GST certificate, PAN card, Udyam and FSSAI; each
 * photo is read on the device itself (src/lib/kyc/browser-ocr.ts — nothing leaves the phone),
 * the document and its number are worked out (detectUploadType, extractDocumentFields), and the
 * owner checks every number before the wizard verifies them online. A photo that cannot be read
 * (a PDF, an old browser, a blurred shot) keeps an empty row the owner types into.
 */
import { useRef, useState, type ReactNode } from "react";

import { Badge, Button, inputClass } from "@/components/ui";
import { checkDocNumber, detectUploadType, extractDocumentFields } from "@/lib/kyc/document-extract";

export const SCAN_DOC_TYPES = ["GSTIN", "PAN", "UDYAM", "FSSAI"] as const;
export type ScanDocType = (typeof SCAN_DOC_TYPES)[number];

const LABELS: Record<ScanDocType, string> = {
  GSTIN: "GST number (GSTIN)",
  PAN: "PAN",
  UDYAM: "Udyam number",
  FSSAI: "FSSAI number",
};

export interface ScannedNumber {
  docType: ScanDocType;
  number: string;
}

interface Row {
  key: string;
  fileName: string;
  state: "reading" | "read" | "unread";
  docType: ScanDocType | "";
  number: string;
}

const isScanType = (t: string | null): t is ScanDocType => t !== null && (SCAN_DOC_TYPES as readonly string[]).includes(t);

/** The number's problem, or null when it is well-formed for the chosen document. */
function problem(row: Row): string | null {
  if (!row.docType) return "Choose which document this is.";
  if (!row.number.trim()) return "Type the number from the document.";
  const checked = checkDocNumber(row.docType, row.number);
  return checked.ok ? null : checked.error;
}

export function DocumentScan({
  busy,
  onConfirm,
  extra,
}: {
  busy: boolean;
  onConfirm: (found: ScannedNumber[]) => void;
  /** What the owner must also agree to for these numbers (consent; the no-GST declaration for a PAN alone). */
  extra?: (found: ScannedNumber[]) => { node: ReactNode; ok: boolean };
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const update = (key: string, patch: Partial<Row>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function read(files: FileList | null) {
    if (!files?.length) return;
    const added = Array.from(files).map((file, i) => ({ file, row: { key: `${Date.now()}-${i}`, fileName: file.name, state: "reading", docType: "", number: "" } as Row }));
    setRows((all) => [...all, ...added.map((a) => a.row)]);
    const { readInBrowser } = await import("@/lib/kyc/browser-ocr");
    // One at a time: the reader is a single worker, and a phone has little memory to spare.
    for (const { file, row } of added) {
      const result = await readInBrowser(file).catch(() => null);
      const docType = result ? detectUploadType(result.text) : null;
      if (!result || !isScanType(docType)) {
        update(row.key, { state: "unread", docType: isScanType(docType) ? docType : "" });
        continue;
      }
      const number = extractDocumentFields(result.text, docType).fields.number ?? "";
      update(row.key, { state: number ? "read" : "unread", docType, number });
    }
  }

  const ready = rows.filter((r) => r.state !== "reading");
  const duplicates = new Set(ready.map((r) => r.docType).filter((t, i, all) => t && all.indexOf(t) !== i));
  const allGood = ready.length > 0 && ready.length === rows.length && ready.every((r) => !problem(r)) && duplicates.size === 0;
  const found = ready.filter((r) => r.docType).map((r) => ({ docType: r.docType as ScanDocType, number: r.number.trim() }));
  const more = allGood ? extra?.(found) : undefined;

  return (
    <div className="space-y-3" data-testid="document-scan">
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        multiple
        className="sr-only"
        onChange={(e) => {
          void read(e.target.files);
          e.target.value = "";
        }}
        aria-label="Photos of your documents"
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed border-kesari-300 bg-kesari-50 px-4 py-4 text-center text-kesari-800 hover:bg-kesari-100"
      >
        <span className="text-2xl" aria-hidden>
          📷
        </span>
        <span className="text-sm font-semibold">{rows.length ? "Add another document" : "Take a photo or choose files"}</span>
        <span className="text-xs text-ink-600">GST certificate, PAN card, Udyam, FSSAI — one photo each, flat and in good light</span>
      </button>

      {rows.length ? (
        <ul className="space-y-2">
          {rows.map((r) => {
            const issue = r.state === "reading" ? null : problem(r);
            return (
              <li key={r.key} className="rounded-xl border border-[var(--gk-line)] bg-white p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-ink-500">{r.fileName}</span>
                  {r.state === "reading" ? (
                    <Badge tone="neutral">Reading…</Badge>
                  ) : r.state === "read" ? (
                    <Badge tone="success">Number found — please check</Badge>
                  ) : (
                    <Badge tone="warning">Couldn&apos;t read — type it</Badge>
                  )}
                  <button type="button" className="text-xs text-ink-500 underline" onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>
                    Remove
                  </button>
                </div>
                {r.state === "reading" ? null : (
                  <div className="mt-2 grid gap-2 sm:grid-cols-[11rem_1fr]">
                    <select
                      className={inputClass}
                      value={r.docType}
                      onChange={(e) => update(r.key, { docType: e.target.value as ScanDocType | "" })}
                      aria-label="Which document"
                    >
                      <option value="">Which document?</option>
                      {SCAN_DOC_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {LABELS[t]}
                        </option>
                      ))}
                    </select>
                    <input
                      className={`${inputClass} font-mono uppercase`}
                      value={r.number}
                      onChange={(e) => update(r.key, { number: e.target.value })}
                      aria-label={r.docType ? LABELS[r.docType] : "Document number"}
                      autoComplete="off"
                    />
                  </div>
                )}
                {issue ? <p className="mt-1 text-xs text-red-700">{issue}</p> : null}
                {r.docType && duplicates.has(r.docType) ? <p className="mt-1 text-xs text-red-700">Two rows say {LABELS[r.docType]} — keep one.</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {more?.node}
      {rows.length ? (
        <Button type="button" size="lg" className="w-full" disabled={busy || !allGood || (more ? !more.ok : false)} onClick={() => onConfirm(found)}>
          {busy ? "Checking online…" : "These numbers are right — check them online"}
        </Button>
      ) : null}
    </div>
  );
}
