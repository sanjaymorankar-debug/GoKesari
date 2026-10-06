"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { uploadImage } from "@/components/image-uploader";
import { SafeImage } from "@/components/safe-image";
import { Alert, Badge, Button, Card } from "@/components/ui";

export interface ManagedImage {
  id: string;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  /** F10: PENDING / REJECTED photos are not shown to customers. */
  moderationStatus?: "PENDING" | "APPROVED" | "REJECTED";
  rejectionReason?: string | null;
}

/**
 * One scope's photos — upload (several at once), make primary, reorder, replace, delete.
 * `shopProductId` null manages the product's own photos; set manages one shop listing's.
 */
export function ProductImagesManager({
  productId,
  shopProductId,
  images,
  max,
  title,
  hint,
}: {
  productId: string;
  shopProductId: string | null;
  images: ManagedImage[];
  max: number;
  title: string;
  hint?: string;
}) {
  const router = useRouter();
  const addInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<Response | void>) {
    setBusy(true);
    setError(null);
    try {
      const res = await work();
      if (res && !res.ok) {
        const payload = await res.json().catch(() => null);
        setError(payload?.error?.message ?? "That did not work.");
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/products/${productId}/images`;
  const json = { "Content-Type": "application/json" };

  async function addFiles(files: FileList | null) {
    if (!files) return;
    await run(async () => {
      for (const file of Array.from(files)) {
        const uploaded = await uploadImage(file, "PRODUCT");
        const res = await fetch(base, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ storedImageId: uploaded.id, shopProductId }),
        });
        if (!res.ok) return res;
      }
    });
    if (addInput.current) addInput.current.value = "";
  }

  async function replaceFile(files: FileList | null) {
    const id = replacing;
    setReplacing(null);
    if (!files?.[0] || !id) return;
    await run(async () => {
      const uploaded = await uploadImage(files[0], "PRODUCT");
      return fetch(`${base}/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ action: "replace", storedImageId: uploaded.id }) });
    });
    if (replaceInput.current) replaceInput.current.value = "";
  }

  function move(index: number, delta: -1 | 1) {
    const ids = images.map((i) => i.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => fetch(`${base}/order`, { method: "PUT", headers: json, body: JSON.stringify({ shopProductId, orderedIds: ids }) }));
  }

  return (
    <Card className="space-y-3 p-4" data-testid="images-manager">
      <div>
        <h2 className="text-base font-semibold text-ink-900">{title}</h2>
        {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
      </div>

      {images.length === 0 ? <p className="text-sm text-ink-500">No photos yet.</p> : null}
      <ul className="grid gap-3 sm:grid-cols-3">
        {images.map((image, index) => (
          <li key={image.id} className="space-y-2 rounded-lg border border-cream-200 p-2" data-testid="managed-image">
            <SafeImage src={image.url} alt={image.altText ?? "Product photo"} className="h-32 w-full rounded object-cover" />
            {image.moderationStatus === "REJECTED" && image.rejectionReason ? (
              <p className="text-xs text-red-700" data-testid="image-rejection-reason">
                {image.rejectionReason}
              </p>
            ) : null}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1">
                {image.isPrimary ? <Badge tone="success">Primary</Badge> : <span className="text-xs text-ink-400">#{index + 1}</span>}
                {image.moderationStatus === "PENDING" ? <Badge tone="warning">Awaiting approval</Badge> : null}
                {image.moderationStatus === "REJECTED" ? <Badge tone="danger">Not approved</Badge> : null}
              </span>
              <span className="flex gap-1">
                <button type="button" aria-label="Move earlier" disabled={busy || index === 0} onClick={() => move(index, -1)} className="px-1 text-sm disabled:opacity-30">
                  ←
                </button>
                <button type="button" aria-label="Move later" disabled={busy || index === images.length - 1} onClick={() => move(index, 1)} className="px-1 text-sm disabled:opacity-30">
                  →
                </button>
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {!image.isPrimary ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => fetch(`${base}/${image.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ action: "primary" }) }))}>
                  Make primary
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setReplacing(image.id);
                  replaceInput.current?.click();
                }}
              >
                Replace
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Delete this photo?")) void run(() => fetch(`${base}/${image.id}`, { method: "DELETE" }));
                }}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <input ref={addInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
      <input ref={replaceInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void replaceFile(e.target.files)} />
      <Button disabled={busy || images.length >= max} onClick={() => addInput.current?.click()}>
        {busy ? "Working…" : images.length >= max ? `Limit of ${max} reached` : "Add photos"}
      </Button>
      <p className="text-xs text-ink-500">JPEG, PNG or WebP. Photos are shrunk before upload.</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
