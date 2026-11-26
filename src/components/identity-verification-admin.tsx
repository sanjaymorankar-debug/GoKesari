"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";

/**
 * docs/identity-verification-2026-11: Admin → Identity verification.
 * IdentityFlagSwitch saves through PUT /api/admin/feature-flags — the same
 * setFeatureFlag as the Feature flags page, so the change is logged and audited,
 * and waits for a second admin while rbac_v2_four_eye_admin is on.
 */
export function IdentityFlagSwitch({
  flagKey,
  label,
  enabled,
  lastChange,
}: {
  flagKey: string;
  label: string;
  enabled: boolean;
  lastChange: { by: string | null; at: string | null; reason: string | null } | null;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);

  async function toggle() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/feature-flags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: flagKey, enabled: !enabled, districtCodes: null, reason }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setMessage({ tone: "danger", text: payload?.error?.message ?? "Could not save the change." });
      } else if (response.status === 202) {
        setMessage({ tone: "info", text: "Sent for a second admin's approval (Admin → Approvals)." });
        setReason("");
      } else {
        setMessage({ tone: "success", text: enabled ? "Switched off." : "Switched on." });
        setReason("");
        router.refresh();
      }
    } catch {
      setMessage({ tone: "danger", text: "Could not reach the server." });
    }
    setBusy(false);
  }

  return (
    <Card className="space-y-3 p-5" data-testid={`identity-flag-${flagKey}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-ink-900">{label}</h2>
        <Badge tone={enabled ? "success" : "warning"}>{enabled ? "On" : "Off"}</Badge>
      </div>
      <p className="text-xs text-ink-500">
        {lastChange?.at ? `Last changed ${lastChange.at} IST${lastChange.by ? ` by ${lastChange.by}` : ""}${lastChange.reason ? ` — “${lastChange.reason}”` : ""}.` : "Never changed (seeded off)."}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void toggle();
        }}
      >
        <div className="min-w-60 flex-1">
          <Field label="Reason (required)" hint="At least 5 characters; kept in the change log.">
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={inputClass} data-testid={`identity-flag-reason-${flagKey}`} />
          </Field>
        </div>
        <Button type="submit" variant={enabled ? "secondary" : "primary"} disabled={busy || reason.trim().length < 5} data-testid={`identity-flag-toggle-${flagKey}`}>
          {busy ? "Saving…" : enabled ? "Switch off" : "Switch on"}
        </Button>
      </form>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
    </Card>
  );
}

export interface IdentityReviewRow {
  id: string;
  userName: string | null;
  userEmail: string;
  subject: "CUSTOMER" | "SHOP_OWNER";
  method: string;
  maskedId: string;
  verifiedName: string | null;
  comparedName: string | null;
  nameMatchScore: number | null;
  reason: string | null;
  provider: string;
  updatedAt: string;
}

export function IdentityReviewQueue({ items }: { items: IdentityReviewRow[] }) {
  const router = useRouter();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, decision: "APPROVE" | "REJECT") {
    setBusy(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/identity-verifications/${id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note: notes[id] ?? "" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) setError(payload?.error?.message ?? "Could not save the decision.");
      else router.refresh();
    } catch {
      setError("Could not reach the server.");
    }
    setBusy(null);
  }

  if (items.length === 0) return <EmptyState title="Nothing waiting for review." />;
  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {items.map((item) => (
        <Card key={item.id} className="space-y-2 p-4" data-testid="identity-review-item">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-900">{item.userName ?? item.userEmail}</span>
            <Badge>{item.subject === "SHOP_OWNER" ? "Shop owner" : "Customer"}</Badge>
            <Badge>{item.method}</Badge>
            <span className="font-mono text-sm text-ink-700">{item.maskedId}</span>
          </div>
          <p className="text-sm text-ink-700">
            Name on document: <strong>{item.verifiedName ?? "—"}</strong> · compared with: <strong>{item.comparedName ?? "—"}</strong>
            {item.nameMatchScore !== null ? ` · score ${item.nameMatchScore}` : ""}
          </p>
          {item.reason ? <p className="text-xs text-ink-500">{item.reason}</p> : null}
          <p className="text-xs text-ink-500">
            {item.userEmail} · provider {item.provider} · {item.updatedAt}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-60 flex-1">
              <Field label="Note (required)">
                <input
                  value={notes[item.id] ?? ""}
                  onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
                  maxLength={500}
                  className={inputClass}
                  data-testid="identity-review-note"
                />
              </Field>
            </div>
            <Button type="button" disabled={busy !== null || (notes[item.id] ?? "").trim().length < 3} onClick={() => void decide(item.id, "APPROVE")} data-testid="identity-review-approve">
              Approve
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy !== null || (notes[item.id] ?? "").trim().length < 3}
              onClick={() => void decide(item.id, "REJECT")}
              data-testid="identity-review-reject"
            >
              Reject
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
