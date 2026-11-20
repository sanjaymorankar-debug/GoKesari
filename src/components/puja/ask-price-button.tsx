"use client";

/**
 * "Price on confirmation" (docs/puja-samagri-2026-11, brief §7): asks the shop to price a loose
 * or perishable item that has no price yet. The shop is told at once; when it answers, the
 * customer gets a notification and the item goes in the cart like any other.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function AskPriceButton({ shopProductId, signedIn, unit }: { shopProductId: string; signedIn: boolean; unit: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <button type="button" onClick={() => router.push(`/signin?next=${encodeURIComponent("/puja")}`)} className="min-h-10 w-full rounded-xl border border-kesari-600 px-3 text-sm font-semibold text-kesari-800">
        Sign in to ask the price
      </button>
    );
  }
  if (state === "sent") {
    return (
      <p className="rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-800" role="status" data-testid="price-asked">
        Asked. We will tell you when the shop sets the price.
      </p>
    );
  }
  async function send() {
    setState("busy");
    setMessage(null);
    const quantity = qty.trim() ? Number(qty) : null;
    const res = await fetch("/api/listing-price-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopProductId, quantity: quantity && quantity > 0 ? quantity : null }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      setState("error");
      setMessage(body?.error?.message ?? "Could not send. Please try again.");
      return;
    }
    setState("sent");
  }
  return open ? (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-ink-700">
        How much? ({unit}, optional)
        <input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} className="mt-1 min-h-10 w-full rounded-lg border border-cream-200 px-2 text-sm" />
      </label>
      <button type="button" disabled={state === "busy"} onClick={send} className="min-h-10 w-full rounded-xl bg-kesari-600 px-3 text-sm font-semibold text-white disabled:bg-cream-200 disabled:text-ink-600" data-testid="ask-price-send">
        {state === "busy" ? "Sending…" : "Send to shop"}
      </button>
      {message ? <p className="text-xs text-red-700" role="alert">{message}</p> : null}
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="min-h-10 w-full rounded-xl border border-kesari-600 px-3 text-sm font-semibold text-kesari-800 hover:bg-kesari-50" data-testid="ask-price">
      Ask price
    </button>
  );
}
