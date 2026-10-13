"use client";

/**
 * "Upload your documents" (docs/document-upload-2026-10): one card per
 * document. The owner uploads a file or takes a photo (phone camera, or the
 * computer's webcam), the server reads it, and the details come back
 * pre-filled. The owner checks them, corrects anything misread, ticks the
 * consent for this check and clicks Verify & Approve.
 *
 * In the Android/iPhone app the photo button opens the phone's camera app
 * through the file picker, so the app needs no camera permission of its own.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import type { ExtractedFields, ExtractionFlag, UploadDocType } from "@/lib/kyc/document-extract";
import { SELLER_VERIFICATION_CONSENT_TEXT } from "@/lib/kyc/consent";

export interface PanelUpload {
  id: string;
  status: "EXTRACTED" | "CONFIRMED" | "DISCARDED";
  fields: ExtractedFields | null;
  flags: ExtractionFlag[];
  blocking: boolean;
  contentType: string;
  readerEngine: string;
  validUntil: string | null;
  numberLast4: string | null;
  confirmedAt: string | null;
}

export interface PanelItem {
  docType: UploadDocType;
  label: string;
  requirement: "required" | "required_or_declaration" | "optional";
  status: string;
  validUntil: string | null;
  done: boolean;
  latest: PanelUpload | null;
}

const REQUIREMENT_TEXT: Record<PanelItem["requirement"], string> = {
  required: "Required",
  required_or_declaration: "Required — or declare you're not GST-registered on the Verification page",
  optional: "Optional",
};

const STATUS_TEXT: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "info" }> = {
  NOT_SUBMITTED: { label: "Not uploaded", tone: "neutral" },
  PENDING: { label: "Checking", tone: "info" },
  MANUAL_REVIEW: { label: "With our team", tone: "info" },
  VERIFIED: { label: "Verified", tone: "success" },
  FAILED: { label: "Not verified", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "danger" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

/** Phone photos can be 5–10 MB; a long side of 2400 px reads just as well and uploads much faster. */
async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.size < 2_500_000) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    return blob ? new File([blob], "document.jpg", { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

async function errorOf(response: Response): Promise<{ message: string; reupload: boolean; fields?: Record<string, string> }> {
  const payload = await response.json().catch(() => null);
  const details = payload?.error?.details ?? {};
  return {
    message: payload?.error?.message ?? "Something went wrong. Please try again.",
    reupload: Boolean(details.reupload),
    fields: details.fields,
  };
}

export function DocumentUploadPanel({ shopId, items }: { shopId: string; items: PanelItem[] }) {
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <DocumentCard key={item.docType} shopId={shopId} item={item} />
      ))}
    </div>
  );
}

function prefill(upload: PanelUpload | null) {
  const f = upload?.status === "EXTRACTED" ? upload.fields : null;
  return {
    number: f?.number ?? "",
    name: f?.name ?? "",
    address: f?.address ?? "",
    validFrom: f?.validFrom ?? "",
    validUntil: f?.validUntil ?? "",
    issuingCouncil: "",
  };
}

