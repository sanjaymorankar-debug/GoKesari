"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, StatusBadge, inputClass } from "@/components/ui";

export interface RiderDocumentRow {
  id: string;
  docType: string;
  label: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}

const TYPES: { value: string; label: string }[] = [
  { value: "AADHAAR", label: "Aadhaar card" },
  { value: "PAN", label: "PAN card" },
  { value: "DRIVING_LICENCE", label: "Driving licence" },
  { value: "VEHICLE_RC", label: "Vehicle registration (RC)" },
  { value: "OTHER", label: "Other identity document" },
];

/**
 * C5: a rider uploads photos of their identity documents. Only Gokesari's
 * admins can open them; the rider sees the type, date and review status.
 */
export function RiderDocumentsPanel({ documents }: { documents: RiderDocumentRow[] }) {
  const router = useRouter();
  const [docType, setDocType] = useState("AADHAAR");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function upload() {
    if (!file) return setMessage({ tone: "danger", text: "Choose a photo of the document." });
    setBusy(true);
    setMessage(null);
    const data = new FormData();
    data.set("file", file);
    data.set("docType", docType);
    const res = await fetch("/api/delivery-partner/me/documents", { method: "POST", body: data });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "danger", text: body?.error?.message ?? "Could not upload the document." });
    setFile(null);
    setMessage({ tone: "success", text: "Uploaded. Gokesari will review it." });
    router.refresh();
  }

  return (
    <Card className="space-y-3 p-5" data-testid="rider-documents">
      <p className="text-sm text-ink-500">
        Upload a clear photo (JPEG, PNG or WebP) of each document. Only Gokesari&apos;s admins can open them — they are
        never shown to customers, shops or societies.
      </p>
      {documents.length > 0 ? (
        <ul className="divide-y divide-cream-100 text-sm">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {d.label}
                <span className="text-xs text-ink-500">
                  {" "}
                  · uploaded {new Date(d.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
                </span>
                {d.rejectionReason ? <span className="block text-xs text-red-700">{d.rejectionReason}</span> : null}
              </span>
              <StatusBadge status={d.status} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-500">No documents uploaded yet.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm text-ink-700">
          Document
          <select className={inputClass} value={docType} onChange={(e) => setDocType(e.target.value)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink-700">
          Photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Button size="sm" disabled={busy || !file} onClick={upload}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </Card>
  );
}
