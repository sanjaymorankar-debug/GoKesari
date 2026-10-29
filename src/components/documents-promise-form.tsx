"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button } from "@/components/ui";

/**
 * "I will provide all relevant documents within 30 days" (owner decision 29 Oct 2026):
 * lets the owner pay the registration fee before the rest of the documents are verified.
 * The shop then waits for GoKesari's team to approve it.
 */
export function DocumentsPromiseForm({ shopId, promiseDays }: { shopId: string; promiseDays: number }) {
  const router = useRouter();
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/shops/${shopId}/documents-promise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promise: true }),
    }).catch(() => null);
    const payload = res ? await res.json().catch(() => null) : null;
    setBusy(false);
    if (!res?.ok) {
      setError(payload?.error?.message ?? "That did not work. Please try again.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-3 rounded-lg border border-cream-200 p-3" data-testid="documents-promise">
      <label className="flex items-start gap-2 text-sm text-ink-800">
        <input type="checkbox" className="mt-1" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
        <span>
          I will provide all relevant documents within {promiseDays} days. I understand my shop goes live only after GoKesari&apos;s team
          approves it, and that it can be suspended if the documents are not provided.
        </span>
      </label>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" variant="secondary" className="w-full" disabled={!ticked || busy} onClick={() => void submit()}>
        {busy ? "Saving…" : "Continue to payment"}
      </Button>
    </div>
  );
}
