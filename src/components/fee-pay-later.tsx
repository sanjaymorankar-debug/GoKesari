"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Alert, Button } from "@/components/ui";

/**
 * docs/fee-pay-later-2026-11 (0229): the owner of a shop that owes its registration fee asks to pay it later.
 * The request goes to GoKesari's administrators; the page then shows it as waiting for approval.
 */
export function FeePayLaterRequestButton({ shopId, labels }: { shopId: string; labels: { button: string; note: string; busy: string; explain: string } }) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/shops/fee-pay-later", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shopId, note: note.trim() || null }),
    }).catch(() => null);
    const payload = response ? await response.json().catch(() => null) : null;
    busyRef.current = false;
    setBusy(false);
    if (response?.ok) {
      router.refresh();
      return;
    }
    setError(response ? (payload?.error?.message ?? "Could not send the request. Please try again.") : "Could not reach the server. Check your connection and try again.");
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" className="w-full" onClick={() => setOpen(true)} data-testid="fee-pay-later-open">
        {labels.button}
      </Button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-ink-200 p-3" data-testid="fee-pay-later-form">
      <p className="text-sm text-ink-600">{labels.explain}</p>
      <label className="block text-sm text-ink-700">
        {labels.note}
        <textarea className="mt-1 w-full rounded-md border border-ink-300 p-2 text-sm" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <Button type="button" className="w-full" disabled={busy} aria-busy={busy} onClick={() => void ask()} data-testid="fee-pay-later-submit">
        {busy ? labels.busy : labels.button}
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
