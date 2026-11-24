"use client";

/**
 * F2 — rider self-edit. Everyday details save at once; identity and bank
 * details go to an admin for review and are never shown back in full.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { errorText } from "@/lib/board/error-text";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { VEHICLE_TYPE_KEYS, vehicleTypeText } from "@/lib/vehicle-types";

export interface EditableRider {
  fullName: string;
  mobile: string;
  email: string | null;
  dateOfBirth: string | null;
  profilePhotoUrl: string | null;
  vehicleType: string;
  vehicleRegistrationNumber: string | null;
  operatingRadiusKm: number;
}

export interface LatestChangeRequest {
  status: "PENDING" | "APPROVED" | "REJECTED" | "SUPERSEDED";
  fields: string[];
  masked: Record<string, string>;
  rejectionReason: string | null;
  createdAt: string;
}

const SENSITIVE: { key: string; label: Text; placeholder?: Text }[] = [
  { key: "panNumber", label: L("PAN", "PAN", "PAN"), placeholder: L("ABCDE1234F", "ABCDE1234F", "ABCDE1234F") },
  {
    key: "governmentIdType",
    label: L("Government ID type", "सरकारी पहचान पत्र का प्रकार", "सरकारी ओळखपत्राचा प्रकार"),
    placeholder: L("e.g. Voter ID", "जैसे वोटर ID", "उदा. मतदार ओळखपत्र"),
  },
  { key: "governmentIdNumber", label: L("Government ID number", "सरकारी पहचान पत्र नंबर", "सरकारी ओळखपत्र क्रमांक") },
  { key: "drivingLicenceNumber", label: L("Driving licence number", "ड्राइविंग लाइसेंस नंबर", "ड्रायव्हिंग लायसन्स क्रमांक") },
  { key: "bankAccountHolderName", label: L("Bank account holder name", "बैंक खाताधारक का नाम", "बँक खातेदाराचे नाव") },
  { key: "bankAccountNumber", label: L("Bank account number", "बैंक खाता नंबर", "बँक खाते क्रमांक") },
  { key: "bankIfsc", label: L("IFSC", "IFSC", "IFSC"), placeholder: L("SBIN0001234", "SBIN0001234", "SBIN0001234") },
];

const T = {
  saveFailed: L("Could not save. Please try again.", "सहेजा नहीं जा सका। फिर कोशिश करें।", "जतन करता आले नाही. पुन्हा प्रयत्न करा."),
  saved: L("Saved.", "सहेज लिया।", "जतन केले."),
  sentForReview: L(
    "Sent for review. You'll be notified when it's approved.",
    "जाँच के लिए भेज दिया। मंज़ूर होने पर आपको सूचना मिलेगी।",
    "तपासणीसाठी पाठवले. मंजूर झाल्यावर तुम्हाला कळवले जाईल.",
  ),
  editDetails: L("Edit my details", "मेरी जानकारी बदलें", "माझी माहिती बदला"),
  profilePhoto: L("Profile photo", "प्रोफ़ाइल फ़ोटो", "प्रोफाइल फोटो"),
  noPhoto: L("No photo", "फ़ोटो नहीं", "फोटो नाही"),
  fullName: L("Full name", "पूरा नाम", "पूर्ण नाव"),
  mobile: L("Mobile", "मोबाइल", "मोबाइल"),
  email: L("Email", "ईमेल", "ईमेल"),
  dob: L("Date of birth", "जन्म तिथि", "जन्मतारीख"),
  vehicle: L("Vehicle", "वाहन", "वाहन"),
  regNumber: L("Registration number", "रजिस्ट्रेशन नंबर", "नोंदणी क्रमांक"),
  radius: L("Working radius (km)", "काम का दायरा (km)", "कामाचा परिघ (km)"),
  saving: L("Saving…", "सहेज रहे हैं…", "जतन होत आहे…"),
  save: L("Save", "सहेजें", "जतन करा"),
  identityBank: L("Identity & bank details", "पहचान और बैंक विवरण", "ओळख आणि बँक तपशील"),
  lastRequest: L("Last request:", "पिछला अनुरोध:", "मागील विनंती:"),
  checkedFirst: L(
    "Changes here are checked by our team before they apply. Fill in only what has changed.",
    "यहाँ के बदलाव लागू होने से पहले हमारी टीम जाँचती है। सिर्फ़ वही भरें जो बदला है।",
    "इथले बदल लागू होण्यापूर्वी आमची टीम तपासते. फक्त जे बदलले आहे तेच भरा.",
  ),
  waiting: L("Waiting for review:", "जाँच बाकी:", "तपासणी बाकी:"),
  replaces: L("Sending a new request replaces it.", "नया अनुरोध भेजने पर यह बदल जाएगा।", "नवीन विनंती पाठवल्यास ही बदलली जाईल."),
  notApproved: L("Not approved:", "मंज़ूर नहीं:", "मंजूर नाही:"),
  sending: L("Sending…", "भेज रहे हैं…", "पाठवत आहोत…"),
  sendForReview: L("Send for review", "जाँच के लिए भेजें", "तपासणीसाठी पाठवा"),
} as const;

const REQUEST_STATUS_TEXT: Record<LatestChangeRequest["status"], Text> = {
  PENDING: L("pending", "बाकी", "प्रलंबित"),
  APPROVED: L("approved", "मंज़ूर", "मंजूर"),
  REJECTED: L("rejected", "अस्वीकृत", "नाकारली"),
  SUPERSEDED: L("superseded", "बदल दिया गया", "बदलली"),
};

async function errorOf(res: Response, lang: Lang = "en") {
  const body = await res.json().catch(() => null);
  return body?.error?.message ? errorText(body.error.message, lang, body?.error?.code) : tr(T.saveFailed, lang);
}

export function RiderProfileEditor({
  rider,
  latest,
  lang = "en",
}: {
  rider: EditableRider;
  latest: LatestChangeRequest | null;
  lang?: Lang;
}) {
  const t = (text: Text) => tr(text, lang);
  const router = useRouter();
  const [form, setForm] = useState({
    fullName: rider.fullName,
    mobile: rider.mobile,
    email: rider.email ?? "",
    dateOfBirth: rider.dateOfBirth ?? "",
    vehicleType: rider.vehicleType,
    vehicleRegistrationNumber: rider.vehicleRegistrationNumber ?? "",
    operatingRadiusKm: String(rider.operatingRadiusKm),
  });
  const [photoUrl, setPhotoUrl] = useState(rider.profilePhotoUrl);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [sensitive, setSensitive] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [sensitiveMsg, setSensitiveMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function uploadPhoto(file: File) {
    const data = new FormData();
    data.set("file", file);
    data.set("purpose", "PROFILE_PHOTO");
    const res = await fetch("/api/images", { method: "POST", body: data });
    if (!res.ok) return setMessage({ tone: "danger", text: await errorOf(res, lang) });
    const body = await res.json();
    setPhotoUrl(body.url);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const res = await fetch("/api/delivery-partner/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: form.fullName,
        mobile: form.mobile,
        email: form.email || null,
        dateOfBirth: form.dateOfBirth || null,
        profilePhotoUrl: photoUrl,
        vehicleType: form.vehicleType,
        vehicleRegistrationNumber: form.vehicleRegistrationNumber || null,
        operatingRadiusKm: Number(form.operatingRadiusKm),
      }),
    });
    setSaving(false);
    if (!res.ok) return setMessage({ tone: "danger", text: await errorOf(res, lang) });
    setMessage({ tone: "success", text: t(T.saved) });
    router.refresh();
  }

  async function sendSensitive() {
    setSending(true);
    setSensitiveMsg(null);
    const body = Object.fromEntries(Object.entries(sensitive).filter(([, v]) => v.trim()));
    const res = await fetch("/api/delivery-partner/me/change-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSending(false);
    if (!res.ok) return setSensitiveMsg({ tone: "danger", text: await errorOf(res, lang) });
    setSensitive({});
    setSensitiveMsg({ tone: "success", text: t(T.sentForReview) });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5" data-testid="rider-profile-editor">
        <h3 className="font-semibold text-ink-900">{t(T.editDetails)}</h3>
        <div className="flex items-center gap-3">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt={t(T.profilePhoto)} className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cream-100 text-xs text-ink-500">{t(T.noPhoto)}</div>
          )}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="text-sm"
            onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t(T.fullName)}><input className={inputClass} value={form.fullName} onChange={set("fullName")} /></Field>
          <Field label={t(T.mobile)}><input className={inputClass} value={form.mobile} onChange={set("mobile")} inputMode="numeric" /></Field>
          <Field label={t(T.email)}><input className={inputClass} value={form.email} onChange={set("email")} type="email" /></Field>
          <Field label={t(T.dob)}><input className={inputClass} value={form.dateOfBirth} onChange={set("dateOfBirth")} type="date" /></Field>
          <Field label={t(T.vehicle)}>
            <select className={inputClass} value={form.vehicleType} onChange={set("vehicleType")}>
              {VEHICLE_TYPE_KEYS.map((v) => <option key={v} value={v}>{vehicleTypeText(v, lang)}</option>)}
            </select>
          </Field>
          <Field label={t(T.regNumber)}><input className={inputClass} value={form.vehicleRegistrationNumber} onChange={set("vehicleRegistrationNumber")} /></Field>
          <Field label={t(T.radius)}><input className={inputClass} value={form.operatingRadiusKm} onChange={set("operatingRadiusKm")} inputMode="numeric" /></Field>
        </div>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Button onClick={save} disabled={saving}>{saving ? t(T.saving) : t(T.save)}</Button>
      </Card>

      <Card className="space-y-4 p-5" data-testid="rider-sensitive-request">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-ink-900">{t(T.identityBank)}</h3>
          {latest ? (
            <Badge tone={latest.status === "PENDING" ? "warning" : latest.status === "APPROVED" ? "success" : latest.status === "REJECTED" ? "danger" : "neutral"}>
              {t(T.lastRequest)} {lang === "en" ? latest.status.toLowerCase() : t(REQUEST_STATUS_TEXT[latest.status])}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-ink-500">{t(T.checkedFirst)}</p>
        {latest?.status === "PENDING" ? (
          <Alert tone="info">
            {t(T.waiting)}{" "}
            {Object.entries(latest.masked)
              .map(([k, v]) => {
                const label = SENSITIVE.find((s) => s.key === k)?.label;
                return `${label ? t(label) : k} ${v}`;
              })
              .join(", ")}
            . {t(T.replaces)}
          </Alert>
        ) : null}
        {latest?.status === "REJECTED" && latest.rejectionReason ? <Alert tone="danger">{t(T.notApproved)} {latest.rejectionReason}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {SENSITIVE.map((f) => (
            <Field key={f.key} label={t(f.label)}>
              <input className={inputClass} autoComplete="off" placeholder={f.placeholder ? t(f.placeholder) : undefined}
                value={sensitive[f.key] ?? ""} onChange={(e) => setSensitive({ ...sensitive, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        {sensitiveMsg ? <Alert tone={sensitiveMsg.tone}>{sensitiveMsg.text}</Alert> : null}
        <Button variant="secondary" onClick={sendSensitive} disabled={sending || !Object.values(sensitive).some((v) => v.trim())}>
          {sending ? t(T.sending) : t(T.sendForReview)}
        </Button>
      </Card>
    </div>
  );
}
