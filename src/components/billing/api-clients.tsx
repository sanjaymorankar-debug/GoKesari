"use client";

/** Billing v2 (docs/billing §8): the shop's public-API clients — create (secret shown once), revoke. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, inputClass } from "@/components/ui";

const SCOPES = [
  ["books:read", "Read the books"],
  ["books:write", "Add vouchers and masters"],
  ["invoices:read", "Read invoices"],
  ["stock:read", "Read stock"],
  ["stock:write", "Update items' HSN / GST / price"],
  ["parties:read", "Read parties"],
] as const;

interface Client {
  id: string;
  name: string;
  clientId: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ApiClients({ shopId, clients }: { shopId: string; clients: Client[] }) {
  const router = useRouter();
  const api = `/api/shops/${shopId}/accounts/api-clients`;
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["books:read"]);
  const [created, setCreated] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card className="grid gap-2 p-3" data-testid="api-clients">
      <p className="font-bold text-ink-900">API access for other software</p>
      <p className="text-xs text-ink-600">
        OAuth2 client credentials. Description: <a className="underline" href="/api/public/v1/openapi.json">/api/public/v1/openapi.json</a>
      </p>
      {created ? (
        <Alert tone="success" title="Copy the secret now — it is not shown again">
          <code className="block break-all">client_id: {created.clientId}</code>
          <code className="block break-all">client_secret: {created.clientSecret}</code>
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <ul className="grid gap-1 text-sm">
        {clients.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2">
            <span className={c.revokedAt ? "line-through" : ""}>
              {c.name} · {c.clientId} · {c.scopes.join(", ")}
            </span>
            {!c.revokedAt ? (
              <Button size="sm" variant="ghost" onClick={async () => (await fetch(`${api}/${c.id}`, { method: "DELETE" })).ok && router.refresh()}>
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input aria-label="Software name" placeholder="Software name" className={`${inputClass} h-9 w-48`} value={name} onChange={(e) => setName(e.target.value)} />
        {SCOPES.map(([s, label]) => (
          <label key={s} className="flex items-center gap-1 text-xs" title={label}>
            <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {s}
          </label>
        ))}
        <Button
          size="sm"
          disabled={name.trim().length < 2 || !scopes.length}
          onClick={async () => {
            setError(null);
            const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, scopes }) });
            const body = await res.json().catch(() => null);
            if (!res.ok) return setError(body?.error?.message ?? "Not created.");
            setCreated((body?.data ?? body) as { clientId: string; clientSecret: string });
            setName("");
            router.refresh();
          }}
        >
          Create client
        </Button>
      </div>
    </Card>
  );
}
