/**
 * The GST included in an order's lines, recorded at checkout (migration 0183).
 *
 * GoKesari prices include GST, so nothing here changes what the customer
 * pays: each line's price is split into its taxable value and the GST (+ cess)
 * it already contains — the same maths as the shop's invoice (tax/split.ts),
 * so the parts always add up to exactly the line total. The order's
 * taxIncludedPaise is the sum of the lines' tax and is NEVER added to
 * totalPaise (orders.taxPaise, tax charged on top, stays 0).
 *
 * Pure functions: the rate lookup is gst/product-rates.ts
 * (resolveListingTaxClasses), the callers are checkout (services/orders.ts)
 * and the payout cycle's TCS / TDS base (payouts/cycle.ts).
 */
import { splitInclusiveWithCess } from "./split";

export interface LineTaxClass {
  hsnCode: string | null;
  /** Null: no rate on the listing, the master product or the dated HSN table. */
  gstRateBp: number | null;
  cessBp: number;
}

export interface SupplyContext {
  /** The shop charges GST (registered, not composition). False: bill of supply, no tax in the price. */
  chargesGst: boolean;
  /** Rule invoicing.applyCess: compensation cess is part of the included tax. */
  applyCess: boolean;
  supply: "INTRA" | "INTER";
}

export interface LineTaxSplit {
  taxablePaise: number;
  /** GST + cess included in the gross. */
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  cessPaise: number;
}

/**
 * The tax included in one tax-inclusive amount, or null when the shop charges
 * GST but no rate is known for the line (the amount's split is unknown — it is
 * never treated as all-taxable).
 */
export function includedLineTax(grossPaise: number, cls: Pick<LineTaxClass, "gstRateBp" | "cessBp">, ctx: SupplyContext): LineTaxSplit | null {
  if (!ctx.chargesGst) return { taxablePaise: grossPaise, taxPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 };
  if (cls.gstRateBp == null) return null;
  const cess = ctx.applyCess ? Math.max(0, cls.cessBp) : 0;
  const s = splitInclusiveWithCess(grossPaise, cls.gstRateBp, cess, ctx.supply);
  return { ...s, taxPaise: grossPaise - s.taxablePaise };
}

export interface SnapshotLine {
  lineTotalPaise: number;
  cls: LineTaxClass | undefined;
}

export interface OrderTaxSnapshot {
  lines: { hsnCode: string | null; gstRateBp: number | null; cessBp: number | null; taxablePaise: number | null; taxPaise: number | null }[];
  /** Sum of the lines' tax; null when any line's tax is unknown. */
  taxIncludedPaise: number | null;
}

/** The snapshot written with the order: one entry per line, in the same order. */
export function orderTaxSnapshot(lines: SnapshotLine[], ctx: SupplyContext): OrderTaxSnapshot {
  let total: number | null = 0;
  const out = lines.map((l) => {
    const cls = l.cls ?? { hsnCode: null, gstRateBp: null, cessBp: 0 };
    const split = includedLineTax(l.lineTotalPaise, cls, ctx);
    if (split == null) total = null;
    else if (total != null) total += split.taxPaise;
    return {
      hsnCode: cls.hsnCode,
      gstRateBp: cls.gstRateBp,
      cessBp: cls.gstRateBp == null ? null : cls.cessBp,
      taxablePaise: split?.taxablePaise ?? null,
      taxPaise: split?.taxPaise ?? null,
    };
  });
  return { lines: out, taxIncludedPaise: total };
}

/** One order line as the payout cycle reads it: the checkout snapshot plus what fulfilment changed. */
export interface PayoutTaxItem {
  fulfilmentStatus: string;
  lineTotalPaise: number;
  substituteLineTotalPaise: number | null;
  /** Snapshot (null on orders before 0183). */
  taxablePaise: number | null;
  gstRateBp: number | null;
  cessBp: number | null;
  /** Today's classification of the listing actually supplied, for lines without a usable snapshot. */
  live: LineTaxClass | undefined;
}

export interface PayoutTaxableBase {
  /** Taxable value (without GST and cess) of the goods value; never the GST-inclusive value. */
  taxablePaise: number;
  /** How it was found: the snapshot only, partly computed from today's rates, or nothing known. */
  source: "ORDER_SNAPSHOT" | "COMPUTED";
  /** Gross of lines with no known rate: left out of the base (shown for review), never taxed at the inclusive value. */
  unratedGrossPaise: number;
}

/**
 * The TCS / TDS base of a delivered order that has no tax invoice: the
 * taxable value of what was supplied. A line keeps its checkout snapshot
 * unless it was substituted (then today's rate of the substitute applies);
 * a removed line is left out. The result is scaled to the order's goods
 * value (order_financials.goods_paise), so a later adjustment of that value
 * moves the base in proportion. Lines with no known rate add nothing.
 */
export function payoutTaxableBase(goodsPaise: number, items: PayoutTaxItem[], ctx: Omit<SupplyContext, "supply">): PayoutTaxableBase {
  let gross = 0;
  let taxable = 0;
  let unrated = 0;
  let computed = false;
  for (const it of items) {
    if (it.fulfilmentStatus === "REMOVED") continue;
    const substituted = it.fulfilmentStatus === "SUBSTITUTED" && it.substituteLineTotalPaise != null;
    const lineGross = substituted ? it.substituteLineTotalPaise! : it.lineTotalPaise;
    gross += lineGross;
    if (!substituted && it.taxablePaise != null) {
      taxable += it.taxablePaise;
      continue;
    }
    computed = true;
    const cls = !substituted && it.gstRateBp != null ? { gstRateBp: it.gstRateBp, cessBp: it.cessBp ?? 0 } : it.live;
    // INTRA / INTER does not change the taxable value, only how the tax is split.
    const split = includedLineTax(lineGross, cls ?? { gstRateBp: null, cessBp: 0 }, { ...ctx, supply: "INTRA" });
    if (split == null) unrated += lineGross;
    else taxable += split.taxablePaise;
  }
  const scaled = gross > 0 ? Math.round((goodsPaise * taxable) / gross) : 0;
  return { taxablePaise: Math.min(scaled, goodsPaise), source: computed ? "COMPUTED" : "ORDER_SNAPSHOT", unratedGrossPaise: unrated };
}
