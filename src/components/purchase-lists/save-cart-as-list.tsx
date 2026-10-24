"use client";

import Link from "next/link";
import { useState } from "react";

import { Choice } from "@/components/purchase-lists/create-list-form";
import { Button, Card, Field, inputClass } from "@/components/ui";
import { FREQUENCY_LABEL, KIND_EMOJI, KIND_LABEL, LIST_LIMITS, type ListFrequency, type ListKind } from "@/lib/purchase-lists";

/**
 * "Save as a list" on the cart (docs/purchase-lists-2026-10): what is in the
 * cart becomes a weekly / monthly list — a new one, or one the customer
 * already has (a product already on it takes the cart's quantity).
 */
export function SaveCartAsList({ lists }: { lists: { id: string; name: string; kind: ListKind }[] }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>("new");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ListKind>("SHOPPING");
  const [frequency, setFrequency] = useState<ListFrequency>("MONTHLY");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/purchase-lists/from-cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target === "new" ? { name, kind, frequency } : { listId: target }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not save the list.");
        return;
      }
      setSaved({ id: payload.id, name: payload.name });
      setOpen(false);
    } catch {
      setError("Could not save the list. Check your connection.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4" data-testid="save-cart-as-list">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span aria-hidden>📝</span> Save as a list
        </Button>
        <span className="text-xs text-ink-500">Buy these every week or month? Save them and reorder in a few taps.</span>
      </div>
      {saved ? (
        <p className="mt-2 text-sm text-leaf-700" role="status">
          Saved to &quot;{saved.name}&quot;.{" "}
          <Link href={`/lists/${saved.id}`} className="font-medium underline">
            Open the list
          </Link>
        </p>
      ) : null}
      {open ? (
        <Card className="mt-2 p-4">
          <form onSubmit={save} className="space-y-4">
            {lists.length > 0 ? (
              <Field label="Save to">
                <select className={inputClass} value={target} onChange={(e) => setTarget(e.target.value)} name="save-target">
                  <option value="new">A new list</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {KIND_EMOJI[list.kind]} {list.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {target === "new" ? (
              <>
                <Choice
                  label="What is it for?"
                  name="save-kind"
                  value={kind}
                  onChange={setKind}
                  options={(["SHOPPING", "MEDICINE"] as const).map((k) => ({ value: k, label: `${KIND_EMOJI[k]} ${KIND_LABEL[k]}` }))}
                />
                <Field label="List name">
                  <input
                    className={inputClass}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={LIST_LIMITS.nameLength}
                    placeholder={kind === "MEDICINE" ? "Monthly medicines" : "Monthly groceries"}
                    required
                    name="save-name"
                  />
                </Field>
                <Choice
                  label="How often?"
                  name="save-frequency"
                  value={frequency}
                  onChange={setFrequency}
                  options={(["WEEKLY", "MONTHLY"] as const).map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
                />
              </>
            ) : (
              <p className="text-xs text-ink-500">Products already on that list take the quantity in your cart.</p>
            )}
            {error ? (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy || (target === "new" && !name.trim())}>
              {busy ? "Saving…" : "Save list"}
            </Button>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
