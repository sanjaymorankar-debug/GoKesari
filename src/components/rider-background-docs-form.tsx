"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Card } from "@/components/ui";

export interface BackgroundDocProps {
  docType: "POLICE_VERIFICATION" | "CHARACTER_CERTIFICATE";
  label: string;
  status: "UPLOADED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";
  statusLabel: string;
  rejectionReason: string | null;
  createdAt: string;
}

const TONE = { UPLOADED: "info", UNDER_REVIEW: "warning", APPROVED: "success", REJECTED: "danger" } as const;
const ACCEPT = "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png";
const ALLOWED = ["application/pdf", "image/jpeg", "image/png"];

/**
 * Gig worker flow (feature 3): upload the police verification form and the
 * character certificate. PDF, JPG or PNG up to the configured size — checked
 * here for a quick answer and again, from the file's bytes, on the server.
 * The partner sees the review status, never a link to the stored file.
 */
export function RiderBackgroundDocsForm({
  documents,
  slots,
  maxBytes,
}: {
  documents: BackgroundDocProps[];
  slots: { docType: BackgroundDocProps["docType"]; label: string; required: boolean }[];
  maxBytes: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const maxMb = (maxBytes / 1_000_000).toFixed(1).replace(/\.0$/, "");

  async function upload(docType: string, files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    if (file.type && !ALLOWED.includes(file.type)) {
      setError("Upload a PDF, JPG or PNG file.");
      return;
    }
    if (file.size > maxBytes) {
      setError(`The file can be at most ${maxMb} MB.`);
      return;
    }
    setBusy(docType);
    try {
      const body = new FormData();
      body.append("docType", docType);
      body.append("file", file, file.name);
      const response = await fetch("/api/delivery-partner/me/background-docs", { method: "POST", body });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.error?.message ?? "Could not upload the document.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not upload the document. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {slots.map((slot) => {
        const current = documents.find((d) => d.docType === slot.docType) ?? null;
        const canReplace = !current || current.status === "REJECTED" || current.status === "UPLOADED";
        return (
          <Card key={slot.docType} className="space-y-3 p-5" data-testid={`background-doc-${slot.docType.toLowerCase()}`}>
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold text-ink-900">
                {slot.label}
                {slot.required ? null : <span className="ml-1 text-sm font-normal text-ink-500">(optional)</span>}
              </h2>
              {current ? <Badge tone={TONE[current.status]}>{current.statusLabel}</Badge> : <Badge>Not uploaded</Badge>}
            </div>
            {current ? (
              <p className="text-xs text-ink-500">Uploaded {new Date(current.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
            ) : null}
            {current?.status === "REJECTED" && current.rejectionReason ? (
              <Alert tone="danger" title="Rejected">
                {current.rejectionReason}
              </Alert>
            ) : null}
            {canReplace ? (
              <label className="block text-sm font-medium text-ink-700">
                {current ? "Upload a new file" : "Choose a file"} — PDF, JPG or PNG, up to {maxMb} MB
                <input
                  type="file"
                  accept={ACCEPT}
                  disabled={busy !== null}
                  onChange={(e) => void upload(slot.docType, e.target.files)}
                  className="mt-1 block w-full text-xs"
                  data-testid={`upload-${slot.docType.toLowerCase()}`}
                />
              </label>
            ) : (
              <p className="text-sm text-ink-500">
                {current?.status === "APPROVED" ? "Approved — nothing more to do." : "Our team is reviewing it."}
              </p>
            )}
            {busy === slot.docType ? <p className="text-xs text-ink-500">Uploading…</p> : null}
          </Card>
        );
      })}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
