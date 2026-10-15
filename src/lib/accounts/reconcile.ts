/**
 * GSTR-2B / 2A reconciliation (docs/inventory-accounting-2026-10, Part 3): the
 * purchase bills in the shop's books against the invoices its suppliers
 * reported on the GST portal. Pure.
 *
 * Match key: supplier GSTIN + invoice number (normalised: case, spaces,
 * separators and leading zeros ignored). A pair that matches on the key is
 * then compared on date and amount:
 *
 *   MATCHED            amounts agree within the tolerance (₹1 per head by default)
 *   AMOUNT_MISMATCH    the same invoice with a different total or tax (or date)
 *   MISSING_IN_BOOKS   on the portal, no bill in the books
 *   MISSING_ON_PORTAL  in the books, not on the portal (supplier has not filed,
 *                      or filed it under a different number/GSTIN)
 *
 * When numbers differ only slightly (a typo), a second pass pairs a leftover
 * books bill with a leftover portal invoice of the same supplier, same date
 * and same amounts — MATCHED, with a note naming both numbers, since only the
 * printed number differs.
 */
import { invoiceNoKey } from "./text-match";

export interface ReconBook {
  id: string;
  supplierGstin: string | null;
  invoiceNo: string;
  invoiceDate: string;
  totalPaise: number;
  taxPaise: number;
}

export interface ReconPortal {
  id: string;
  supplierGstin: string;
  invoiceNo: string;
  invoiceDate: string;
  totalPaise: number;
  taxPaise: number;
}

export interface ReconRow {
  status: "MATCHED" | "AMOUNT_MISMATCH" | "MISSING_IN_BOOKS" | "MISSING_ON_PORTAL";
  book: ReconBook | null;
  portal: ReconPortal | null;
  note: string | null;
}

export function reconcile(books: ReconBook[], portal: ReconPortal[], tolerancePaise = 100): ReconRow[] {
  const rows: ReconRow[] = [];
  const key = (gstin: string | null, no: string) => `${(gstin ?? "").toUpperCase()}|${invoiceNoKey(no)}`;
  const portalByKey = new Map<string, ReconPortal[]>();
  for (const p of portal) {
    const k = key(p.supplierGstin, p.invoiceNo);
    portalByKey.set(k, [...(portalByKey.get(k) ?? []), p]);
  }
  const usedPortal = new Set<string>();
  const leftoverBooks: ReconBook[] = [];

  for (const b of books) {
    if (!b.supplierGstin) continue; // unregistered supplier: nothing on the portal to match, no ITC
    const candidates = (portalByKey.get(key(b.supplierGstin, b.invoiceNo)) ?? []).filter((p) => !usedPortal.has(p.id));
    const p = candidates.find((c) => c.invoiceDate === b.invoiceDate) ?? candidates[0];
    if (!p) {
      leftoverBooks.push(b);
      continue;
    }
    usedPortal.add(p.id);
    const totalDiff = b.totalPaise - p.totalPaise;
    const taxDiff = b.taxPaise - p.taxPaise;
    const notes: string[] = [];
    if (Math.abs(totalDiff) > tolerancePaise) notes.push(`total differs by ₹${(totalDiff / 100).toFixed(2)}`);
    if (Math.abs(taxDiff) > tolerancePaise) notes.push(`tax differs by ₹${(taxDiff / 100).toFixed(2)}`);
    if (p.invoiceDate !== b.invoiceDate) notes.push(`date on portal ${p.invoiceDate}, in books ${b.invoiceDate}`);
    rows.push({ status: notes.length ? "AMOUNT_MISMATCH" : "MATCHED", book: b, portal: p, note: notes.length ? notes.join("; ") : null });
  }

  // Second pass: same supplier, date and amounts, number printed differently.
  const leftoverPortal = portal.filter((p) => !usedPortal.has(p.id));
  for (const b of leftoverBooks) {
    const p = leftoverPortal.find(
      (c) =>
        !usedPortal.has(c.id) &&
        c.supplierGstin.toUpperCase() === (b.supplierGstin ?? "").toUpperCase() &&
        c.invoiceDate === b.invoiceDate &&
        Math.abs(c.totalPaise - b.totalPaise) <= tolerancePaise &&
        Math.abs(c.taxPaise - b.taxPaise) <= tolerancePaise,
    );
    if (p) {
      usedPortal.add(p.id);
      rows.push({ status: "MATCHED", book: b, portal: p, note: `invoice number on portal is "${p.invoiceNo}", in books "${b.invoiceNo}"` });
    } else {
      rows.push({ status: "MISSING_ON_PORTAL", book: b, portal: null, note: null });
    }
  }
  for (const p of portal) if (!usedPortal.has(p.id)) rows.push({ status: "MISSING_IN_BOOKS", book: null, portal: p, note: null });
  return rows;
}
