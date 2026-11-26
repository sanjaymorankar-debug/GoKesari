"use client";

/**
 * Full-page acknowledgement shown instead of Seller Central while the shop owner has not accepted
 * the current seller undertaking (docs/seller-undertaking-2026-11; flag seller_undertaking_gate_enabled).
 * Both boxes start unticked; "I agree" stays disabled until both are ticked. The server refuses
 * the POST unless both are explicitly true.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SellerUndertakingClauses } from "@/components/legal/seller-undertaking-clauses";
import { Alert, Button, Card } from "@/components/ui";
import {
  formatUndertakingDate,
  SELLER_TERMS_ACCEPT_TEXT,
  SELLER_UNDERTAKING_EFFECTIVE_DATE,
  SELLER_UNDERTAKING_PROMISE,
  SELLER_UNDERTAKING_TITLE,
  SELLER_UNDERTAKING_VERSION,
} from "@/lib/legal/seller-undertaking";
import { signOutAction } from "@/server/sign-out-action";

export function SellerUndertakingGate({ ownerName }: { ownerName?: string | null }) {
  const router = useRouter();
  const [promise, setPromise] = useState(false);
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function agree() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/seller/undertaking", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acceptUndertaking: promise, acceptTerms: terms }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Could not save your acceptance. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach GoKesari. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-cream-50 px-4 py-6" data-testid="seller-undertaking-gate">
      <Card className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{SELLER_UNDERTAKING_TITLE}</h1>
          <p className="mt-1 text-sm text-ink-600">
            Version {SELLER_UNDERTAKING_VERSION} · effective {formatUndertakingDate(SELLER_UNDERTAKING_EFFECTIVE_DATE)} (IST)
          </p>
          <p className="mt-2 text-sm text-ink-700">
            {ownerName ? `${ownerName}, before` : "Before"} you continue to Seller Central and accept new orders, please read and accept
            this undertaking. Orders you have already accepted carry on as normal.
          </p>
        </div>

        <label className="flex items-start gap-3 rounded-lg border border-kesari-200 bg-kesari-50 p-3 text-sm text-ink-900">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 shrink-0"
            checked={promise}
            onChange={(e) => setPromise(e.target.checked)}
            data-testid="undertaking-promise"
          />
          <span>{SELLER_UNDERTAKING_PROMISE}</span>
        </label>

        <details className="rounded-lg border border-cream-200 p-3 text-sm text-ink-700">
          <summary className="cursor-pointer font-medium text-kesari-800">Read the full undertaking</summary>
          <SellerUndertakingClauses className="mt-2 list-decimal space-y-2 pl-5" />
        </details>

        <label className="flex items-start gap-3 text-sm text-ink-700">
          <input
            type="checkbox"
            className="mt-0.5 h-5 w-5 shrink-0"
            checked={terms}
            onChange={(e) => setTerms(e.target.checked)}
            data-testid="undertaking-terms"
          />
          <span>
            {SELLER_TERMS_ACCEPT_TEXT}:{" "}
            <a href="/legal/seller-terms" target="_blank" rel="noopener" className="underline">Seller Terms</a>,{" "}
            <a href="/legal/terms" target="_blank" rel="noopener" className="underline">Terms &amp; Conditions</a>,{" "}
            <a href="/legal/privacy-policy" target="_blank" rel="noopener" className="underline">Privacy Policy</a>.
          </span>
        </label>

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button type="button" size="lg" disabled={busy || !promise || !terms} onClick={() => void agree()} data-testid="undertaking-agree">
            {busy ? "Saving…" : "I agree"}
          </Button>
          <form action={signOutAction}>
            <button type="submit" className="min-h-11 text-sm text-ink-600 underline">
              Sign out
            </button>
          </form>
        </div>
      </Card>
    </main>
  );
}