function DocumentCard({ shopId, item }: { shopId: string; item: PanelItem }) {
  const router = useRouter();
  const pending = item.latest?.status === "EXTRACTED" ? item.latest : null;
  const [upload, setUpload] = useState<PanelUpload | null>(pending);
  const [values, setValues] = useState(prefill(pending));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<"reading" | "submitting" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const status = STATUS_TEXT[item.status] ?? { label: item.status, tone: "neutral" as const };
  const reuploadFlag = upload?.flags.find((f) => f.severity === "block" && (f.code === "UNREADABLE" || f.code === "WRONG_DOCUMENT"));

  async function send(file: File, source: "FILE" | "CAMERA") {
    setBusy("reading");
    setError(null);
    setFieldErrors({});
    const form = new FormData();
    form.set("file", await shrinkImage(file));
    form.set("docType", item.docType);
    form.set("source", source);
    const response = await fetch(`/api/shops/${shopId}/documents/read`, { method: "POST", body: form });
    setBusy(null);
    if (!response.ok) {
      setError((await errorOf(response)).message);
      return;
    }
    const payload = await response.json();
    const read: PanelUpload = payload.data ?? payload;
    setUpload(read);
    setValues(prefill(read));
    setConsent(false);
  }

  function takePhoto() {
    // Phones (and the app): the camera app through the file picker. Computers: the webcam, in the page.
    const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (coarse || !navigator.mediaDevices?.getUserMedia) photoInput.current?.click();
    else setCameraOpen(true);
  }

  async function confirm() {
    if (!upload) return;
    setBusy("submitting");
    setError(null);
    setFieldErrors({});
    const response = await fetch(`/api/shops/${shopId}/documents/${upload.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        number: values.number,
        name: values.name || null,
        address: values.address || null,
        validFrom: values.validFrom || null,
        validUntil: values.validUntil || null,
        issuingCouncil: values.issuingCouncil || null,
        consent: true,
      }),
    });
    setBusy(null);
    if (!response.ok) {
      const problem = await errorOf(response);
      setError(problem.reupload ? `${problem.message} Use "Upload again" below.` : problem.message);
      setFieldErrors(problem.fields ?? {});
      return;
    }
    setUpload(null);
    router.refresh();
  }

  async function discard() {
    if (upload) await fetch(`/api/shops/${shopId}/documents/${upload.id}`, { method: "DELETE" }).catch(() => undefined);
    setUpload(null);
    setValues(prefill(null));
    setError(null);
  }

  const set = (key: keyof ReturnType<typeof prefill>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  return (
    <Card className="space-y-3 p-4" data-testid={`doc-upload-${item.docType}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-ink-900">{item.label}</p>
          <p className="text-xs text-ink-500">
            {REQUIREMENT_TEXT[item.requirement]}
            {item.validUntil ? ` · valid until ${item.validUntil}` : ""}
          </p>
        </div>
        <Badge tone={item.done ? "success" : status.tone}>{item.done && item.status === "NOT_SUBMITTED" ? "On file" : status.label}</Badge>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="hidden"
        data-testid={`doc-file-${item.docType}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void send(file, "FILE");
        }}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        data-testid={`doc-photo-${item.docType}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void send(file, "CAMERA");
        }}
      />

      {!upload ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => fileInput.current?.click()} data-testid={`doc-upload-file-${item.docType}`}>
            {busy === "reading" ? "Reading the document…" : item.done ? "Upload a new copy" : "Upload file"}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={takePhoto} data-testid={`doc-take-photo-${item.docType}`}>
            Take photo
          </Button>
          <p className="w-full text-xs text-ink-500">PDF or photo (JPEG, PNG, WebP). Place the document flat in good light with all four corners showing.</p>
        </div>
      ) : null}

      {cameraOpen ? (
        <CameraCapture
          onCancel={() => setCameraOpen(false)}
          onFallback={() => {
            setCameraOpen(false);
            photoInput.current?.click();
          }}
          onCapture={(file) => {
            setCameraOpen(false);
            void send(file, "CAMERA");
          }}
        />
      ) : null}

      {upload ? (
        <div className="space-y-3 border-t border-cream-200 pt-3" data-testid={`doc-review-${item.docType}`}>
          <p className="text-sm text-ink-700">
            We read these details from your document. Check each one against the document, correct anything that is wrong, then
            click <strong>Verify &amp; Approve</strong>.{" "}
            <a className="text-kesari-700 underline" href={`/api/shops/${shopId}/documents/${upload.id}/file`} target="_blank" rel="noreferrer">
              View what you uploaded
            </a>
          </p>
          {upload.flags.length ? (
            <ul className="space-y-1" data-testid={`doc-flags-${item.docType}`}>
              {upload.flags.map((flag) => (
                <li key={flag.code} data-flag={flag.code}>
                  <Alert tone={flag.severity === "block" ? "danger" : "warning"}>{flag.message}</Alert>
                </li>
              ))}
            </ul>
          ) : (
            <Alert tone="success">Read clearly — no problems found.</Alert>
          )}

          {!reuploadFlag ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`${item.label} number`} error={fieldErrors.number}>
                <input className={inputClass} value={values.number} onChange={set("number")} autoComplete="off" spellCheck={false} data-testid="doc-field-number" />
              </Field>
              <Field label="Name on the document" error={fieldErrors.name}>
                <input className={inputClass} value={values.name} onChange={set("name")} autoComplete="off" data-testid="doc-field-name" />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Address on the document" error={fieldErrors.address}>
                  <textarea className={inputClass} rows={2} value={values.address} onChange={set("address")} data-testid="doc-field-address" />
                </Field>
              </div>
              <Field label="Valid from / issued on" error={fieldErrors.validFrom}>
                <input type="date" className={inputClass} value={values.validFrom} onChange={set("validFrom")} data-testid="doc-field-valid-from" />
              </Field>
              <Field
                label={item.docType === "FSSAI" || item.docType === "DRUG_LICENCE" ? "Valid up to (expiry) — required" : "Valid up to (expiry), if printed"}
                error={fieldErrors.validUntil}
              >
                <input type="date" className={inputClass} value={values.validUntil} onChange={set("validUntil")} data-testid="doc-field-valid-until" />
              </Field>
              {item.docType === "MEDICAL_REGISTRATION" ? (
                <Field label="Issuing council" error={fieldErrors.issuingCouncil}>
                  <input className={inputClass} value={values.issuingCouncil} onChange={set("issuingCouncil")} data-testid="doc-field-council" />
                </Field>
              ) : null}
            </div>
          ) : null}

          {!reuploadFlag ? (
            <label className="flex items-start gap-2 text-xs text-ink-700">
              <input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="doc-consent" />
              <span>{SELLER_VERIFICATION_CONSENT_TEXT}</span>
            </label>
          ) : null}
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            {!reuploadFlag ? (
              <Button size="sm" disabled={!consent || !values.number.trim() || busy !== null} onClick={confirm} data-testid={`doc-verify-${item.docType}`}>
                {busy === "submitting" ? "Submitting…" : "Verify & Approve"}
              </Button>
            ) : null}
            <Button size="sm" variant={reuploadFlag ? "primary" : "secondary"} disabled={busy !== null} onClick={discard} data-testid={`doc-reupload-${item.docType}`}>
              Upload again
            </Button>
          </div>
        </div>
      ) : error ? (
        <Alert tone="danger">{error}</Alert>
      ) : null}
    </Card>
  );
}

/** The computer's webcam, in the page (phones use their camera app instead). */
function CameraCapture({
  onCapture,
  onCancel,
  onFallback,
}: {
  onCapture: (file: File) => void;
  onCancel: () => void;
  onFallback: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
      })
      .catch(() => setProblem("We couldn't open the camera. Allow camera access in your browser, or choose a photo instead."));
    return () => {
      cancelled = true;
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext("2d")?.drawImage(v, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) onCapture(new File([blob], "document-photo.jpg", { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.92,
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-cream-200 bg-cream-50 p-3" data-testid="doc-camera">
      {problem ? (
        <Alert tone="warning">{problem}</Alert>
      ) : (
        <video ref={video} className="w-full max-h-80 rounded-lg bg-ink-900 object-contain" playsInline muted aria-label="Camera preview" />
      )}
      <div className="flex flex-wrap gap-2">
        {!problem ? (
          <Button size="sm" onClick={capture}>
            Capture
          </Button>
        ) : null}
        <Button size="sm" variant="secondary" onClick={onFallback}>
          Choose a photo instead
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
