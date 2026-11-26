"use client";

/**
 * Seller Central → Marketing (docs/shop-welcome-kit-2026-11, 26-Nov-2026): the banner's "Pay here (UPI)" QR.
 * Shows where it comes from (the UPI ID in accounts settings, or a payment QR the owner uploaded) and lets the
 * owner upload the QR they already use, or remove it. The upload is read and checked on the server.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ShopBannerUpiQr({ shopId, upiVpa, uploaded }: { shopId: string; upiVpa: string | null; uploaded: { vpa: string; payeeName: string | null } | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/shops/${shopId}/banner/upi-qr`, { method: "POST", body: form });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not read the QR.");
      setMessage({ tone: "ok", text: `Saved: payments go to ${payload.vpa}. Download the banner again to print it.` });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not read the QR." });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/shops/${shopId}/banner/upi-qr`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove it.");
      setMessage({ tone: "ok", text: "Removed. The banner uses the UPI ID from your settings." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Could not remove it." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-[var(--gk-line)] pt-3 text-sm" data-testid="banner-upi">
      <h3 className="font-bold text-ink-900">&ldquo;Pay here (UPI)&rdquo; QR on the banner</h3>
      <p className="mt-1 text-ink-700" data-testid="banner-upi-source">
        {uploaded
          ? `Your uploaded payment QR (${uploaded.vpa}${uploaded.payeeName ? `, ${uploaded.payeeName}` : ""}).`
          : upiVpa
            ? `Your UPI ID ${upiVpa} (from Accounts → Settings).`
            : "None yet: add your UPI ID, or upload your payment QR, to show a \"Pay here (UPI)\" QR beside the shop QR."}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!upiVpa ? (
          <a className="inline-flex min-h-11 items-center rounded-lg border border-[var(--gk-line)] px-3 py-2 font-medium text-ink-900" href="/shop/accounts/settings">
            Add UPI ID in Settings
          </a>
        ) : null}
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-[var(--gk-line)] px-3 py-2 font-medium text-ink-900">
          {busy ? "Reading…" : uploaded ? "Upload a different payment QR" : "Upload my payment QR (optional)"}
          <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={upload} data-testid="banner-upi-upload" />
        </label>
        {uploaded ? (
          <button type="button" className="inline-flex min-h-11 items-center rounded-lg px-3 py-2 font-medium text-red-700 underline" disabled={busy} onClick={remove}>
            Remove uploaded QR
          </button>
        ) : null}
      </div>
      {message ? (
        <p role="status" className={`mt-2 font-semibold ${message.tone === "ok" ? "text-green-800" : "text-red-700"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
