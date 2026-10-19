"use client";

/**
 * Home hero banners (docs/homepage-uiux-2026-10, F1) for admins and operators:
 * add or edit a banner (picture, title, button, schedule, city / PIN), switch
 * it on or off, move it up or down the carousel, or delete it. The server
 * validates everything again (services/home-banners.ts).
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface BannerRow {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  ctaLabel: string | null;
  ctaHref: string;
  kind: "DEAL" | "SEASONAL" | "NEW_SHOPS" | "GENERAL";
  city: string | null;
  pincode: string | null;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  /** Live now for everyone it targets (switched on and inside its window). */
  liveNow: boolean;
}

const KIND_LABELS: Record<BannerRow["kind"], string> = {
  DEAL: "Daily deal",
  SEASONAL: "Seasonal offer",
  NEW_SHOPS: "New shops",
  GENERAL: "General",
};

/** ISO → the value a datetime-local input shows, in the browser's time zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : null);

type Draft = Omit<BannerRow, "id" | "liveNow" | "active" | "startsAt" | "endsAt"> & { startsAt: string; endsAt: string };

const EMPTY: Draft = { title: "", subtitle: "", imageUrl: "", ctaLabel: "", ctaHref: "/shops", kind: "GENERAL", city: "", pincode: "", startsAt: "", endsAt: "" };

async function send(url: string, method: string, body?: unknown): Promise<string | null> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null);
  if (res?.ok) return null;
  const data = await res?.json().catch(() => null);
  const fields = data?.error?.details?.fieldErrors as Record<string, string> | undefined;
  return (fields && Object.values(fields)[0]) ?? data?.error?.message ?? "That did not work — please try again.";
}

export function HomeBannerManager({ banners }: { banners: BannerRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | "new" | null>(banners.length === 0 ? "new" : null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function edit(row: BannerRow | null) {
    setError(null);
    if (!row) {
      setDraft(EMPTY);
      setEditing("new");
      return;
    }
    setDraft({
      title: row.title,
      subtitle: row.subtitle ?? "",
      imageUrl: row.imageUrl ?? "",
      ctaLabel: row.ctaLabel ?? "",
      ctaHref: row.ctaHref,
      kind: row.kind,
      city: row.city ?? "",
      pincode: row.pincode ?? "",
      startsAt: toLocalInput(row.startsAt),
      endsAt: toLocalInput(row.endsAt),
    });
    setEditing(row.id);
  }

  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    const failed = await task();
    setBusy(false);
    if (failed) {
      setError(failed);
      return false;
    }
    router.refresh();
    return true;
  }

  async function save() {
    const body = { ...draft, startsAt: toIso(draft.startsAt), endsAt: toIso(draft.endsAt) };
    const saved = await run(() => (editing === "new" ? send("/api/admin/home-banners", "POST", body) : send(`/api/admin/home-banners/${editing}`, "PATCH", body)));
    if (saved) setEditing(null);
  }

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/admin/home-banners/image", { method: "POST", body: form }).catch(() => null);
    const data = await res?.json().catch(() => null);
    setUploading(false);
    if (!res?.ok) {
      setError(data?.error?.message ?? "The picture could not be uploaded.");
      return;
    }
    setDraft((d) => ({ ...d, imageUrl: data.url }));
  }

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <div className="space-y-4" data-testid="home-banner-manager">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {editing ? (
        <Card className="space-y-3 p-4" data-testid="home-banner-form">
          <p className="text-base font-bold text-ink-900">{editing === "new" ? "New banner" : "Edit banner"}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title">
              <input className={inputClass} maxLength={80} value={draft.title} onChange={set("title")} placeholder="Fresh paneer, 10% off today" />
            </Field>
            <Field label="Line under the title (optional)">
              <input className={inputClass} maxLength={160} value={draft.subtitle ?? ""} onChange={set("subtitle")} />
            </Field>
            <Field label="Button text (optional)">
              <input className={inputClass} maxLength={30} value={draft.ctaLabel ?? ""} onChange={set("ctaLabel")} placeholder="Shop now" />
            </Field>
            <Field label="Button opens">
              <input className={inputClass} maxLength={500} value={draft.ctaHref} onChange={set("ctaHref")} placeholder="/shops?type=DAIRY" />
            </Field>
            <Field label="Kind">
              <select className={inputClass} value={draft.kind} onChange={set("kind")}>
                {(Object.keys(KIND_LABELS) as BannerRow["kind"][]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <span className="mb-1 block text-sm font-medium text-ink-700">Picture (optional)</span>
              <div className="flex items-center gap-2">
                <input aria-label="Picture link" className={inputClass} value={draft.imageUrl ?? ""} onChange={set("imageUrl")} placeholder="https://… or upload" />
                <label className="inline-flex min-h-11 cursor-pointer items-center whitespace-nowrap rounded-lg border border-cream-200 px-3 text-sm font-medium text-ink-900 hover:bg-cream-100">
                  {uploading ? "Uploading…" : "Upload"}
                  <input type="file" accept="image/*" className="sr-only" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                </label>
              </div>
            </div>
            <Field label="Show from (optional)">
              <input type="datetime-local" className={inputClass} value={draft.startsAt} onChange={set("startsAt")} />
            </Field>
            <Field label="Show until (optional)">
              <input type="datetime-local" className={inputClass} value={draft.endsAt} onChange={set("endsAt")} />
            </Field>
            <Field label="Only in this city (optional)">
              <input className={inputClass} maxLength={60} value={draft.city ?? ""} onChange={set("city")} placeholder="Pune" />
            </Field>
            <Field label="Only for this PIN code (optional)">
              <input className={inputClass} inputMode="numeric" maxLength={6} value={draft.pincode ?? ""} onChange={set("pincode")} placeholder="411001" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={busy || uploading}>
              {editing === "new" ? "Add banner" : "Save changes"}
            </Button>
            {banners.length > 0 ? (
              <Button variant="secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </Button>
            ) : null}
          </div>
        </Card>
      ) : (
        <Button onClick={() => edit(null)}>Add a banner</Button>
      )}

      {banners.length === 0 ? (
        <p className="text-sm text-ink-600">No banners yet — the home page shows its three built-in banners until one is live.</p>
      ) : (
        <ol className="space-y-2">
          {banners.map((b, i) => (
            <li key={b.id}>
              <Card className="flex flex-wrap items-center gap-3 p-3" data-testid="home-banner-row" data-active={b.active ? "true" : "false"}>
                <span className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-lg bg-kesari-50 text-xs text-ink-500">
                  {b.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.imageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    "No picture"
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-ink-900">{b.title}</span>
                    <Badge tone={b.liveNow ? "success" : b.active ? "info" : "neutral"}>{b.liveNow ? "live" : b.active ? "scheduled" : "off"}</Badge>
                    <Badge tone="neutral">{KIND_LABELS[b.kind]}</Badge>
                  </span>
                  <span className="block truncate text-xs text-ink-600">
                    {b.ctaHref}
                    {b.city ? ` · ${b.city}` : ""}
                    {b.pincode ? ` · PIN ${b.pincode}` : ""}
                    {b.startsAt ? ` · from ${new Date(b.startsAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}
                    {b.endsAt ? ` · until ${new Date(b.endsAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" disabled={busy || i === 0} aria-label={`Move ${b.title} up`} onClick={() => run(() => send(`/api/admin/home-banners/${b.id}`, "POST", { action: "up" }))}>
                    ↑
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy || i === banners.length - 1} aria-label={`Move ${b.title} down`} onClick={() => run(() => send(`/api/admin/home-banners/${b.id}`, "POST", { action: "down" }))}>
                    ↓
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => send(`/api/admin/home-banners/${b.id}`, "POST", { action: b.active ? "deactivate" : "activate" }))}>
                    {b.active ? "Switch off" : "Switch on"}
                  </Button>
                  <Button size="sm" variant="secondary" disabled={busy} onClick={() => edit(b)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => window.confirm(`Delete “${b.title}”?`) && run(() => send(`/api/admin/home-banners/${b.id}`, "DELETE"))}
                  >
                    Delete
                  </Button>
                </span>
              </Card>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
