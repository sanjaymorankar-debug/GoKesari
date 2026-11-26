"use client";

/**
 * Checks a PDF against the recorded fingerprints (docs/seller-agreements-2026-11): the file is hashed in the
 * browser (SHA-256) and only the hash is sent — the document itself never leaves the device.
 */
import { useState } from "react";

import { Alert, Card } from "@/components/ui";

export function AgreementVerifyFile({ code }: { code: string }) {
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function check(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
      const response = await fetch(`/api/agreements/verify/${encodeURIComponent(code)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha256 }),
      });
      const body = (await response.json()) as { data?: { match: boolean; language?: string }; match?: boolean; language?: string };
      const match = body.data?.match ?? body.match;
      setResult(
        match
          ? { tone: "success", text: `Genuine: this file is exactly the signed copy recorded under ${code}.` }
          : { tone: "danger", text: `Not a match: this file is not the signed copy recorded under ${code}. It may have been changed.` },
      );
    } catch {
      setResult({ tone: "danger", text: "Could not check the file. Please try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 text-sm">
      <h2 className="font-semibold text-ink-900">Check a PDF</h2>
      <p className="text-ink-600">Choose the signed PDF you received. It is checked on your device; only its fingerprint is sent.</p>
      <input type="file" accept="application/pdf" disabled={busy} onChange={(e) => void check(e.target.files?.[0])} data-testid="verify-file" />
      {result ? <Alert tone={result.tone}>{result.text}</Alert> : null}
    </Card>
  );
}
