"use client";

/**
 * Module 1 (docs/three-modules-2026-10): a shop product's own photos and
 * descriptions, built for a phone first.
 *
 * - "Take photo" opens the camera, "Choose from gallery" the photo library.
 *   Photos are shrunk in the browser before upload (quicker on mobile data);
 *   the server checks and rebuilds them regardless.
 * - Drag a photo by its handle (works with a finger) or use the arrows; the
 *   first photo is the main one customers see first.
 * - Anything the shop leaves empty shows the master product's photo or text.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { shrinkImage } from "@/components/image-uploader";
import { SafeImage } from "@/components/safe-image";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import type { ListingMediaView } from "@/server/services/shop-media";

type Photo = ListingMediaView["photos"][number];

interface Upload {
  key: string;
  name: string;
  progress: number;
  error: string | null;
}

interface Change {
  id: string;
  at: string;
  summary: string;
  actorName: string | null;
  via: string | null;
}

const VIA_LABEL: Record<string, string> = { OWNER: "owner", STAFF: "staff", SUPPORT: "GoKesari support" };

/** POSTs a form with upload progress (fetch has no upload progress events). */
function postWithProgress(url: string, form: FormData, onProgress: (fraction: number) => void) {
  return new Promise<{ status: number; body: { error?: { message?: string } } & Record<string, unknown> }>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = {};
      }
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: { error: { message: "No connection. Check your internet and try again." } } });
    xhr.send(form);
  });
}

