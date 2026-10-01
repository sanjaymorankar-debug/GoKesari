"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  shopCount: number;
}
export interface UncategorisedShop {
  id: string;
  name: string;
  city: string;
  status: string;
  ownerName: string;
}

/** Operations view: create / rename / activate categories, see who uses each, and complete uncategorised shops. */
export function ShopCategoriesAdmin({ categories, uncategorised }: { categories: CategoryRow[]; uncategorised: UncategorisedShop[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "" });
  const [open, setOpen] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, { id: string; name: string; city: string; status: string }[]>>({});

  async function call(url: string, method: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function toggleShops(id: string) {
    if (open === id) return setOpen(null);
    setOpen(id);
    if (!members[id]) {
      const res = await fetch(`/api/shop-categories/${id}`);
      const payload = await res.json().catch(() => null);
      if (res.ok) setMembers((m) => ({ ...m, [id]: payload.shops }));
    }
  }

  return (
    <div className="space-y-8">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {uncategorised.length > 0 ? (
        <section data-testid="uncategorised">
          <h2 className="mb-2 text-lg font-semibold text-ink-900">Shops with no category ({uncategorised.length})</h2>
          <Card className="divide-y divide-cream-100">
            {uncategorised.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  {s.name} <span className="text-ink-500">· {s.ownerName} · {s.city}</span> <Badge>{s.status.replace(/_/g, " ").toLowerCase()}</Badge>
                </span>
                <Link href={`/admin/shops/${s.id}/categories`} className="font-medium text-kesari-700 underline">
                  Assign categories
                </Link>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Add a category</h2>
        <Card className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <input className={inputClass} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Description (optional)">
              <input className={inputClass} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
          <Button
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              if (await call("/api/shop-categories", "POST", { name, description: description || null })) {
                setName("");
                setDescription("");
              }
            }}
          >
            Add category
          </Button>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">All categories ({categories.length})</h2>
        <Card className="divide-y divide-cream-100">
          {categories.map((c) => (
            <div key={c.id} className="space-y-2 p-3 text-sm" data-testid="category-row">
              {editing === c.id ? (
                <div className="flex flex-wrap gap-2">
                  <input className={`${inputClass} min-w-0 flex-1`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Category name" />
                  <input className={`${inputClass} min-w-0 flex-1`} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Description" />
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={async () => {
                      if (await call(`/api/shop-categories/${c.id}`, "PATCH", { name: draft.name, description: draft.description || null })) setEditing(null);
                    }}
                  >
                    Save
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <span className="font-medium text-ink-900">{c.name}</span>{" "}
                    <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status.toLowerCase()}</Badge>
                    {c.description ? <span className="ml-2 text-ink-500">{c.description}</span> : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <button type="button" className="text-sm text-kesari-700 underline" onClick={() => toggleShops(c.id)}>
                      {c.shopCount} shop{c.shopCount === 1 ? "" : "s"}
                    </button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setEditing(c.id);
                        setDraft({ name: c.name, description: c.description ?? "" });
                      }}
                    >
                      Rename / edit
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => call(`/api/shop-categories/${c.id}`, "PATCH", { status: c.status === "ACTIVE" ? "INACTIVE" : "ACTIVE" })}
                    >
                      {c.status === "ACTIVE" ? "Deactivate" : "Activate"}
                    </Button>
                  </span>
                </div>
              )}
              {open === c.id ? (
                <ul className="rounded-lg bg-cream-50 p-2 text-xs text-ink-600">
                  {(members[c.id] ?? []).length === 0 ? <li>No shops use this category.</li> : null}
                  {(members[c.id] ?? []).map((s) => (
                    <li key={s.id} className="flex justify-between gap-2 py-0.5">
                      <span>
                        {s.name} · {s.city} · {s.status.replace(/_/g, " ").toLowerCase()}
                      </span>
                      <Link href={`/admin/shops/${s.id}/categories`} className="text-kesari-700 underline">
                        Edit shop categories
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
