"use client";

/** F11 — a customer's referral code and link, and the box to apply a friend's code. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function ReferralShare({ code, link, rewardText }: { code: string; link: string; rewardText: string }) {
  const [copied, setCopied] = useState(false);
  const message = `Join me on GoKesari — local shops delivering to your door. Use my code ${code}: ${link}`;
  return (
    <Card className="space-y-3 p-4">
      <p className="text-sm text-ink-600">{rewardText}</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-lg border border-dashed border-kesari-400 bg-kesari-50 px-4 py-2 font-mono text-lg font-semibold tracking-wider text-kesari-800" data-testid="my-referral-code">
          {code}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "Link copied" : "Copy link"}
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-kesari-700 hover:underline"
        >
          Share on WhatsApp
        </a>
      </div>
      <p className="break-all text-xs text-ink-500">{link}</p>
    </Card>
  );
}

export function ApplyReferralCode({ initialCode }: { initialCode: string }) {
  const router = useRouter();
  const [code, setCode] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/customer-referrals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return setError(body?.error?.message ?? "That code couldn't be applied.");
    }
    router.refresh();
  }

  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-semibold text-ink-900">Were you invited by a friend?</h2>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="flex gap-2">
        <Field label="Friend's referral code">
          <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} data-testid="apply-referral-code" />
        </Field>
        <div className="self-end">
          <Button onClick={() => void apply()} disabled={busy || code.trim().length < 4}>
            Apply
          </Button>
        </div>
      </div>
    </Card>
  );
}