function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function ShopProductMediaEditor({ shopId, initial }: { shopId: string; initial: ListingMediaView }) {
  const base = `/api/shops/${shopId}/listings/${initial.listing.id}/media`;
  const [view, setView] = useState(initial);
  const [photos, setPhotos] = useState<Photo[]>(initial.photos);
  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const savedOrder = useRef<string[]>(initial.photos.map((p) => p.id));

  const [shortText, setShortText] = useState(initial.listing.shortDescription ?? "");
  const [longText, setLongText] = useState(initial.listing.longDescription ?? "");
  const [savingText, setSavingText] = useState(false);
  const [history, setHistory] = useState<Change[] | null>(null);

  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const { maxPhotos, maxUploadBytes, shortDescriptionMax, longDescriptionMax } = view.limits;
  const free = maxPhotos - photos.length - uploads.filter((u) => !u.error).length;

  const reload = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    if (!res.ok) return;
    const next = (await res.json()) as ListingMediaView;
    setView(next);
    setPhotos(next.photos);
    savedOrder.current = next.photos.map((p) => p.id);
  }, [base]);

  /* ---------------------------------------------------------------- upload */

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
    const list = Array.from(files);
    const room = Math.max(0, maxPhotos - photosRef.current.length);
    if (list.length > room) {
      setError(room === 0 ? `This product already has ${maxPhotos} photos. Remove one first.` : `You can add ${room} more photo${room === 1 ? "" : "s"}.`);
    }
    for (const file of list.slice(0, room)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0, error: null }]);
      const blob = await shrinkImage(file);
      if (blob.size > maxUploadBytes) {
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: `Larger than ${Math.round(maxUploadBytes / (1024 * 1024))} MB.` } : x)));
        continue;
      }
      const form = new FormData();
      form.append("file", blob, file.name);
      const res = await postWithProgress(`${base}/photos`, form, (p) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))),
      );
      if (res.status === 201) {
        setUploads((u) => u.filter((x) => x.key !== key));
        await reload();
      } else {
        setUploads((u) =>
          u.map((x) => (x.key === key ? { ...x, error: res.body?.error?.message ?? "Could not upload this photo." } : x)),
        );
      }
    }
    if (camera.current) camera.current.value = "";
    if (gallery.current) gallery.current.value = "";
  }

  /* --------------------------------------------------------------- reorder */

  async function saveOrder(next: Photo[]) {
    const ids = next.map((p) => p.id);
    if (ids.join() === savedOrder.current.join()) return;
    setBusy(true);
    const res = await fetch(`${base}/photos/order`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageIds: ids }),
    });
    setBusy(false);
    if (res.ok) {
      savedOrder.current = ids;
      setNotice(ids[0] !== view.photos[0]?.id ? "Main photo changed." : "Order saved.");
      await reload();
    } else {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not save the new order.");
      await reload();
    }
  }

  function nudge(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= photos.length) return;
    const next = moveItem(photos, index, to);
    setPhotos(next);
    void saveOrder(next);
  }

  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>, id: string) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragId.current = id;
    setDragging(id);
  }

  function onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!dragId.current) return;
    const over = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-photo-id]");
    const overId = over?.getAttribute("data-photo-id");
    if (!overId || overId === dragId.current) return;
    setPhotos((current) => {
      const from = current.findIndex((p) => p.id === dragId.current);
      const to = current.findIndex((p) => p.id === overId);
      return from < 0 || to < 0 ? current : moveItem(current, from, to);
    });
  }

  function onPointerUp() {
    if (!dragId.current) return;
    dragId.current = null;
    setDragging(null);
    void saveOrder(photosRef.current);
  }

  /* ---------------------------------------------------------------- remove */

  async function remove(photo: Photo) {
    if (!window.confirm("Remove this photo?")) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`${base}/photos/${photo.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not remove the photo.");
    }
    await reload();
  }

  /* ---------------------------------------------------------- descriptions */

  async function saveText(patch: { shortDescription?: string | null; longDescription?: string | null }) {
    setSavingText(true);
    setError(null);
    setNotice(null);
    const res = await fetch(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSavingText(false);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setError(body?.error?.message ?? "Could not save the description.");
      return;
    }
    setShortText(body.shortDescription ?? "");
    setLongText(body.longDescription ?? "");
    setNotice("Description saved.");
    await reload();
    setHistory(null);
  }

  /* --------------------------------------------------------------- history */

  async function loadHistory() {
    if (history) return;
    const res = await fetch(`${base}/history`, { cache: "no-store" });
    const body = await res.json().catch(() => null);
    setHistory(res.ok ? body.changes : []);
  }

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const textChanged =
    shortText !== (view.listing.shortDescription ?? "") || longText !== (view.listing.longDescription ?? "");

  return (
    <div className="space-y-5">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {/* What customers see */}
      <Card className="flex gap-3 p-3" data-testid="customer-preview">
        <SafeImage
          src={view.effective.photos[0]?.url}
          size="thumb"
          alt={view.listing.productName}
          className="h-20 w-20 shrink-0 rounded-lg bg-cream-100 object-cover"
        />
        <div className="min-w-0 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">What customers see</p>
          <p className="truncate font-semibold text-ink-900">{view.listing.productName}</p>
          <p className="line-clamp-2 text-ink-600">{view.effective.shortDescription ?? "No description yet."}</p>
          <p className="mt-1 text-xs text-ink-500">
            Photo: {view.effective.photos[0]?.source === "SHOP" ? "yours" : view.effective.photos.length ? "GoKesari's" : "none"} · Text:{" "}
            {view.effective.shortSource === "SHOP" ? "yours" : view.effective.shortSource ? "GoKesari's" : "none"}
          </p>
        </div>
      </Card>

      {/* Photos */}
      <section aria-labelledby="photos-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="photos-heading" className="text-lg font-semibold text-ink-900">
            Photos <span className="text-sm font-normal text-ink-500">({photos.length}/{maxPhotos})</span>
          </h2>
          {photos.length > 1 ? <p className="text-xs text-ink-500">Drag ⠿ or use the arrows. First = main.</p> : null}
        </div>

        {photos.length === 0 ? (
          <Alert tone="info">
            {view.masterPhotos.length > 0
              ? "Customers see GoKesari's photo for this product until you add your own."
              : "This product has no photo yet. Add one so customers can see it."}
          </Alert>
        ) : null}

        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="photo-grid">
          {photos.map((photo, index) => (
            <li
              key={photo.id}
              data-photo-id={photo.id}
              className={`relative overflow-hidden rounded-xl border bg-white ${
                dragging === photo.id ? "border-kesari-500 opacity-70 ring-2 ring-kesari-300" : "border-cream-200"
              }`}
            >
              <SafeImage src={photo.url} size="medium" alt={`Photo ${index + 1}`} className="aspect-square w-full bg-cream-100 object-cover" />
              <div className="absolute left-2 top-2 flex flex-wrap gap-1">
                {index === 0 ? <Badge tone="success">Main photo</Badge> : <Badge>{index + 1}</Badge>}
                {photo.moderationStatus === "PENDING" ? <Badge tone="warning">Waiting for review</Badge> : null}
                {photo.moderationStatus === "REJECTED" ? <Badge tone="danger">Not approved</Badge> : null}
              </div>
              <button
                type="button"
                aria-label={`Drag photo ${index + 1}`}
                className="absolute right-2 top-2 flex h-10 w-10 cursor-grab touch-none items-center justify-center rounded-lg bg-white/90 text-lg text-ink-700 shadow active:cursor-grabbing"
                onPointerDown={(e) => onPointerDown(e, photo.id)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                ⠿
              </button>
              {photo.rejectionReason ? <p className="px-2 pt-1 text-xs text-red-700">{photo.rejectionReason}</p> : null}
              <div className="flex items-center justify-between gap-1 p-2">
                <div className="flex gap-1">
                  <Button size="sm" variant="secondary" aria-label="Move earlier" disabled={busy || index === 0} onClick={() => nudge(index, -1)}>
                    ←
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label="Move later"
                    disabled={busy || index === photos.length - 1}
                    onClick={() => nudge(index, 1)}
                  >
                    →
                  </Button>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(photo)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.key} className="flex aspect-square flex-col justify-end rounded-xl border border-dashed border-cream-200 p-3 text-xs">
              <p className="truncate text-ink-700">{u.name}</p>
              {u.error ? (
                <>
                  <p className="mt-1 text-red-700">{u.error}</p>
                  <button type="button" className="mt-1 text-left text-kesari-700 underline" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                    Dismiss
                  </button>
                </>
              ) : (
                <div className="mt-2 h-2 overflow-hidden rounded bg-cream-100" role="progressbar" aria-valuenow={Math.round(u.progress * 100)}>
                  <div className="h-full bg-kesari-500 transition-all" style={{ width: `${Math.max(5, u.progress * 100)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>

        {free > 0 ? (
          <div className="grid grid-cols-2 gap-3">
            <Button size="lg" onClick={() => camera.current?.click()} disabled={busy}>
              📷 Take photo
            </Button>
            <Button size="lg" variant="secondary" onClick={() => gallery.current?.click()} disabled={busy}>
              🖼️ From gallery
            </Button>
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
              data-testid="camera-input"
            />
            <input
              ref={gallery}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
              data-testid="gallery-input"
            />
          </div>
        ) : (
          <p className="text-xs text-ink-500">Up to {maxPhotos} photos. Remove one to add another.</p>
        )}
        <p className="text-xs text-ink-500">
          JPG, PNG or WebP, up to {Math.round(maxUploadBytes / (1024 * 1024))} MB each. Location and camera details are removed from every photo.
        </p>
      </section>

      {/* Descriptions */}
      <section aria-labelledby="text-heading" className="space-y-3">
        <h2 id="text-heading" className="text-lg font-semibold text-ink-900">
          Description
        </h2>
        <Field
          label={`Short description (${shortText.length}/${shortDescriptionMax})`}
          hint={shortText ? "Shown on the product card." : "Empty: customers see GoKesari's description."}
        >
          <textarea
            className={inputClass}
            rows={2}
            maxLength={shortDescriptionMax}
            value={shortText}
            placeholder={view.effective.shortSource === "MASTER" ? view.effective.shortDescription ?? "" : "e.g. Fresh toned milk, 500 ml pouch"}
            onChange={(e) => setShortText(e.target.value)}
          />
        </Field>
        <Field
          label={`Long description (${longText.length}/${longDescriptionMax})`}
          hint={longText ? "Shown on the product page." : "Empty: customers see GoKesari's description."}
        >
          <textarea
            className={inputClass}
            rows={6}
            maxLength={longDescriptionMax}
            value={longText}
            placeholder={view.masterDescription ?? "Ingredients, size, how to store, anything customers ask about"}
            onChange={(e) => setLongText(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button disabled={savingText || !textChanged} onClick={() => saveText({ shortDescription: shortText, longDescription: longText })}>
            {savingText ? "Saving…" : "Save description"}
          </Button>
          {view.listing.shortDescription || view.listing.longDescription ? (
            <Button
              variant="ghost"
              disabled={savingText}
              onClick={() => {
                if (window.confirm("Remove your descriptions and show GoKesari's instead?")) {
                  void saveText({ shortDescription: null, longDescription: null });
                }
              }}
            >
              Use GoKesari&apos;s description
            </Button>
          ) : null}
        </div>
      </section>

      {/* History */}
      <details className="rounded-xl border border-cream-200 bg-white p-3" onToggle={(e) => (e.currentTarget.open ? void loadHistory() : null)}>
        <summary className="cursor-pointer text-sm font-semibold text-ink-800">Change history</summary>
        {history === null ? (
          <p className="mt-2 text-xs text-ink-500">Loading…</p>
        ) : history.length === 0 ? (
          <p className="mt-2 text-xs text-ink-500">No changes yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-cream-100 text-sm" data-testid="change-history">
            {history.map((c) => (
              <li key={c.id} className="py-2">
                <p className="text-ink-800">{c.summary}</p>
                <p className="text-xs text-ink-500">
                  {c.actorName ?? "Someone"}
                  {c.via ? ` (${VIA_LABEL[c.via] ?? c.via.toLowerCase()})` : ""} ·{" "}
                  {new Date(c.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
