"use client";

/** Side-by-side duplicate: choose which record survives, then merge (batch-2026-10 WS-D, F9.1.4). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

const FIELDS: [string, string][] = [
  ["master_product_id", "Id"],
  ["product_name", "Name"],
  ["brand_name", "Brand"],
  ["gtin", "GTIN"],
  ["pack_size", "Pack"],
  ["variant_name", "Variant"],
  ["category_code", "Category"],
  ["hsn_code", "HSN"],
  ["gst_rate_bp", "GST (bp)"],
  ["data_quality_score", "Quality"],
  ["sources", "Sources"],
  ["in_catalogue", "In catalogue"],
];

export function MergePair({ left, right, meta }: { left: Record<string, unknown>; right: Record<string, unknown>; meta?: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge(into: Record<string, unknown>, from: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/pmd/browser/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromMasterId: from.master_product_id, intoMasterId: into.master_product_id, reason: reason || null }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Could not merge.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2 rounded-xl border border-cream-200 bg-white p-3" data-testid="merge-pair">
      {meta ? <p className="text-xs font-semibold text-ink-600">{meta}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead>
            <tr className="text-xs text-ink-500">
              <th className="py-1 pr-2">Field</th>
              <th className="py-1 pr-2">A</th>
              <th className="py-1">B</th>
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(([key, label]) => {
              const a = String(left[key] ?? "—");
              const b = String(right[key] ?? "—");
              return (
                <tr key={key} className={a !== b ? "bg-amber-50" : undefined}>
                  <td className="py-1 pr-2 text-xs text-ink-500">{label}</td>
                  <td className="py-1 pr-2">{a}</td>
                  <td className="py-1">{b}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <input className={inputClass} placeholder="Reason (merge log)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void merge(left, right)}>Keep A, merge B into it</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void merge(right, left)}>Keep B, merge A into it</Button>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
