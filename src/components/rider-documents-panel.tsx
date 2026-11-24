"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, StatusBadge, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";

export interface RiderDocumentRow {
  id: string;
  docType: string;
  label: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}

const TYPES: { value: string; label: Text }[] = [
  { value: "AADHAAR", label: L("Aadhaar card", "Aadhaar कार्ड", "Aadhaar कार्ड") },
  { value: "PAN", label: L("PAN card", "PAN कार्ड", "PAN कार्ड") },
  { value: "DRIVING_LICENCE", label: L("Driving licence", "ड्राइविंग लाइसेंस", "ड्रायव्हिंग लायसन्स") },
  { value: "VEHICLE_RC", label: L("Vehicle registration (RC)", "वाहन रजिस्ट्रेशन (RC)", "वाहन नोंदणी (RC)") },
  { value: "OTHER", label: L("Other identity document", "अन्य पहचान दस्तावेज़", "इतर ओळख कागदपत्र") },
];

const T = {
  choosePhoto: L("Choose a photo of the document.", "दस्तावेज़ की फ़ोटो चुनें।", "कागदपत्राचा फोटो निवडा."),
  uploadFailed: L("Could not upload the document.", "दस्तावेज़ अपलोड नहीं हो सका।", "कागदपत्र अपलोड करता आले नाही."),
  uploadedReview: L("Uploaded. Gokesari will review it.", "अपलोड हो गया। Gokesari इसकी जाँच करेगा।", "अपलोड झाले. Gokesari ते तपासेल."),
  intro: L(
    "Upload a clear photo (JPEG, PNG or WebP) of each document. Only Gokesari's admins can open them — they are never shown to customers, shops or societies.",
    "हर दस्तावेज़ की साफ़ फ़ोटो (JPEG, PNG या WebP) अपलोड करें। इन्हें सिर्फ़ Gokesari के एडमिन खोल सकते हैं — ये ग्राहकों, दुकानों या सोसाइटियों को कभी नहीं दिखाए जाते।",
    "प्रत्येक कागदपत्राचा स्पष्ट फोटो (JPEG, PNG किंवा WebP) अपलोड करा. ते फक्त Gokesari चे ॲडमिन उघडू शकतात — ते ग्राहक, दुकाने किंवा सोसायट्यांना कधीही दाखवले जात नाहीत.",
  ),
  uploadedOn: L("· uploaded", "· अपलोड", "· अपलोड"),
  none: L("No documents uploaded yet.", "अभी कोई दस्तावेज़ अपलोड नहीं हुआ।", "अजून कोणतेही कागदपत्र अपलोड केलेले नाही."),
  document: L("Document", "दस्तावेज़", "कागदपत्र"),
  photo: L("Photo", "फ़ोटो", "फोटो"),
  uploading: L("Uploading…", "अपलोड हो रहा है…", "अपलोड होत आहे…"),
  upload: L("Upload", "अपलोड", "अपलोड"),
} as const;

/**
 * C5: a rider uploads photos of their identity documents. Only Gokesari's
 * admins can open them; the rider sees the type, date and review status.
 */
export function RiderDocumentsPanel({ documents, lang = "en" }: { documents: RiderDocumentRow[]; lang?: Lang }) {
  const t = (text: Text) => tr(text, lang);
  const router = useRouter();
  const [docType, setDocType] = useState("AADHAAR");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function upload() {
    if (!file) return setMessage({ tone: "danger", text: t(T.choosePhoto) });
    setBusy(true);
    setMessage(null);
    const data = new FormData();
    data.set("file", file);
    data.set("docType", docType);
    const res = await fetch("/api/delivery-partner/me/documents", { method: "POST", body: data });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setMessage({ tone: "danger", text: body?.error?.message ? errorText(body.error.message, lang, body?.error?.code) : t(T.uploadFailed) });
    setFile(null);
    setMessage({ tone: "success", text: t(T.uploadedReview) });
    router.refresh();
  }

  return (
    <Card className="space-y-3 p-5" data-testid="rider-documents">
      <p className="text-sm text-ink-500">{t(T.intro)}</p>
      {documents.length > 0 ? (
        <ul className="divide-y divide-cream-100 text-sm">
          {documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                {d.label}
                <span className="text-xs text-ink-500">
                  {" "}
                  {t(T.uploadedOn)} {new Date(d.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                </span>
                {d.rejectionReason ? <span className="block text-xs text-red-700">{d.rejectionReason}</span> : null}
              </span>
              <StatusBadge status={d.status} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-500">{t(T.none)}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="text-sm text-ink-700">
          {t(T.document)}
          <select className={inputClass} value={docType} onChange={(e) => setDocType(e.target.value)}>
            {TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {t(type.label)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-ink-700">
          {t(T.photo)}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="block w-full text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <Button size="sm" disabled={busy || !file} onClick={upload}>
          {busy ? t(T.uploading) : t(T.upload)}
        </Button>
      </div>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </Card>
  );
}
