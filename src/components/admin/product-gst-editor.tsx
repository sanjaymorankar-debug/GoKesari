"use client";

/** Admin editor for master products' own HSN code and GST rate (/admin/product-gst). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";
import { formatQuantity } from "@/lib/money";

interface Row {
  id: string;
  name: string;
  unit: string;
  unitSizeMilli: number;
  barcode: string | null;
  hsnCode: string | null;
  gstRateBp: number | null;
  shopOverrides: number;
  effective: { source: "PRODUCT" | "HSN" | "DEFAULT"; rateBp: number };
}

const SOURCE: Record<Row["effective"]["source"], { label: string; tone: "success" | "info" | "warning" }> = {
  PRODUCT: { label: "Product's own rate", tone: "success" },
  HSN: { label: "HSN fallback", tone: "info" },
  DEFAULT: { label: "Default - rate not set", tone: "warning" },
};

const pct = (bp: number) => `${bp / 100}%`;

export function ProductGstEditor({ rows, standardRates }: { rows: Row[]; standardRates: number[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<{ id: string; hsnCode: string; rate: string; reason: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(row: Row) {
    if (!editing) return;
    setError(null);
    setNotice(null);
    setSaving(true);
    const res = await fetch(`/api/admin/product-gst/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hsnCode: editing.hsnCode.trim() || null,
        gstRatePercent: editing.rate.trim() === "" ? null : Number(editing.rate),
        reason: editing.reason,
      }),
    });
    setSaving(false);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const fields = data?.error?.details?.fields as Record<string, string> | undefined;
      setError(fields ? Object.values(fields).join(" ") : (data?.error?.message ?? "Could not save."));
      return;
    }
    setNotice(`${row.name}: saved.`);
    setEditing(null);
    router.refresh();
  }

  if (rows.length === 0) return <p className="text-sm text-ink-500">No products match.</p>;
  const rateNum = editing ? Number(editing.rate) : NaN;
  const unusual = editing && editing.rate.trim() !== "" && Number.isFinite(rateNum) && !standardRates.includes(rateNum);

  return (
    <div className="space-y-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {rows.map((row) => (
        <Card key={row.id} className="space-y-2 p-4" data-testid="product-gst-row">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold text-ink-900">{row.name}</p>
              <p className="text-xs text-ink-500">
                {formatQuantity(row.unitSizeMilli, row.unit)}
                {row.barcode ? ` · ${row.barcode}` : ""}
              </p>
            </div>
            {editing?.id !== row.id ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setError(null);
                  setEditing({ id: row.id, hsnCode: row.hsnCode ?? "", rate: row.gstRateBp == null ? "" : String(row.gstRateBp / 100), reason: "" });
                }}
              >
                Edit
              </Button>
            ) : null}
          </div>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-ink-500">HSN</dt><dd>{row.hsnCode ?? "-"}</dd></div>
            <div><dt className="text-xs text-ink-500">Own GST rate</dt><dd>{row.gstRateBp == null ? "Not set" : pct(row.gstRateBp)}</dd></div>
            <div>
              <dt className="text-xs text-ink-500">Invoices today use</dt>
              <dd className="space-x-1">{pct(row.effective.rateBp)} <Badge tone={SOURCE[row.effective.source].tone}>{SOURCE[row.effective.source].label}</Badge></dd>
            </div>
            <div><dt className="text-xs text-ink-500">Shops with their own rate</dt><dd>{row.shopOverrides}</dd></div>
          </dl>
          {editing?.id === row.id ? (
            <form
              className="space-y-2 border-t border-cream-200 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                void save(row);
              }}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="HSN code" hint="4, 6 or 8 digits; empty clears it">
                  <input className={inputClass} inputMode="numeric" value={editing.hsnCode} onChange={(e) => setEditing({ ...editing, hsnCode: e.target.value })} />
                </Field>
                <Field label="GST rate (%)" hint="Empty clears it: invoices then use the HSN fallback or the default">
                  <input className={inputClass} type="number" min={0} max={100} step="0.01" value={editing.rate} onChange={(e) => setEditing({ ...editing, rate: e.target.value })} />
                </Field>
              </div>
              {unusual ? <Alert tone="warning">{editing.rate}% is not one of the usual GST rates ({standardRates.join(", ")}%). Check it with the CA.</Alert> : null}
              <Field label="Reason" hint="E.g. CA advice or the notification number - kept in the audit log">
                <input className={inputClass} value={editing.reason} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} required minLength={3} maxLength={300} />
              </Field>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </form>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
