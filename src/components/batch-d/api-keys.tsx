"use client";

/** Manufacturer API keys: issue (shown once) and revoke (batch-2026-10 WS-D, F9.1.2). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, inputClass } from "@/components/ui";

interface KeyRow {
  id: string;
  label: string | null;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
}

export function ApiKeys({ keys }: { keys: KeyRow[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function issue(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/pmd/manufacturer/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: label || null }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) return setError(data?.error?.message ?? "Could not create the key.");
    setFresh(data.key);
    setLabel("");
    router.refresh();
  }

  async function revoke(id: string) {
    setError(null);
    const res = await fetch(`/api/pmd/manufacturer/keys/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      return setError(data?.error?.message ?? "Could not revoke the key.");
    }
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {fresh ? (
        <Alert tone="success" title="Copy this key now — it is shown only once">
          <code className="break-all" data-testid="new-api-key">{fresh}</code>
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <form onSubmit={issue} className="flex flex-wrap gap-2 rounded-xl border border-cream-200 bg-white p-3">
        <input className={`${inputClass} max-w-xs`} placeholder="Label (e.g. ERP export)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button type="submit">New API key</Button>
      </form>
      <ul className="space-y-2">
        {keys.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-cream-200 bg-white p-3 text-sm">
            <span>
              <span className="block font-mono">{k.prefix}…</span>
              <span className="block text-xs text-ink-500">
                {k.label ?? "no label"} · used {k.useCount} time(s){k.lastUsedAt ? `, last ${new Date(k.lastUsedAt).toLocaleString("en-IN")}` : ""}
              </span>
            </span>
            {k.revokedAt ? <Badge tone="danger">Revoked</Badge> : <Button size="sm" variant="danger" onClick={() => void revoke(k.id)}>Revoke</Button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
