"use client";

/**
 * Compose a broadcast (F3.3.2): title, message, optional picture (uploaded to
 * the image store) and link, audience (customers / shop owners / riders,
 * optionally by city or PIN) with a live size estimate, optional schedule and
 * expiry, and a preview of how it shows in the notification panel. The server
 * validates everything again (services/broadcasts.ts).
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

type Role = "CUSTOMER" | "SHOP_OWNER" | "DELIVERY_PARTNER";
const ROLE_LABELS: Record<Role, string> = { CUSTOMER: "All customers", SHOP_OWNER: "All shop owners", DELIVERY_PARTNER: "All riders" };

const splitList = (value: string) =>
  value
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);

const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

export function BroadcastComposer() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [roles, setRoles] = useState<Role[]>(["CUSTOMER"]);
  const [cities, setCities] = useState("");
  const [pincodes, setPincodes] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const audience = useMemo(
    () => ({ roles, cities: splitList(cities), pincodes: splitList(pincodes) }),
    [roles, cities, pincodes],
  );

  // Live audience size (debounced).
  useEffect(() => {
    if (roles.length === 0) return;
    let stale = false;
    const timer = setTimeout(async () => {
      const res = await fetch("/api/admin/broadcasts/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience }),
      }).catch(() => null);
      const data = await res?.json().catch(() => null);
      if (!stale) setEstimate(res?.ok && typeof data?.count === "number" ? data.count : null);
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [audience, roles.length]);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/admin/broadcasts/image", { method: "POST", body: form }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setUploading(false);
    if (!res?.ok) {
      setError(data?.error?.message ?? "The picture could not be uploaded.");
      return;
    }
    setImageUrl(data.url);
  }

  async function submit(action: "draft" | "schedule" | "send") {
    if (action === "send" && !window.confirm(`Send "${title}" to ${estimate ?? "everyone in the audience"} people now?`)) return;
    setBusy(true);
    setError(null);
    setDone(null);
    const res = await fetch("/api/admin/broadcasts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        title,
        message,
        imageUrl: imageUrl || null,
        linkUrl: linkUrl || null,
        audience,
        scheduleAt: action === "schedule" ? toIso(scheduleAt) : null,
        expiresAt: toIso(expiresAt),
      }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      const fields = data?.error?.details?.fields as Record<string, string> | undefined;
      setError(fields ? Object.values(fields).join(" ") : (data?.error?.message ?? "Could not save the broadcast."));
      return;
    }
    const b = data.broadcast;
    setDone(
      action === "send"
        ? `Sending to ${b.audienceEstimate ?? 0} people — ${b.recipientCount} reached so far.`
        : action === "schedule"
          ? "Scheduled."
          : "Saved as a draft.",
    );
    setTitle("");
    setMessage("");
    setImageUrl("");
    setLinkUrl("");
    router.refresh();
  }

  const ready = title.trim().length >= 3 && message.trim().length >= 3 && roles.length > 0;

  return (
    <Card className="p-4 sm:p-6" data-testid="broadcast-composer">
      <h2 className="mb-3 text-lg font-bold text-ink-900">New broadcast</h2>
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-3">
          <Field label="Title">
            <input className={inputClass} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Diwali sweets are here" />
          </Field>
          <Field label="Message">
            <textarea className={inputClass} rows={3} value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Picture (optional)">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="block min-h-11 w-full text-sm"
                disabled={uploading}
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
              {imageUrl ? (
                <button type="button" className="mt-1 min-h-11 text-sm text-red-800 underline" onClick={() => setImageUrl("")}>
                  Remove picture
                </button>
              ) : null}
            </Field>
            <Field label="Link (optional) — a page like /offers or an https:// link">
              <input className={inputClass} value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="/shops" />
            </Field>
          </div>

          <fieldset className="rounded-xl border border-[var(--gk-line)] p-3">
            <legend className="px-1 text-sm font-semibold text-ink-900">Audience</legend>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(ROLE_LABELS) as Role[]).map((role) => (
                <label key={role} className="flex min-h-11 items-center gap-2 rounded-lg border border-[var(--gk-line)] px-3 text-sm">
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={(e) => setRoles((current) => (e.target.checked ? [...current, role] : current.filter((r) => r !== role)))}
                  />
                  {ROLE_LABELS[role]}
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Only in these cities (comma-separated, optional)">
                <input className={inputClass} value={cities} onChange={(e) => setCities(e.target.value)} placeholder="Pune, Nashik" />
              </Field>
              <Field label="Only these PIN codes (comma-separated, optional)">
                <input className={inputClass} value={pincodes} inputMode="numeric" onChange={(e) => setPincodes(e.target.value)} placeholder="411001, 411038" />
              </Field>
            </div>
            <p className="mt-2 text-sm text-ink-700" data-testid="broadcast-estimate">
              {roles.length === 0 ? "Choose who receives it." : estimate === null ? "Counting…" : `About ${estimate} people will receive it.`}
            </p>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Send at (optional, for Schedule)">
              <input type="datetime-local" className={inputClass} value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
            </Field>
            <Field label="Expires (optional — leaves the notification centre then)">
              <input type="datetime-local" className={inputClass} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
          </div>

          {error ? <Alert tone="danger">{error}</Alert> : null}
          {done ? <Alert tone="success">{done}</Alert> : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => submit("send")} disabled={!ready || busy || uploading} data-testid="broadcast-send-now">
              Send now
            </Button>
            <Button variant="secondary" onClick={() => submit("schedule")} disabled={!ready || busy || uploading || !scheduleAt}>
              Schedule
            </Button>
            <Button variant="ghost" onClick={() => submit("draft")} disabled={!ready || busy || uploading}>
              Save draft
            </Button>
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-semibold text-ink-700">Preview</p>
          <div className="rounded-2xl border border-[var(--gk-line)] bg-white p-3 shadow-sm" data-testid="broadcast-preview">
            <div className="flex gap-3">
              <span aria-hidden className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-kesari-700" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-ink-900">{title || "Title"}</p>
                <p className="text-sm text-ink-600">{message || "Your message appears here."}</p>
                {linkUrl ? <p className="mt-1 truncate text-xs text-kesari-800">Opens {linkUrl}</p> : null}
              </div>
              {imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={imageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
              ) : null}
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-600">
            Everyone gets it in the app&apos;s notification centre. Push and email follow each person&apos;s settings for
            &quot;Announcements&quot;.
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Send now / Cancel on one listed broadcast. */
export function BroadcastActions({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(action: "send" | "cancel") {
    if (!window.confirm(action === "send" ? "Send this broadcast now?" : "Cancel this broadcast?")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/broadcasts/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setBusy(false);
    if (!res?.ok) setError(data?.error?.message ?? "That did not work.");
    else router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "DRAFT" || status === "SCHEDULED" ? (
        <Button size="sm" onClick={() => act("send")} disabled={busy}>
          Send now
        </Button>
      ) : null}
      {status === "DRAFT" || status === "SCHEDULED" || status === "SENDING" ? (
        <Button size="sm" variant="secondary" onClick={() => act("cancel")} disabled={busy}>
          Cancel
        </Button>
      ) : null}
      {error ? <span className="text-sm text-red-800">{error}</span> : null}
    </div>
  );
}
