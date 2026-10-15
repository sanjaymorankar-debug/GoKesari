"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, Field, inputClass } from "@/components/ui";
import { accountsApi, qty } from "./api";
import { FormError } from "./payment-forms";

/** "2.5" → 2500 milli; null when not a valid non-negative quantity. */
function parseQty(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "");
  if (!s || !/^\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}

export interface StockBatchOption {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  qtyMilli: number;
}

type Panel = "writeoff" | "count" | null;

/**
 * Owner actions on one listing's stock: write off damaged / expired goods,
 * set the quantity to a physical count, switch batch / expiry tracking.
 */
export function StockActions({ shopId, listingId, unit, qtyMilli, trackBatches, batches }: { shopId: string; listingId: string; unit: string; qtyMilli: number; trackBatches: boolean; batches: StockBatchOption[] }) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [kind, setKind] = useState<"DAMAGE" | "EXPIRY">("DAMAGE");
  const [amount, setAmount] = useState("");
  const [batchId, setBatchId] = useState("");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function show(p: Panel) {
    setPanel(panel === p ? null : p);
    setError(null);
    setDone(null);
    setNote("");
  }

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      setPanel(null);
      setAmount("");
      setCounted("");
      setNote("");
      setBatchId("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  function writeOff(e: React.FormEvent) {
    e.preventDefault();
    const milli = parseQty(amount);
    if (!milli) return setError(`Enter how much to write off (in ${unit}).`);
    if (milli > qtyMilli) return setError(`Only ${qty(qtyMilli)} ${unit} in stock.`);
    void run(async () => {
      await accountsApi(shopId, `stock/${listingId}/write-off`, { body: { qtyMilli: milli, kind, batchId: batchId || null, note: note.trim() || null } });
      return `${qty(milli)} ${unit} written off as ${kind === "DAMAGE" ? "damaged" : "expired"}.`;
    });
  }

  function count(e: React.FormEvent) {
    e.preventDefault();
    const milli = parseQty(counted);
    if (milli == null) return setError(`Enter the quantity on the shelf (in ${unit}).`);
    void run(async () => {
      const r = await accountsApi<{ deltaMilli: number }>(shopId, `stock/${listingId}/count`, { body: { countedMilli: milli, note: note.trim() || null } });
      if (r.deltaMilli === 0) return "Count matches the books. Nothing changed.";
      return `Stock set to ${qty(milli)} ${unit} (${r.deltaMilli > 0 ? "+" : "−"}${qty(Math.abs(r.deltaMilli))}).`;
    });
  }

  function toggleBatches() {
    void run(async () => {
      await accountsApi(shopId, `stock/${listingId}/batches`, { body: { track: !trackBatches } });
      return !trackBatches ? "Batch and expiry tracking is on. Enter batch numbers on purchase bills." : "Batch tracking is off.";
    });
  }

  const tab = (p: Exclude<Panel, null>, label: string) => (
    <Button variant={panel === p ? "primary" : "secondary"} size="sm" onClick={() => show(p)} aria-expanded={panel === p}>
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {tab("writeoff", "Write off")}
        {tab("count", "Physical count")}
        <Button variant="secondary" size="sm" onClick={toggleBatches} disabled={busy} aria-pressed={trackBatches}>
          Batch tracking: {trackBatches ? "On" : "Off"}
        </Button>
      </div>

      {panel === "writeoff" ? (
        <form onSubmit={writeOff} className="grid gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-2" aria-label="Write off stock">
          <Field label="Reason">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value as "DAMAGE" | "EXPIRY")}>
              <option value="DAMAGE">Damaged / broken / lost</option>
              <option value="EXPIRY">Expired</option>
            </select>
          </Field>
          <Field label={`Quantity (${unit})`} hint={`In stock: ${qty(qtyMilli)}`}>
            <input className={inputClass} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          {batches.length ? (
            <Field label="Batch (optional)">
              <select className={inputClass} value={batchId} onChange={(e) => setBatchId(e.target.value)}>
                <option value="">— Not by batch —</option>
                {batches.map((b) => (
                  <option key={b.batchId} value={b.batchId}>
                    {b.batchNo} · exp {b.expiryDate} · {qty(b.qtyMilli)} left
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label="Note (optional)">
            <input className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="danger" disabled={busy}>
              {busy ? "Saving…" : "Write off"}
            </Button>
          </div>
        </form>
      ) : null}

      {panel === "count" ? (
        <form onSubmit={count} className="grid gap-2 rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:grid-cols-2" aria-label="Physical stock count">
          <Field label={`Quantity on the shelf (${unit})`} hint={`Books say ${qty(qtyMilli)}. The difference is posted as an adjustment.`}>
            <input className={inputClass} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} required />
          </Field>
          <Field label="Note (optional)">
            <input className={inputClass} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Physical stock count" />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Set stock"}
            </Button>
          </div>
        </form>
      ) : null}

      <p aria-live="polite" className="text-sm text-leaf-700">
        {done ?? ""}
      </p>
      <FormError message={error} />
    </div>
  );
}
