"use client";

/** F8 — a shop owner's offers: create, and switch on/off. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, inputClass } from "@/components/ui";

export interface ShopOfferRow {
  id: string;
  title: string;
  targetType: "PRODUCT" | "CATEGORY";
  shopProductId: string | null;
  categoryId: string | null;
  targetName: string;
  discountType: "PERCENT" | "FLAT";
  percent: number | null;
  flatPaise: number | null;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const istStart = (d: string) => new Date(`${d}T00:00:00+05:30`).toISOString();
const istEnd = (d: string) => new Date(`${d}T23:59:59+05:30`).toISOString();

export function ShopOffersManager({
  shopId,
  rows,
  products,
  categories,
  enabled,
}: {
  shopId: string;
  rows: ShopOfferRow[];
  products: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState({
    title: "",
    targetType: "PRODUCT" as "PRODUCT" | "CATEGORY",
    shopProductId: products[0]?.id ?? "",
    categoryId: categories[0]?.id ?? "",
    discountType: "PERCENT" as "PERCENT" | "FLAT",
    amount: "",
    from: today(),
    until: today(),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function send(url: string, method: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      setError(payload?.error?.message ?? "Could not save the offer.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function create() {
    const amount = Number(form.amount);
    const ok = await send(`/api/shops/${shopId}/offers`, "POST", {
      title: form.title,
      targetType: form.targetType,
      shopProductId: form.targetType === "PRODUCT" ? form.shopProductId : null,
      categoryId: form.targetType === "CATEGORY" ? form.categoryId : null,
      discountType: form.discountType,
      percent: form.discountType === "PERCENT" ? amount : null,
      flatPaise: form.discountType === "FLAT" ? Math.round(amount * 100) : null,
      startsAt: istStart(form.from),
      endsAt: istEnd(form.until),
    });
    if (ok) setForm((f) => ({ ...f, title: "", amount: "" }));
  }

  return (
    <div className="space-y-4">
      {!enabled ? (
        <Alert tone="info">Offers are not live on GoKesari yet. You can prepare them now; they show once switched on.</Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card id="new-offer" className="scroll-mt-20 space-y-3 p-4">
        <h2 className="font-semibold text-ink-900">New offer</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Title (shown on your shop page)">
            <input className={inputClass} value={form.title} onChange={set("title")} placeholder="Weekend milk offer" />
          </Field>
          <Field label="Applies to">
            <select className={inputClass} value={form.targetType} onChange={set("targetType")}>
              <option value="PRODUCT">One product</option>
              <option value="CATEGORY">A whole category</option>
            </select>
          </Field>
          {form.targetType === "PRODUCT" ? (
            <Field label="Product">
              <select className={inputClass} value={form.shopProductId} onChange={set("shopProductId")}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Category">
              <select className={inputClass} value={form.categoryId} onChange={set("categoryId")}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Discount">
            <div className="flex gap-2">
              <select className={inputClass} value={form.discountType} onChange={set("discountType")}>
                <option value="PERCENT">% off</option>
                <option value="FLAT">₹ off each</option>
              </select>
              <input className={inputClass} type="number" min={1} value={form.amount} onChange={set("amount")} />
            </div>
          </Field>
          <Field label="From">
            <input className={inputClass} type="date" value={form.from} onChange={set("from")} />
          </Field>
          <Field label="Until (inclusive)">
            <input className={inputClass} type="date" value={form.until} onChange={set("until")} />
          </Field>
        </div>
        <Button onClick={() => void create()} disabled={busy || !form.title || !form.amount}>
          Create offer
        </Button>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No offers yet." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const ended = new Date(r.endsAt) <= new Date();
            return (
              <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="shop-offer-row">
                <div>
                  <p className="font-semibold text-ink-900">
                    {r.title}{" "}
                    {ended ? <Badge tone="neutral">ended</Badge> : r.active ? <Badge tone="success">on</Badge> : <Badge tone="neutral">off</Badge>}
                  </p>
                  <p className="text-sm text-ink-600">
                    {r.discountType === "PERCENT" ? `${r.percent}% off` : `₹${((r.flatPaise ?? 0) / 100).toFixed(0)} off each`} ·{" "}
                    {r.targetType === "CATEGORY" ? `all ${r.targetName}` : r.targetName}
                  </p>
                  <p className="text-xs text-ink-500">
                    {new Date(r.startsAt).toLocaleDateString("en-IN")} – {new Date(r.endsAt).toLocaleDateString("en-IN")}
                  </p>
                </div>
                {!ended ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void send(`/api/shops/${shopId}/offers/${r.id}`, "PUT", { ...r, active: !r.active })}
                  >
                    {r.active ? "Switch off" : "Switch on"}
                  </Button>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
