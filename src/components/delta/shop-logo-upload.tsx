"use client";

/**
 * docs/delta CF-011 (D-144): upload or remove the shop's logo from the shop's own pages.
 * Shown only when the flag shop_logo_upload_enabled is on for the shop (the page decides).
 */
import { useRef, useState } from "react";

import { shrinkImage } from "@/components/image-uploader";
import { SafeImage } from "@/components/safe-image";
import { Alert, Button, Card } from "@/components/ui";

export function ShopLogoUpload({ shopId, initialLogoUrl }: { shopId: string; initialLogoUrl: string | null }) {
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", await shrinkImage(file), file.name);
      const res = await fetch(`/api/shops/${shopId}/logo`, { method: "POST", body: form });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not upload the logo.");
      setLogoUrl(body?.logoUrl ?? null);
      setNotice("Logo saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not upload the logo.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/shops/${shopId}/logo`, { method: "DELETE" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? "Could not remove the logo.");
      setLogoUrl(null);
      setNotice("Logo removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the logo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-ink-900">Shop logo</h2>
      <p className="mt-1 text-sm text-ink-600">A square JPEG, PNG or WebP picture works best. Customers see it on your shop card.</p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <SafeImage src={logoUrl} alt="Shop logo" className="h-20 w-20 shrink-0 rounded-lg bg-cream-100 object-cover" fallbackEmoji="🏪" />
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            id={`shop-logo-${shopId}`}
            aria-label="Choose a logo picture"
            onChange={(e) => void upload(e.target.files?.[0])}
            disabled={busy}
          />
          <Button onClick={() => input.current?.click()} disabled={busy}>
            {busy ? "Saving…" : logoUrl ? "Change logo" : "Upload logo"}
          </Button>
          {logoUrl ? (
            <Button variant="secondary" onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
      {notice ? (
        <div className="mt-3">
          <Alert tone="success">{notice}</Alert>
        </div>
      ) : null}
    </Card>
  );
}
