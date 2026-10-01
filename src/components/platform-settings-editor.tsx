"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card } from "@/components/ui";

export interface RuleView {
  key: string;
  description: string;
  defaults: unknown;
  value: unknown;
  overridden: boolean;
}

/**
 * Admin editor for the business rules (OTP limits, rider matching, earnings, returns,
 * suspension policy, images, notifications, MRP, reference-price visibility).
 * Values are edited as JSON, checked by the server against each rule's schema, and
 * every change is audited. "Restore default" removes the override.
 */
export function PlatformSettingsEditor({ rules }: { rules: RuleView[] }) {
  return (
    <div className="space-y-4">
      {rules.map((rule) => (
        <RuleCard key={rule.key} rule={rule} />
      ))}
    </div>
  );
}

function RuleCard({ rule }: { rule: RuleView }) {
  const router = useRouter();
  const pretty = (v: unknown) => JSON.stringify(v, null, 2);
  const [text, setText] = useState(pretty(rule.value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function call(method: "PUT" | "DELETE") {
    setError(null);
    setSaved(false);
    let body: unknown;
    if (method === "PUT") {
      try {
        body = { key: rule.key, value: JSON.parse(text) };
      } catch {
        setError("That is not valid JSON.");
        return;
      }
    }
    setBusy(true);
    const res = await fetch(method === "PUT" ? "/api/admin/settings" : `/api/admin/settings?key=${encodeURIComponent(rule.key)}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "PUT" ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      const fields = payload?.error?.details?.fields as Record<string, string> | undefined;
      setError(fields ? Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("; ") : (payload?.error?.message ?? "That did not work."));
      return;
    }
    setSaved(true);
    if (method === "DELETE") setText(pretty(rule.defaults));
    router.refresh();
  }

  return (
    <Card className="space-y-2 p-4" data-testid="setting-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink-900">
          {rule.key} {rule.overridden ? <Badge tone="warning">customised</Badge> : <Badge>default</Badge>}
        </p>
      </div>
      <p className="text-sm text-ink-500">{rule.description}</p>
      <textarea
        className="h-44 w-full rounded-lg border border-cream-200 p-2 font-mono text-xs"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${rule.key} settings (JSON)`}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {saved ? <Alert tone="success">Saved.</Alert> : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => call("PUT")}>
          Save
        </Button>
        <Button size="sm" variant="secondary" disabled={busy || !rule.overridden} onClick={() => call("DELETE")}>
          Restore default
        </Button>
      </div>
    </Card>
  );
}
