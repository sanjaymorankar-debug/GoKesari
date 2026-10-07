"use client";

/** F7 — admin list and editor for order-level coupon codes. */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, EmptyState, Field, Money, inputClass } from "@/components/ui";

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  discountType: "FLAT" | "PERCENT";
  flatPaise: number | null;
  percent: number | null;
  maxDiscountPaise: number | null;
  minOrderPaise: number;
  startsAt: string | null;
  expiresAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  active: boolean;
  uses: number;
}

const rupees = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const intOrNull = (v: string) => (v.trim() === "" ? null : Number(v));
const date = (v: string) => (v ? new Date(`${v}T00:00:00+05:30`).toISOString() : null);

export function CouponAdmin({ rows, enabled }: { rows: CouponRow[]; enabled: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({
    code: "",
    description: "",
    discountType: "FLAT" as "FLAT" | "PERCENT",
    amount: "",
    maxDiscount: "",
    minOrder: "",
    startsOn: "",
    expiresOn: "",
    usageLimit: "",
    perCustomerLimit: "1",
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
      setError(payload?.error?.message ?? "Could not save.");
      return false;
    }
    router.refresh();
    return true;
  }

  async function create() {
    const ok = await send("/api/admin/coupons", "POST", {
      code: form.code,
      description: form.description || null,
      discountType: form.discountType,
      flatPaise: form.discountType === "FLAT" ? rupees(form.amount) : null,
      percent: form.discountType === "PERCENT" ? intOrNull(form.amount) : null,
      maxDiscountPaise: form.discountType === "PERCENT" ? rupees(form.maxDiscount) : null,
      minOrderPaise: rupees(form.minOrder) ?? 0,
      startsAt: date(form.startsOn),
      expiresAt: date(form.expiresOn),
      usageLimit: intOrNull(form.usageLimit),
      perCustomerLimit: intOrNull(form.perCustomerLimit),
    });
    if (ok) setForm((f) => ({ ...f, code: "", description: "", amount: "" }));
  }

  function toggle(row: CouponRow) {
    void send(`/api/admin/coupons/${row.id}`, "PUT", { ...row, active: !row.active });
  }

  return (
    <div className="space-y-4">
      {!enabled ? (
        <Alert tone="warning">Coupons are switched off (Business rules → coupons). Customers can&apos;t use these codes yet.</Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="space-y-3 p-4">
        <h2 className="font-semibold text-ink-900">New coupon</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code">
            <input className={inputClass} value={form.code} onChange={set("code")} placeholder="WELCOME50" />
          </Field>
          <Field label="Description (shown to customers)">
            <input className={inputClass} value={form.description} onChange={set("description")} />
          </Field>
          <Field label="Type">
            <select className={inputClass} value={form.discountType} onChange={set("discountType")}>
              <option value="FLAT">Flat amount off (₹)</option>
              <option value="PERCENT">Percentage off (%)</option>
            </select>
          </Field>
          <Field label={form.discountType === "FLAT" ? "Amount off (₹)" : "Percent off"}>
            <input className={inputClass} type="number" min={0} value={form.amount} onChange={set("amount")} />
          </Field>
          {form.discountType === "PERCENT" ? (
            <Field label="Maximum discount (₹)" hint="Empty = no cap">
              <input className={inputClass} type="number" min={0} value={form.maxDiscount} onChange={set("maxDiscount")} />
            </Field>
          ) : null}
          <Field label="Minimum order (₹)">
            <input className={inputClass} type="number" min={0} value={form.minOrder} onChange={set("minOrder")} />
          </Field>
          <Field label="Starts on" hint="Empty = now">
            <input className={inputClass} type="date" value={form.startsOn} onChange={set("startsOn")} />
          </Field>
          <Field label="Expires on" hint="Empty = never; ends at the start of this day">
            <input className={inputClass} type="date" value={form.expiresOn} onChange={set("expiresOn")} />
          </Field>
          <Field label="Total uses" hint="Empty = unlimited">
            <input className={inputClass} type="number" min={1} value={form.usageLimit} onChange={set("usageLimit")} />
          </Field>
          <Field label="Uses per customer" hint="Empty = unlimited">
            <input className={inputClass} type="number" min={1} value={form.perCustomerLimit} onChange={set("perCustomerLimit")} />
          </Field>
        </div>
        <Button onClick={() => void create()} disabled={busy || !form.code || !form.amount}>
          Create coupon
        </Button>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="No coupons yet." />
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="coupon-row">
              <div>
                <p className="font-semibold text-ink-900">
                  {r.code} {r.active ? <Badge tone="success">active</Badge> : <Badge tone="neutral">off</Badge>}
                </p>
                <p className="text-sm text-ink-600">
                  {r.discountType === "FLAT" ? <Money paise={r.flatPaise ?? 0} /> : `${r.percent}%`} off
                  {r.maxDiscountPaise ? <> (up to <Money paise={r.maxDiscountPaise} />)</> : null}
                  {r.minOrderPaise > 0 ? <> · min <Money paise={r.minOrderPaise} /></> : null}
                  {r.expiresAt ? ` · until ${new Date(r.expiresAt).toLocaleDateString("en-IN")}` : ""}
                </p>
                <p className="text-xs text-ink-500">
                  Used {r.uses}
                  {r.usageLimit ? ` of ${r.usageLimit}` : ""} · {r.perCustomerLimit ? `${r.perCustomerLimit} per customer` : "no per-customer limit"}
                </p>
              </div>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => toggle(r)}>
                {r.active ? "Switch off" : "Switch on"}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
