"use client";

/**
 * Product browser results (batch-2026-10 WS-D, F9.1.4): select rows, then
 * Promote (single or bulk), Bulk edit (audited) or Compare two side by side.
 * Buttons only — nothing depends on hover, so it works on phones and in the app.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, inputClass } from "@/components/ui";

export interface BrowserRowView {
  masterProductId: string;
  productName: string;
  brand: string | null;
  gtin: string | null;
  packSize: string | null;
  categoryCode: string | null;
  hsnCode: string | null;
  gstRateBp: number | null;
  quality: number | null;
  scope: "STAGING" | "MASTER";
  mrpPaise: number | null;
  sources: string[];
  attributions: string[];
  storedImages: number;
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong.");
  return data;
}

export function ProductBrowserTable({ rows, canPromote, canEdit, canEditMrp }: { rows: BrowserRowView[]; canPromote: boolean; canEdit: boolean; canEditMrp: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState({ categoryCode: "", hsnCode: "", gstPercent: "", brandName: "", mrp: "", reason: "" });

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await fn() });
      setSelected([]);
      router.refresh();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  };

  const promote = (ids: string[]) =>
    run(async () => {
      const r = await post("/api/pmd/browser/promote", { masterProductIds: ids });
      return `Promoted ${r.promoted}, linked to an existing catalogue product ${r.adopted}, refused ${r.refused}.${r.refused ? ` ${r.outcomes.filter((o: { ok: boolean }) => !o.ok).map((o: { message: string }) => o.message).join(" ")}` : ""}`;
    });

  const bulkEdit = () =>
    run(async () => {
      const set: Record<string, unknown> = {};
      if (edit.categoryCode.trim()) set.categoryCode = edit.categoryCode.trim();
      if (edit.hsnCode.trim()) set.hsnCode = edit.hsnCode.trim();
      if (edit.gstPercent.trim()) set.gstRateBp = Math.round(Number(edit.gstPercent) * 100);
      if (edit.brandName.trim()) set.brandName = edit.brandName.trim();
      if (edit.mrp.trim()) set.mrpPaise = Math.round(Number(edit.mrp) * 100);
      const r = await post("/api/pmd/browser/bulk-edit", { masterProductIds: selected, set, reason: edit.reason || null });
      return `Updated ${r.updated}${r.mrpUpdated ? `, MRP set on ${r.mrpUpdated}` : ""}${r.skipped.length ? `; skipped ${r.skipped.length}` : ""}.`;
    });

  return (
    <div className="space-y-3">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-cream-200 bg-white p-2 text-sm" data-testid="browser-actions">
        <span className="font-semibold">{selected.length} selected</span>
        {canPromote ? (
          <Button size="sm" disabled={busy || selected.length === 0} onClick={() => void promote(selected)}>
            Promote selected
          </Button>
        ) : null}
        {selected.length === 2 ? (
          <Link className="min-h-10 rounded-lg border border-cream-200 px-3 py-2 font-medium" href={`/admin/product-browser/duplicates?a=${selected[0]}&b=${selected[1]}`}>
            Compare side by side
          </Link>
        ) : null}
      </div>
      {canEdit && selected.length > 0 ? (
        <div className="grid gap-2 rounded-xl border border-cream-200 bg-white p-3 sm:grid-cols-3" data-testid="bulk-edit">
          <input className={inputClass} placeholder="Category code (e.g. dairy/butter)" value={edit.categoryCode} onChange={(e) => setEdit({ ...edit, categoryCode: e.target.value })} />
          <input className={inputClass} placeholder="HSN (4/6/8 digits)" value={edit.hsnCode} onChange={(e) => setEdit({ ...edit, hsnCode: e.target.value })} />
          <input className={inputClass} placeholder="GST %" inputMode="decimal" value={edit.gstPercent} onChange={(e) => setEdit({ ...edit, gstPercent: e.target.value })} />
          <input className={inputClass} placeholder="Brand" value={edit.brandName} onChange={(e) => setEdit({ ...edit, brandName: e.target.value })} />
          {canEditMrp ? <input className={inputClass} placeholder="MRP ₹ (catalogue products)" inputMode="decimal" value={edit.mrp} onChange={(e) => setEdit({ ...edit, mrp: e.target.value })} /> : null}
          <input className={inputClass} placeholder="Reason (audit log)" value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
          <div className="sm:col-span-3">
            <Button size="sm" disabled={busy} onClick={() => void bulkEdit()}>Apply to {selected.length} product(s)</Button>
          </div>
        </div>
      ) : null}
      <ul className="space-y-2" data-testid="browser-rows">
        {rows.map((r) => (
          <li key={r.masterProductId} className="rounded-xl border border-cream-200 bg-white p-3">
            <label className="flex min-h-11 items-start gap-3">
              <input type="checkbox" className="mt-1 h-5 w-5" checked={selected.includes(r.masterProductId)} onChange={() => toggle(r.masterProductId)} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink-900">{r.productName}</span>
                  <Badge tone={r.scope === "MASTER" ? "success" : "info"}>{r.scope === "MASTER" ? "Master" : "Staging"}</Badge>
                  {r.quality != null ? <Badge>{`Q ${Math.round(r.quality)}`}</Badge> : null}
                </span>
                <span className="block text-xs text-ink-500">
                  {r.masterProductId} · {r.brand ?? "no brand"} · GTIN {r.gtin ?? "—"} · {r.packSize ?? "—"} · {r.categoryCode ?? "uncategorised"} · HSN {r.hsnCode ?? "—"}
                  {r.gstRateBp != null ? ` · GST ${r.gstRateBp / 100}%` : ""}
                  {r.mrpPaise != null ? ` · MRP ₹${(r.mrpPaise / 100).toFixed(2)}` : ""}
                  {r.storedImages ? ` · ${r.storedImages} image(s) stored` : ""}
                </span>
                <span className="block text-xs text-ink-500">Sources: {r.sources.join(", ") || "—"}</span>
                {r.attributions.map((a) => (
                  <span key={a} className="block text-xs italic text-ink-600" data-testid="attribution">{a}</span>
                ))}
              </span>
            </label>
            {canPromote && r.scope === "STAGING" ? (
              <div className="mt-1 pl-8">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void promote([r.masterProductId])}>Promote</Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
