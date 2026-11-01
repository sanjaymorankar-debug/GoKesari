/**
 * Stock valuation over the stock ledger (docs/inventory-accounting-2026-10):
 * FIFO or weighted average, chosen per shop. Pure — the caller passes one
 * listing's ledger rows in the order they were written.
 *
 * Inbound rows with a cost add a layer (FIFO) or fold into the average
 * (WAVG). Outbound rows take stock out at the FIFO layers' cost or the
 * current average; the cost taken out is the cost of goods sold for sales
 * and the written-off value for damage/expiry. A REVERSAL of an inbound row
 * takes that same quantity back out at that row's own cost, so a corrected
 * purchase leaves no trace in the valuation.
 *
 * Inbound rows without a cost (opening stock entered before the books, stock
 * edited on the catalogue screen) are valued at `fallbackCostPaise` — the
 * latest purchase rate — and reported as `uncostedQtyMilli` so the screen can
 * say the figure is partly estimated.
 */
import type { StockMovementType, ValuationMethod } from "./constants";

export interface ValuationEntry {
  id: string;
  movementType: StockMovementType;
  qtyMilli: number;
  unitCostPaise: number | null;
  reversesId: string | null;
  entryDate: string;
}

export interface ValuationResult {
  qtyMilli: number;
  valuePaise: number;
  /** Value per sellable unit (paise), 0 when no stock. */
  unitCostPaise: number;
  /** Outbound cost per entry id (for COGS / write-off value). */
  outCost: Map<string, number>;
  uncostedQtyMilli: number;
}

interface Layer {
  entryId: string;
  qtyMilli: number;
  unitCostPaise: number;
}

const value = (qtyMilli: number, unitCostPaise: number) => (qtyMilli * unitCostPaise) / 1000;

export function valueStock(allEntries: ValuationEntry[], method: ValuationMethod, fallbackCostPaise = 0): ValuationResult {
  // Billing v2: a stock journal moves stock between the listing's two counts and nets to zero —
  // it neither adds a cost layer nor consumes one.
  const entries = allEntries.filter((e) => e.movementType !== "TRANSFER");
  const outCost = new Map<string, number>();
  const costOf = new Map<string, number>();
  let uncosted = 0;

  if (method === "FIFO") {
    const layers: Layer[] = [];
    let negative = 0; // stock sold before it was received (allowed by the shop's counts); settled by the next inbound
    for (const e of entries) {
      if (e.qtyMilli > 0) {
        const cost = e.unitCostPaise ?? fallbackCostPaise;
        if (e.unitCostPaise == null) uncosted += e.qtyMilli;
        costOf.set(e.id, cost);
        let qty = e.qtyMilli;
        if (negative > 0) {
          const settle = Math.min(negative, qty);
          negative -= settle;
          qty -= settle;
        }
        if (qty > 0) layers.push({ entryId: e.id, qtyMilli: qty, unitCostPaise: cost });
        continue;
      }
      let need = -e.qtyMilli;
      let taken = 0;
      // A reversal of an inbound row comes out of that row's own layer first.
      if (e.reversesId && costOf.has(e.reversesId)) {
        const own = layers.find((l) => l.entryId === e.reversesId);
        const cost = costOf.get(e.reversesId)!;
        if (own) {
          const q = Math.min(own.qtyMilli, need);
          own.qtyMilli -= q;
          need -= q;
          taken += value(q, cost);
        }
        // Already sold out of that layer: take the rest at the same cost from the oldest layers.
        while (need > 0 && layers.some((l) => l.qtyMilli > 0)) {
          const l = layers.find((x) => x.qtyMilli > 0)!;
          const q = Math.min(l.qtyMilli, need);
          l.qtyMilli -= q;
          need -= q;
          taken += value(q, l.unitCostPaise);
        }
      } else {
        while (need > 0 && layers.some((l) => l.qtyMilli > 0)) {
          const l = layers.find((x) => x.qtyMilli > 0)!;
          const q = Math.min(l.qtyMilli, need);
          l.qtyMilli -= q;
          need -= q;
          taken += value(q, l.unitCostPaise);
        }
      }
      if (need > 0) {
        negative += need;
        taken += value(need, fallbackCostPaise);
      }
      outCost.set(e.id, Math.round(taken));
    }
    const qty = layers.reduce((n, l) => n + l.qtyMilli, 0) - negative;
    const val = layers.reduce((n, l) => n + value(l.qtyMilli, l.unitCostPaise), 0) - value(negative, fallbackCostPaise);
    return { qtyMilli: qty, valuePaise: Math.round(val), unitCostPaise: qty > 0 ? Math.round((val * 1000) / qty) : 0, outCost, uncostedQtyMilli: Math.min(uncosted, Math.max(qty, 0)) };
  }

  // Weighted average.
  let qty = 0;
  let val = 0;
  for (const e of entries) {
    if (e.qtyMilli > 0) {
      const cost = e.unitCostPaise ?? (qty > 0 ? (val * 1000) / qty : fallbackCostPaise);
      if (e.unitCostPaise == null) uncosted += e.qtyMilli;
      costOf.set(e.id, cost);
      qty += e.qtyMilli;
      val += value(e.qtyMilli, cost);
      continue;
    }
    const out = -e.qtyMilli;
    const avg = qty > 0 ? (val * 1000) / qty : fallbackCostPaise;
    const cost = e.reversesId && costOf.has(e.reversesId) ? costOf.get(e.reversesId)! : avg;
    const taken = value(out, cost);
    qty -= out;
    val -= taken;
    if (qty <= 0) {
      // Out of stock: no value can remain (rounding, or stock sold before it was received).
      val = qty === 0 ? 0 : value(qty, fallbackCostPaise);
    }
    outCost.set(e.id, Math.round(taken));
  }
  return { qtyMilli: qty, valuePaise: Math.round(val), unitCostPaise: qty > 0 ? Math.round((val * 1000) / qty) : 0, outCost, uncostedQtyMilli: Math.min(uncosted, Math.max(qty, 0)) };
}

/** Outbound movement types whose cost is cost of goods sold. */
export const COGS_TYPES: readonly StockMovementType[] = ["SALE", "SALE_RETURN"];
export const WRITE_OFF_TYPES: readonly StockMovementType[] = ["WRITE_OFF_DAMAGE", "WRITE_OFF_EXPIRY"];

export interface BatchInbound {
  batchId: string;
  qtyMilli: number;
  expiryDate: string | null;
}

/**
 * Batch-wise stock: what each batch still holds when sales are taken from
 * the batch that expires first (FEFO) — sales from online orders do not say
 * which batch went out, so the earliest expiry is assumed.
 */
export function batchBalances(inbound: BatchInbound[], outboundUnbatchedMilli: number): Map<string, number> {
  const sorted = [...inbound].sort((a, b) => (a.expiryDate ?? "9999-12-31").localeCompare(b.expiryDate ?? "9999-12-31"));
  const left = new Map<string, number>();
  for (const b of sorted) left.set(b.batchId, (left.get(b.batchId) ?? 0) + b.qtyMilli);
  let need = outboundUnbatchedMilli;
  for (const b of sorted) {
    if (need <= 0) break;
    const have = left.get(b.batchId) ?? 0;
    const take = Math.min(have, need);
    left.set(b.batchId, have - take);
    need -= take;
  }
  return left;
}
