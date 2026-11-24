"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Card } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

const T = {
  fileType: L("Upload a PDF, JPG or PNG file.", "PDF, JPG या PNG फ़ाइल अपलोड करें।", "PDF, JPG किंवा PNG फाइल अपलोड करा."),
  tooBig: L("The file can be at most {mb} MB.", "फ़ाइल ज़्यादा से ज़्यादा {mb} MB की हो सकती है।", "फाइल जास्तीत जास्त {mb} MB ची असू शकते."),
  uploadFailed: L("Could not upload the document.", "दस्तावेज़ अपलोड नहीं हो सका।", "कागदपत्र अपलोड करता आले नाही."),
  uploadOffline: L(
    "Could not upload the document. Check your connection and try again.",
    "दस्तावेज़ अपलोड नहीं हो सका। अपना कनेक्शन देखें और फिर कोशिश करें।",
    "कागदपत्र अपलोड करता आले नाही. तुमचे कनेक्शन तपासा आणि पुन्हा प्रयत्न करा.",
  ),
  optional: L("(optional)", "(वैकल्पिक)", "(ऐच्छिक)"),
  notUploaded: L("Not uploaded", "अपलोड नहीं हुआ", "अपलोड केलेले नाही"),
  uploaded: L("Uploaded", "अपलोड हुआ", "अपलोड केले"),
  rejected: L("Rejected", "अस्वीकृत", "नाकारले"),
  uploadNew: L("Upload a new file", "नई फ़ाइल अपलोड करें", "नवीन फाइल अपलोड करा"),
  choose: L("Choose a file", "फ़ाइल चुनें", "फाइल निवडा"),
  formats: L(" — PDF, JPG or PNG, up to {mb} MB", " — PDF, JPG या PNG, {mb} MB तक", " — PDF, JPG किंवा PNG, {mb} MB पर्यंत"),
  approved: L("Approved — nothing more to do.", "मंज़ूर — अब कुछ और नहीं करना है।", "मंजूर — आता आणखी काही करायचे नाही."),
  reviewing: L("Our team is reviewing it.", "हमारी टीम इसे जाँच रही है।", "आमची टीम ते तपासत आहे."),
  uploading: L("Uploading…", "अपलोड हो रहा है…", "अपलोड होत आहे…"),
} as const;

const STATUS_TEXT: Record<BackgroundDocProps["status"], Text> = {
  UPLOADED: L("Uploaded", "अपलोड हुआ", "अपलोड केले"),
  UNDER_REVIEW: L("Under review", "जाँच जारी", "तपासणी सुरू"),
  APPROVED: L("Approved", "मंज़ूर", "मंजूर"),
  REJECTED: L("Rejected", "अस्वीकृत", "नाकारले"),
};

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
  lang = "en",
}: {
  documents: BackgroundDocProps[];
  slots: { docType: BackgroundDocProps["docType"]; label: string; required: boolean }[];
  maxBytes: number;
  lang?: Lang;
}) {
  const t = (text: Text) => tr(text, lang);
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const maxMb = (maxBytes / 1_000_000).toFixed(1).replace(/\.0$/, "");

  async function upload(docType: string, files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    if (file.type && !ALLOWED.includes(file.type)) {
      setError(t(T.fileType));
      return;
    }
    if (file.size > maxBytes) {
      setError(t(T.tooBig).replace("{mb}", maxMb));
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
        setError(payload?.error?.message ? errorText(payload.error.message, lang, payload?.error?.code) : t(T.uploadFailed));
        return;
      }
      router.refresh();
    } catch {
      setError(t(T.uploadOffline));
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
                {slot.required ? null : <span className="ml-1 text-sm font-normal text-ink-500">{t(T.optional)}</span>}
              </h2>
              {current ? (
                <Badge tone={TONE[current.status]}>{lang === "en" ? current.statusLabel : t(STATUS_TEXT[current.status])}</Badge>
              ) : (
                <Badge>{t(T.notUploaded)}</Badge>
              )}
            </div>
            {current ? (
              <p className="text-xs text-ink-500">{t(T.uploaded)} {new Date(current.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</p>
            ) : null}
            {current?.status === "REJECTED" && current.rejectionReason ? (
              <Alert tone="danger" title={t(T.rejected)}>
                {current.rejectionReason}
              </Alert>
            ) : null}
            {canReplace ? (
              <label className="block text-sm font-medium text-ink-700">
                {current ? t(T.uploadNew) : t(T.choose)}
                {t(T.formats).replace("{mb}", maxMb)}
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
                {current?.status === "APPROVED" ? t(T.approved) : t(T.reviewing)}
              </p>
            )}
            {busy === slot.docType ? <p className="text-xs text-ink-500">{t(T.uploading)}</p> : null}
          </Card>
        );
      })}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
