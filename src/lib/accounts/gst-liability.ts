/**
 * Net GST payable for a period (docs/inventory-accounting-2026-10):
 *
 *   Output GST (sales) − eligible Input GST (ITC from reconciled purchases)
 *
 * per head (CGST, SGST, IGST, cess), using input tax credit in the order the
 * law prescribes (CGST Act s.49 and rule 88A): IGST credit first — against
 * IGST, then CGST and SGST (split so as to leave the least cash to pay);
 * then CGST credit against CGST, then IGST; SGST credit against SGST, then
 * IGST. CGST credit never pays SGST and SGST credit never pays CGST. Cess
 * credit pays cess only. Unused credit carries forward.
 *
 * These are estimates from the shop's books; the owner's CA files the return.
 */
import type { FilingFrequency } from "./constants";

export interface Heads {
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

export const ZERO_HEADS: Heads = { cgst: 0, sgst: 0, igst: 0, cess: 0 };

export function addHeads(a: Heads, b: Heads): Heads {
  return { cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, igst: a.igst + b.igst, cess: a.cess + b.cess };
}

export interface SetOffResult {
  output: Heads;
  credit: Heads;
  /** Credit used against each liability head, by source credit head. */
  utilised: { igstToIgst: number; igstToCgst: number; igstToSgst: number; cgstToCgst: number; cgstToIgst: number; sgstToSgst: number; sgstToIgst: number; cessToCess: number };
  /** Paid in cash, per liability head. */
  cash: Heads;
  carryForward: Heads;
  totalCash: number;
}

export function setOff(output: Heads, credit: Heads): SetOffResult {
  const liab = { ...output };
  const cr = { ...credit };
  const u = { igstToIgst: 0, igstToCgst: 0, igstToSgst: 0, cgstToCgst: 0, cgstToIgst: 0, sgstToSgst: 0, sgstToIgst: 0, cessToCess: 0 };

  // 1. IGST credit against IGST.
  u.igstToIgst = Math.min(cr.igst, liab.igst);
  cr.igst -= u.igstToIgst;
  liab.igst -= u.igstToIgst;

  // 2. Remaining IGST credit against CGST and SGST: first the parts CGST/SGST credit cannot cover.
  if (cr.igst > 0) {
    const cgstGap = Math.max(0, liab.cgst - cr.cgst);
    const sgstGap = Math.max(0, liab.sgst - cr.sgst);
    let x = Math.min(cr.igst, cgstGap);
    let y = Math.min(cr.igst - x, sgstGap);
    // IGST credit must be used before CGST/SGST credit: any left goes on, up to the liability.
    let rest = cr.igst - x - y;
    const moreC = Math.min(rest, liab.cgst - x);
    x += moreC;
    rest -= moreC;
    const moreS = Math.min(rest, liab.sgst - y);
    y += moreS;
    u.igstToCgst = x;
    u.igstToSgst = y;
    cr.igst -= x + y;
    liab.cgst -= x;
    liab.sgst -= y;
  }

  // 3. CGST credit: CGST, then IGST.
  u.cgstToCgst = Math.min(cr.cgst, liab.cgst);
  cr.cgst -= u.cgstToCgst;
  liab.cgst -= u.cgstToCgst;
  u.cgstToIgst = Math.min(cr.cgst, liab.igst);
  cr.cgst -= u.cgstToIgst;
  liab.igst -= u.cgstToIgst;

  // 4. SGST credit: SGST, then IGST.
  u.sgstToSgst = Math.min(cr.sgst, liab.sgst);
  cr.sgst -= u.sgstToSgst;
  liab.sgst -= u.sgstToSgst;
  u.sgstToIgst = Math.min(cr.sgst, liab.igst);
  cr.sgst -= u.sgstToIgst;
  liab.igst -= u.sgstToIgst;

  // 5. Cess.
  u.cessToCess = Math.min(cr.cess, liab.cess);
  cr.cess -= u.cessToCess;
  liab.cess -= u.cessToCess;

  return {
    output,
    credit,
    utilised: u,
    cash: liab,
    carryForward: cr,
    totalCash: liab.cgst + liab.sgst + liab.igst + liab.cess,
  };
}

/* --------------------------------------------------------------- due dates */

/** States whose QRMP GSTR-3B is due on the 22nd (the rest: 24th). */
const QRMP_22ND_STATES = new Set(["22", "23", "24", "25", "26", "27", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "97"]);

export interface DueDate {
  returnType: "GSTR1" | "GSTR3B" | "PMT06";
  /** YYYY-MM for monthly, YYYY-Qn for quarterly. */
  period: string;
  dueDate: string;
  label: string;
}

function ymd(y: number, m: number, d: number): string {
  // m is 1-12 and may overflow into the next year.
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toISOString().slice(0, 10);
}

/** Quarter of a month (1-12): April–June is Q1 of the financial year. */
export function quarterOf(month: number): number {
  return Math.floor(((month + 8) % 12) / 3) + 1;
}

/** Due dates of the returns for the month `period` (YYYY-MM). */
export function dueDatesFor(period: string, frequency: FilingFrequency, stateCode: string | null): DueDate[] {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  if (frequency === "MONTHLY") {
    return [
      { returnType: "GSTR1", period, dueDate: ymd(y, m + 1, 11), label: `GSTR-1 for ${period}` },
      { returnType: "GSTR3B", period, dueDate: ymd(y, m + 1, 20), label: `GSTR-3B for ${period}` },
    ];
  }
  // Quarterly (QRMP): months 1 and 2 of a quarter pay by PMT-06 on the 25th; month 3 files.
  const fyStart = m >= 4 ? y : y - 1;
  const q = quarterOf(m);
  const qLabel = `${fyStart}-Q${q}`;
  const lastMonthOfQuarter = m % 3 === 0;
  if (!lastMonthOfQuarter) {
    return [{ returnType: "PMT06", period, dueDate: ymd(y, m + 1, 25), label: `PMT-06 tax payment for ${period}` }];
  }
  const day3b = QRMP_22ND_STATES.has((stateCode ?? "").slice(0, 2)) ? 22 : 24;
  return [
    { returnType: "GSTR1", period: qLabel, dueDate: ymd(y, m + 1, 13), label: `GSTR-1 for quarter ${qLabel}` },
    { returnType: "GSTR3B", period: qLabel, dueDate: ymd(y, m + 1, day3b), label: `GSTR-3B for quarter ${qLabel}` },
  ];
}

/** Months (YYYY-MM) of the quarter containing `period`. */
export function quarterMonths(period: string): string[] {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  const first = m - ((m - 1) % 3);
  return [0, 1, 2].map((i) => `${y}-${String(first + i).padStart(2, "0")}`);
}

/** Every YYYY-MM from `from` to `to` inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (y * 12 + m <= end && out.length < 240) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** First day of the month and first day of the next month (ISO dates). */
export function periodRange(period: string): { from: string; to: string } {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(5, 7));
  return { from: ymd(y, m, 1), to: ymd(y, m + 1, 1) };
}
