"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Badge, Button, Card, Field, Money, inputClass } from "@/components/ui";
import { rupeesToPaise } from "@/lib/money";

export interface MrpOverview {
  summary: Record<string, number>;
  missing: { id: string; code: string; name: string }[];
  violations: {
    shopProductId: string;
    shopName: string;
    productName: string;
    productCode: string;
    mrpPaise: number | null;
    onlinePricePaise: number | null;
    offlinePricePaise: number | null;
    verification: string;
  }[];
  pending: {
    correction: { id: string; claimedMrpPaise: number; note: string | null; createdAt: string | Date };
    productName: string;
    productCode: string;
    currentMrpPaise: number | null;
    shopName: string | null;
  }[];
}

function useCall() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function call(url: string, method: string, body: unknown, done: (payload: Record<string, unknown>) => string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(payload?.error?.message ?? "That did not work.");
      return false;
    }
    setNotice(done(payload));
    router.refresh();
    return true;
  }
  return { busy, error, notice, call };
}

/** MRP governance: verification status, setting an MRP, shop prices above MRP, and shop disputes to decide. */
export function MrpGovernancePanel({ overview }: { overview: MrpOverview }) {
  const { busy, error, notice, call } = useCall();
  const [code, setCode] = useState("");
  const [mrp, setMrp] = useState("");
  const [source, setSource] = useState("ADMIN");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const s = overview.summary;

  async function setMaster(productCode: string, rupees: string, why: string) {
    const value = Number(rupees.replace(/[₹,\s]/g, ""));
    if (!Number.isFinite(value) || value < 0) return;
    await call(
      "/api/mrp",
      "POST",
      { productId: productCode, mrpPaise: rupeesToPaise(value), source, reason: why || null },
      (p) => `MRP saved${Number(p.conflicts) > 0 ? ` — ${p.conflicts} shop listing(s) now above it; their owners were told` : ""}.`,
    );
  }

  return (
    <div className="space-y-8">
      <div className="grid gap-3 sm:grid-cols-4" data-testid="mrp-summary">
        {[
          ["Verified", s.VERIFIED ?? 0],
          ["Unverified", s.UNVERIFIED ?? 0],
          ["Awaiting verification", s.PENDING_VERIFICATION ?? 0],
          ["Missing an MRP", overview.missing.length],
        ].map(([label, n]) => (
          <Card key={label as string} className="p-4">
            <p className="text-xs uppercase tracking-wide text-ink-500">{label}</p>
            <p className="text-2xl font-semibold text-ink-900">{n}</p>
          </Card>
        ))}
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Set an MRP</h2>
        <Card className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Product code (e.g. P00042)">
              <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label="MRP ₹">
              <input className={inputClass} inputMode="decimal" value={mrp} onChange={(e) => setMrp(e.target.value)} />
            </Field>
            <Field label="Source">
              <select className={inputClass} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="ADMIN">Verified by operations</option>
                <option value="GS1">GS1 record</option>
                <option value="BRAND">Brand / manufacturer</option>
                <option value="IMPORT">Bulk import (unverified)</option>
              </select>
            </Field>
            <Field label="Reason">
              <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>
          <Button disabled={busy || !code.trim() || !mrp.trim()} onClick={() => setMaster(code, mrp, reason)}>
            Save MRP
          </Button>
          <p className="text-xs text-ink-500">
            Every change is recorded with who made it and what it replaced. Shop prices are never edited automatically.
          </p>
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Corrections raised by shops ({overview.pending.length})</h2>
        {overview.pending.length === 0 ? <p className="text-sm text-ink-500">Nothing waiting.</p> : null}
        <div className="space-y-2">
          {overview.pending.map(({ correction, productName, productCode, currentMrpPaise, shopName }) => (
            <Card key={correction.id} className="space-y-2 p-4 text-sm" data-testid="mrp-correction">
              <p className="font-medium text-ink-900">
                {productCode} · {productName} <span className="text-ink-500">— {shopName ?? "a shop"}</span>
              </p>
              <p className="text-ink-600">
                Recorded MRP {currentMrpPaise != null ? <Money paise={currentMrpPaise} /> : "none"} · claimed{" "}
                <Money paise={correction.claimedMrpPaise} />
                {correction.note ? ` — “${correction.note}”` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <input
                  className={`${inputClass} min-w-0 flex-1`}
                  placeholder="Decision note (required)"
                  value={notes[correction.id] ?? ""}
                  onChange={(e) => setNotes({ ...notes, [correction.id]: e.target.value })}
                />
                <Button
                  size="sm"
                  disabled={busy || (notes[correction.id] ?? "").trim().length < 3}
                  onClick={() =>
                    call(`/api/mrp/corrections/${correction.id}`, "PATCH", { decision: "ACCEPT", note: notes[correction.id] }, () => "Correction accepted — MRP updated.")
                  }
                >
                  Accept claim
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy || (notes[correction.id] ?? "").trim().length < 3}
                  onClick={() =>
                    call(`/api/mrp/corrections/${correction.id}`, "PATCH", { decision: "REJECT", note: notes[correction.id] }, () => "Correction rejected.")
                  }
                >
                  Reject
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Shop prices above the MRP ({overview.violations.length})</h2>
        {overview.violations.length === 0 ? (
          <p className="text-sm text-ink-500">None.</p>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-cream-100 text-xs uppercase text-ink-500">
                <tr>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">Shop</th>
                  <th className="px-3 py-2">MRP</th>
                  <th className="px-3 py-2">Online</th>
                  <th className="px-3 py-2">Offline</th>
                  <th className="px-3 py-2">MRP status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-cream-200">
                {overview.violations.map((v) => (
                  <tr key={v.shopProductId}>
                    <td className="px-3 py-2">
                      {v.productCode} · {v.productName}
                    </td>
                    <td className="px-3 py-2">{v.shopName}</td>
                    <td className="px-3 py-2">{v.mrpPaise != null ? <Money paise={v.mrpPaise} /> : "—"}</td>
                    <td className="px-3 py-2">{v.onlinePricePaise != null ? <Money paise={v.onlinePricePaise} /> : "—"}</td>
                    <td className="px-3 py-2">{v.offlinePricePaise != null ? <Money paise={v.offlinePricePaise} /> : "—"}</td>
                    <td className="px-3 py-2">
                      <Badge tone={v.verification === "VERIFIED" ? "success" : "warning"}>{v.verification.replace(/_/g, " ").toLowerCase()}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">Packaged products without an MRP ({overview.missing.length})</h2>
        <Card className="divide-y divide-cream-100">
          {overview.missing.length === 0 ? <p className="p-4 text-sm text-ink-500">Every packaged product has an MRP.</p> : null}
          {overview.missing.slice(0, 25).map((p) => (
            <MissingRow key={p.id} product={p} onSave={(rupees) => setMaster(p.code, rupees, "Backfill")} busy={busy} />
          ))}
        </Card>
      </section>
    </div>
  );
}

function MissingRow({
  product,
  onSave,
  busy,
}: {
  product: { code: string; name: string };
  onSave: (rupees: string) => void;
  busy: boolean;
}) {
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
      <span>
        {product.code} · {product.name}
      </span>
      <span className="flex gap-2">
        <input className={`${inputClass} w-28`} inputMode="decimal" placeholder="MRP ₹" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button size="sm" disabled={busy || !value.trim()} onClick={() => onSave(value)}>
          Save
        </Button>
      </span>
    </div>
  );
}
