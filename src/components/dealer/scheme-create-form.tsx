"use client";

/** docs/dealer-platform phase 4: create a scheme from blank terms, or clone any version of another scheme. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, Card, Field, inputClass } from "@/components/ui";

export function SchemeCreateForm({ versions }: { versions: { id: string; label: string }[] }) {
  const router = useRouter();
  const [form, setForm] = useState({ code: "", name: "", category: "DEALERSHIP", cloneFromVersionId: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/dealer-schemes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, cloneFromVersionId: form.cloneFromVersionId || null }) });
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error?.message ?? "Could not create the scheme.");
      router.push(`/admin/dealers/schemes/${payload.scheme.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the scheme.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4" data-testid="scheme-create">
      <h2 className="text-lg font-semibold text-ink-900">Create a new scheme</h2>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Code (e.g. SILVER_PARTNER)">
          <input className={inputClass} value={form.code} maxLength={40} onChange={set("code")} />
        </Field>
        <Field label="Name">
          <input className={inputClass} value={form.name} maxLength={80} onChange={set("name")} />
        </Field>
        <Field label="Category">
          <select className={inputClass} value={form.category} onChange={set("category")}>
            <option value="DEALERSHIP">Dealership</option>
            <option value="FRANCHISE">Franchise</option>
          </select>
        </Field>
        <Field label="Start from">
          <select className={inputClass} value={form.cloneFromVersionId} onChange={set("cloneFromVersionId")}>
            <option value="">Blank terms</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                Copy of {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason (audit log)">
          <input className={inputClass} value={form.reason} maxLength={500} onChange={set("reason")} />
        </Field>
      </div>
      <Button disabled={busy || form.reason.trim().length < 5 || form.code.length < 2 || form.name.length < 3} onClick={create}>
        {busy ? "Creating…" : "Create scheme"}
      </Button>
    </Card>
  );
}
