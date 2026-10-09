"use client";

/** Module 1: the owner chooses who may edit the shop's product photos and descriptions. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

interface Member {
  id: string;
  name: string | null;
  contact: string;
  status: "ACTIVE" | "REVOKED";
  addedAt: string;
  revokedAt: string | null;
}

export function ShopStaffManager({ shopId, staff }: { shopId: string; staff: Member[] }) {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/shops/${shopId}/staff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier }),
    });
    const body = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(body?.error?.message ?? "Could not add this person.");
      return;
    }
    setIdentifier("");
    setNotice(`${body?.name ?? "They"} can now edit your product photos and descriptions.`);
    router.refresh();
  }

  async function remove(member: Member) {
    if (!window.confirm(`Remove ${member.name ?? member.contact}? They will no longer be able to edit your products.`)) return;
    setBusy(true);
    const res = await fetch(`/api/shops/${shopId}/staff/${member.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not remove this person.");
      return;
    }
    router.refresh();
  }

  const active = staff.filter((m) => m.status === "ACTIVE");
  const past = staff.filter((m) => m.status === "REVOKED");

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Card className="p-4">
        <form onSubmit={add} className="space-y-3">
          <Field label="Mobile number or email" hint="They must have signed in to GoKesari once with it. Staff can only change product photos and descriptions.">
            <input
              className={inputClass}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="98765 43210 or name@example.com"
              inputMode="email"
              autoComplete="off"
              required
            />
          </Field>
          <Button type="submit" disabled={busy || identifier.trim().length < 5}>
            Add staff
          </Button>
        </form>
      </Card>
      <Card className="divide-y divide-cream-100">
        {active.length === 0 ? <p className="p-4 text-sm text-ink-500">No staff yet.</p> : null}
        {active.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2 p-4 text-sm">
            <div>
              <p className="font-medium text-ink-900">{m.name ?? "—"}</p>
              <p className="text-xs text-ink-500">
                {m.contact} · added {new Date(m.addedAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}
              </p>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(m)}>
              Remove
            </Button>
          </div>
        ))}
      </Card>
      {past.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-600">Former staff ({past.length})</summary>
          <ul className="mt-2 space-y-1">
            {past.map((m) => (
              <li key={m.id} className="text-ink-500">
                {m.name ?? m.contact} <Badge>removed {m.revokedAt ? new Date(m.revokedAt).toLocaleDateString("en-IN") : ""}</Badge>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
