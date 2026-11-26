"use client";

/**
 * docs/flows-v3/wave2.md (flag flow_f13): "Create your own product type" for any shop type. The type is usable in the
 * shop at once and goes to our team for review; a similar existing type is shown first (create anyway or use it).
 */
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";
import { PRODUCT_UNITS } from "@/lib/product-units";

export function OwnProductTypeForm({ shopId, categories }: { shopId: string; categories: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState<string>("piece");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [similar, setSimilar] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (categories.length === 0) return null;

  async function save(confirmDuplicate: boolean) {
    setBusy(true);
    setError(null);
    const response = await fetch(`/api/shops/${shopId}/product-types`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ categoryId, name: name.trim(), unit, confirmDuplicate }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (response.status === 409 && payload?.error?.details?.matches && !payload?.error?.details?.exact && !confirmDuplicate) {
      setSimilar(payload.error.message);
      return;
    }
    if (!response.ok) {
      setError(payload?.error?.message ?? "Could not create the product type.");
      return;
    }
    setSimilar(null);
    setDone(`"${name.trim()}" is ready to use in your shop and was sent to our team for review.`);
    setName("");
  }

  return (
    <div className="rounded-2xl border border-cream-200 bg-white p-4" data-testid="flows-v3-own-type">
      {!open ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Create your own product type
        </Button>
      ) : (
        <div className="space-y-3">
          {error ? <Alert tone="danger">{error}</Alert> : null}
          {done ? <Alert tone="success">{done}</Alert> : null}
          {similar ? (
            <Alert tone="warning" title="Similar types exist">
              {similar}
              <div className="mt-2">
                <Button size="sm" disabled={busy} onClick={() => save(true)}>
                  Create anyway
                </Button>
              </div>
            </Alert>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm text-ink-700">
              Category
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-ink-700">
              Type name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={inputClass} />
            </label>
            <label className="text-sm text-ink-700">
              Unit
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputClass}>
                {PRODUCT_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button size="sm" disabled={busy || name.trim().length < 2} onClick={() => save(false)}>
            Create type
          </Button>
        </div>
      )}
    </div>
  );
}
