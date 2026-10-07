"use client";

/**
 * F2 — rider self-edit. Everyday details save at once; identity and bank
 * details go to an admin for review and are never shown back in full.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { VEHICLE_TYPE_KEYS, vehicleTypeLabel } from "@/lib/vehicle-types";

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

const SENSITIVE: { key: string; label: string; placeholder?: string }[] = [
  { key: "panNumber", label: "PAN", placeholder: "ABCDE1234F" },
  { key: "governmentIdType", label: "Government ID type", placeholder: "e.g. Voter ID" },
  { key: "governmentIdNumber", label: "Government ID number" },
  { key: "drivingLicenceNumber", label: "Driving licence number" },
  { key: "bankAccountHolderName", label: "Bank account holder name" },
  { key: "bankAccountNumber", label: "Bank account number" },
  { key: "bankIfsc", label: "IFSC", placeholder: "SBIN0001234" },
];

async function errorOf(res: Response) {
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? "Could not save. Please try again.";
}

export function RiderProfileEditor({ rider, latest }: { rider: EditableRider; latest: LatestChangeRequest | null }) {
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
    if (!res.ok) return setMessage({ tone: "danger", text: await errorOf(res) });
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
    if (!res.ok) return setMessage({ tone: "danger", text: await errorOf(res) });
    setMessage({ tone: "success", text: "Saved." });
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
    if (!res.ok) return setSensitiveMsg({ tone: "danger", text: await errorOf(res) });
    setSensitive({});
    setSensitiveMsg({ tone: "success", text: "Sent for review. You'll be notified when it's approved." });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5" data-testid="rider-profile-editor">
        <h3 className="font-semibold text-ink-900">Edit my details</h3>
        <div className="flex items-center gap-3">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photoUrl} alt="Profile photo" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-cream-100 text-xs text-ink-500">No photo</div>
          )}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="text-sm"
            onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name"><input className={inputClass} value={form.fullName} onChange={set("fullName")} /></Field>
          <Field label="Mobile"><input className={inputClass} value={form.mobile} onChange={set("mobile")} inputMode="numeric" /></Field>
          <Field label="Email"><input className={inputClass} value={form.email} onChange={set("email")} type="email" /></Field>
          <Field label="Date of birth"><input className={inputClass} value={form.dateOfBirth} onChange={set("dateOfBirth")} type="date" /></Field>
          <Field label="Vehicle">
            <select className={inputClass} value={form.vehicleType} onChange={set("vehicleType")}>
              {VEHICLE_TYPE_KEYS.map((v) => <option key={v} value={v}>{vehicleTypeLabel(v)}</option>)}
            </select>
          </Field>
          <Field label="Registration number"><input className={inputClass} value={form.vehicleRegistrationNumber} onChange={set("vehicleRegistrationNumber")} /></Field>
          <Field label="Working radius (km)"><input className={inputClass} value={form.operatingRadiusKm} onChange={set("operatingRadiusKm")} inputMode="numeric" /></Field>
        </div>
        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
      </Card>

      <Card className="space-y-4 p-5" data-testid="rider-sensitive-request">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-ink-900">Identity &amp; bank details</h3>
          {latest ? (
            <Badge tone={latest.status === "PENDING" ? "warning" : latest.status === "APPROVED" ? "success" : latest.status === "REJECTED" ? "danger" : "neutral"}>
              Last request: {latest.status.toLowerCase()}
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-ink-500">
          Changes here are checked by our team before they apply. Fill in only what has changed.
        </p>
        {latest?.status === "PENDING" ? (
          <Alert tone="info">
            Waiting for review: {Object.entries(latest.masked).map(([k, v]) => `${SENSITIVE.find((s) => s.key === k)?.label ?? k} ${v}`).join(", ")}. Sending a new request replaces it.
          </Alert>
        ) : null}
        {latest?.status === "REJECTED" && latest.rejectionReason ? <Alert tone="danger">Not approved: {latest.rejectionReason}</Alert> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {SENSITIVE.map((f) => (
            <Field key={f.key} label={f.label}>
              <input className={inputClass} autoComplete="off" placeholder={f.placeholder}
                value={sensitive[f.key] ?? ""} onChange={(e) => setSensitive({ ...sensitive, [f.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        {sensitiveMsg ? <Alert tone={sensitiveMsg.tone}>{sensitiveMsg.text}</Alert> : null}
        <Button variant="secondary" onClick={sendSensitive} disabled={sending || !Object.values(sensitive).some((v) => v.trim())}>
          {sending ? "Sending…" : "Send for review"}
        </Button>
      </Card>
    </div>
  );
}
