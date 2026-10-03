"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Field, inputClass } from "@/components/ui";

/** Admin: free a mobile number that another account claimed (numbers are not SMS-verified). */
export function ReleaseMobileForm() {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/users/release-phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mobile, reason }),
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) return setResult({ tone: "danger", text: payload?.error?.message ?? "Could not release the number." });
    setResult({ tone: "success", text: `Released from ${payload.email}. The real owner can now add it to their account.` });
    setMobile("");
    setReason("");
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end" data-testid="release-mobile">
      <Field label="Mobile number">
        <input
          className={inputClass}
          value={mobile}
          onChange={(e) => setMobile(e.target.value.replace(/\D/g, "").slice(0, 10))}
          inputMode="numeric"
          placeholder="10 digits"
          required
        />
      </Field>
      <Field label="Reason">
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. owner proved the number is theirs" required />
      </Field>
      <Button type="submit" disabled={busy}>
        {busy ? "Releasing…" : "Release number"}
      </Button>
      {result ? (
        <div className="sm:col-span-3">
          <Alert tone={result.tone}>{result.text}</Alert>
        </div>
      ) : null}
    </form>
  );
}
