"use client";

import { useRef, useState } from "react";

import { Alert, Button } from "@/components/ui";

export interface UploadedImage {
  id: string;
  url: string;
}

/** DISPUTE_EVIDENCE (event layer): photos on a dispute case. */
export type ImageUploadPurpose = "PRODUCT" | "RETURN_EVIDENCE" | "DISPUTE_EVIDENCE";

const MAX_SIDE = 1600;
const QUALITY = 0.82;

/**
 * Shrinks a picture in the browser (longest side ≤ 1600px, JPEG 82%) so phone
 * photos upload quickly and stay well inside the server's limits. If the
 * browser cannot decode the file the original is sent and the server decides.
 */
export async function shrinkImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** Uploads one file to /api/images and returns its id and URL. */
export async function uploadImage(file: File, purpose: ImageUploadPurpose): Promise<UploadedImage> {
  const blob = await shrinkImage(file);
  const form = new FormData();
  form.append("file", blob, file.name.replace(/\.\w+$/, "") + ".jpg");
  form.append("purpose", purpose);
  const res = await fetch("/api/images", { method: "POST", body: form });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(payload?.error?.message ?? "Could not upload the image.");
  return { id: payload.id, url: payload.url };
}

/** A small multi-image picker with previews, used for return and dispute photos. */
export function ImageUploader({
  purpose,
  value,
  onChange,
  max = 6,
  label = "Add photos",
}: {
  purpose: ImageUploadPurpose;
  value: UploadedImage[];
  onChange: (images: UploadedImage[]) => void;
  max?: number;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    const next = [...value];
    for (const file of Array.from(files)) {
      if (next.length >= max) {
        setError(`You can add up to ${max} photos.`);
        break;
      }
      try {
        next.push(await uploadImage(file, purpose));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not upload the image.");
      }
    }
    onChange(next);
    setBusy(false);
    if (input.current) input.current.value = "";
  }

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {value.map((image) => (
          <div key={image.id} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.url} alt="Uploaded" className="h-16 w-16 rounded-lg border border-cream-200 object-cover" />
            <button
              type="button"
              aria-label="Remove photo"
              onClick={() => onChange(value.filter((i) => i.id !== image.id))}
              className="absolute -right-1 -top-1 h-5 w-5 rounded-full bg-ink-900 text-xs leading-5 text-white"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => void pick(e.target.files)}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="mt-2"
        disabled={busy || value.length >= max}
        onClick={() => input.current?.click()}
      >
        {busy ? "Uploading…" : label}
      </Button>
      {error ? (
        <div className="mt-2">
          <Alert tone="warning">{error}</Alert>
        </div>
      ) : null}
    </div>
  );
}
