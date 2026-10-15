"use client";

/** "Run reconciliation" for one month (docs/inventory-accounting-2026-10, Part 3): POST gst/recon, then refresh the page. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui";

import { accountsApi, ApiError } from "./api";

interface ReconResult {
  period: string;
  source: string | null;
  counts: { MATCHED: number; AMOUNT_MISMATCH: number; MISSING_IN_BOOKS: number; MISSING_ON_PORTAL: number };
}

export function GstReconButton({ shopId, period }: { shopId: string; period: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const r = await accountsApi<ReconResult>(shopId, "gst/recon", { method: "POST", body: { period } });
      const c = r.counts;
      setMessage({
        tone: "ok",
        text: r.source
          ? `Done (${r.source === "GSTR2B" ? "GSTR-2B" : "GSTR-2A"}): ${c.MATCHED} matched, ${c.AMOUNT_MISMATCH} amount mismatch, ${c.MISSING_IN_BOOKS} missing in books, ${c.MISSING_ON_PORTAL} missing on portal.`
          : `Done. No portal data for ${period} yet — ${c.MISSING_ON_PORTAL} bill(s) are not on the portal.`,
      });
      router.refresh();
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof ApiError ? e.message : "Something went wrong. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <Button onClick={() => void run()} disabled={busy}>
        {busy ? "Matching…" : "Run reconciliation"}
      </Button>
      <p aria-live="polite" className={message?.tone === "error" ? "text-sm text-red-700" : "text-sm text-ink-700"}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
