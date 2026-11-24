/**
 * The monthly franchise statement per dealer code (brief 21-Nov-2026 §5): a PDF with opening shops, baseline,
 * actual business, new shops, base points (registration + business), main points, bonus %, commission rate,
 * rating, the payout lines and next month's baseline. E-mailed on the 4th at 10:00 IST to the dealer and to the
 * CEO copy list, downloadable any time from the dealer's page. Times in IST.
 */
import { and, eq, isNull } from "drizzle-orm";

import { forbidden, notFound } from "@/lib/errors";
import { formatIst, istInstant, rupees } from "@/lib/franchise";
import { PdfDocument, mm, pdfSafe, type PdfPage } from "@/lib/health/pdf-writer";
import { db } from "@/server/db";
import { dealers, franchiseMonthlySnapshots, franchiseNotificationLog, franchiseZones, users, type FranchiseMonthlySnapshot, type UserRole } from "@/server/db/schema";
import { sendEmail } from "@/server/email/transport";
import { getRule } from "@/server/services/settings";
import { configVersion } from "./config";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export interface StatementData {
  snap: FranchiseMonthlySnapshot;
  dealerName: string;
  zoneName: string;
  expectedPerShopPaise: number;
  slotPaise: number;
  target: number;
  /** Rule dealerPayoutTds: the statement mentions TDS only while it is deducted. */
  tdsOn?: boolean;
}

export async function statementData(snapshotId: string): Promise<StatementData> {
  const [row] = await db
    .select({ snap: franchiseMonthlySnapshots, dealerName: dealers.legalName, zoneName: franchiseZones.name })
    .from(franchiseMonthlySnapshots)
    .innerJoin(dealers, eq(dealers.id, franchiseMonthlySnapshots.ownerDealerId))
    .innerJoin(franchiseZones, eq(franchiseZones.zoneId, franchiseMonthlySnapshots.zoneId))
    .where(eq(franchiseMonthlySnapshots.id, snapshotId));
  if (!row) throw notFound("Statement");
  const c = await configVersion(row.snap.configVersion);
  const tdsOn = (await getRule("dealerPayoutTds")).enabled;
  return { ...row, expectedPerShopPaise: c.expectedBusinessPerShopPaise, slotPaise: c.businessSlotPaise, target: c.monthlyShopTarget, tdsOn };
}


/** The statement as rows (label, value) — the PDF, the e-mail summary and the CSV use the same lines. */
export function statementLines(d: StatementData): [string, string][] {
  const s = d.snap;
  return [
    ["Dealer", d.dealerName],
    ["Dealer code / area", `${s.code ?? "—"} · Zone ${s.zoneId} — ${d.zoneName}`],
    ["Month", monthName(s.month)],
    ["Opening shops", String(s.openingShops)],
    ["Baseline", `${s.openingShops} × ${rupees(d.expectedPerShopPaise)} = ${rupees(s.baselinePaise)}`],
    ["Actual business (opening shops)", rupees(s.actualBusinessPaise)],
    ["New shops (target)", `${s.newShops} (target ${d.target})`],
    ["Registration base points", String(s.regBasePts)],
    ["Business base points", `${s.bizBasePts} (slot ${rupees(d.slotPaise)})`],
    ["Total base points", String(s.totalBasePts)],
    ["Main points", Number(s.mainPts).toFixed(2)],
    ["Bonus", `${(s.bonusBp / 100).toFixed(2)}%${s.bonusEligible ? "" : " (franchise not active: no bonus)"}`],
    ["Commission rate", `${(s.commissionRateBp / 100).toFixed(2)}%`],
    ["Rating", Number(s.rating).toFixed(2)],
    ["Delivered order value, all shops (net)", rupees(s.allBusinessPaise)],
    ["Recurring commission", rupees(s.recurringPaise)],
    ["Onboarding commission (new shops)", rupees(s.onboardingPaise)],
    ["Adjustments carried forward", rupees(s.adjustmentsPaise)],
    [d.tdsOn ? "Total payout (before TDS)" : "Total payout", rupees(s.totalPayoutPaise)],
    ["Next month's opening shops / baseline", `${s.nextOpeningShops} / ${rupees(s.nextOpeningShops * d.expectedPerShopPaise)}`],
    ["Status", s.status === "LOCKED" ? `Locked ${formatIst(s.lockedAt)} — paid on the 5th${d.tdsOn ? " after TDS" : ""}` : `Draft (calculated ${formatIst(s.calculatedAt)})`],
  ];
}

export function statementPdf(d: StatementData): Buffer {
  const doc = new PdfDocument({ title: `GoKesari franchise statement ${d.snap.month} ${d.snap.code ?? ""}`, author: "GoKesari" });
  const page: PdfPage = doc.addPageMm("A4");
  const left = mm(18);
  let y = page.height - mm(20);
  page.text(left, y, "GoKesari Territory Franchise - monthly statement", { size: 15, font: "bold" });
  y -= mm(6);
  page.text(left, y, pdfSafe(`ASMY Global Trading and Consulting India Pvt Ltd (AGTCI) · gokesari.com · issued ${formatIst(new Date())}`), { size: 8, color: [0.4, 0.4, 0.4] });
  y -= mm(10);
  for (const [label, value] of statementLines(d)) {
    const total = label.startsWith("Total payout");
    page.text(left, y, pdfSafe(label), { size: 10, font: total ? "bold" : "regular" });
    page.textRight(page.width - mm(18), y, pdfSafe(value).replace(/Rs\.\s?/g, "Rs. "), { size: 10, font: total ? "bold" : "regular" });
    y -= mm(6.5);
    if (label === "Commission rate" || label === "Rating" || label === "Adjustments carried forward") {
      page.line(left, y + mm(3), page.width - mm(18), y + mm(3), { width: 0.3, color: [0.85, 0.85, 0.85] });
    }
  }
  y -= mm(6);
  for (const line of [
    "How it is worked out: registration points = new shops above the target; business points = (opening shops' business - baseline) / slot, never",
    "negative; main points = base points / 100; bonus = 1% a main point, at most 5%; rate = 25% + bonus; rating = 5 + bonus %. Recurring = rate x 2% x",
    "delivered order value of all your shops (net of cancellations and refunds). Shops registered this month join the baseline next month.",
    d.tdsOn ? "All times IST. TDS is deducted at payout as shown on the payout advice." : "All times IST. Any TDS that applies is shown on the payout advice.",
  ]) {
    page.text(left, y, pdfSafe(line), { size: 7.5, color: [0.35, 0.35, 0.35] });
    y -= mm(4);
  }
  return doc.build();
}

export function statementCsv(d: StatementData): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["Item,Value", ...statementLines(d).map(([l, v]) => `${esc(l)},${esc(v)}`)].join("\n") + "\n";
}

/** The dealer (his own codes) or an admin / operator may read a statement. */
export async function statementForViewer(snapshotId: string, viewer: { id: string; role: UserRole }): Promise<StatementData> {
  const d = await statementData(snapshotId);
  if (viewer.role === "ADMIN" || viewer.role === "OPERATOR") return d;
  const [owner] = await db.select({ userId: dealers.userId }).from(dealers).where(eq(dealers.id, d.snap.ownerDealerId));
  if (owner?.userId !== viewer.id) throw forbidden("This statement belongs to another dealer.");
  return d;
}

/**
 * Brief 21-Nov §5, the 4th at 10:00 IST: each code's statement for `month` (PDF + summary) to the dealer and the
 * CEO copy list, once (franchise_notification_log), and marks the snapshot e-mailed.
 */
export async function emailStatements(month: string, cc: readonly string[]): Promise<number> {
  const rows = await db
    .select({ id: franchiseMonthlySnapshots.id, email: users.email })
    .from(franchiseMonthlySnapshots)
    .innerJoin(dealers, eq(dealers.id, franchiseMonthlySnapshots.ownerDealerId))
    .leftJoin(users, eq(users.id, dealers.userId))
    .where(and(eq(franchiseMonthlySnapshots.month, month), isNull(franchiseMonthlySnapshots.statementEmailedAt)));
  const dueOn = month + "-01";
  let sent = 0;
  for (const r of rows) {
    const d = await statementData(r.id);
    const pdf = statementPdf(d);
    const summary = statementLines(d).map(([l, v]) => `${l}: ${v}`).join("\n");
    const subject = `GoKesari franchise statement — ${monthName(month)} — ${d.snap.code ?? d.snap.zoneId}`;
    for (const to of [...new Set([...(r.email ? [r.email] : []), ...cc])]) {
      const [claimed] = await db
        .insert(franchiseNotificationLog)
        .values({ allocationId: d.snap.allocationId, kind: `STATEMENT:${month}`, dueOn, channel: "EMAIL", recipient: to, status: "QUEUED" })
        .onConflictDoNothing()
        .returning({ id: franchiseNotificationLog.id });
      if (!claimed) continue;
      try {
        await sendEmail({ to, subject, text: `${summary}\n\nThe PDF is attached. Your statements are also on ${process.env.APP_BASE_URL ?? "https://gokesari.com"}/franchise/my (times in IST).`, attachments: [{ filename: `franchise-statement-${month}-${d.snap.code ?? d.snap.zoneId}.pdf`, content: pdf, contentType: "application/pdf" }] });
        await db.update(franchiseNotificationLog).set({ status: "SENT", sentAt: new Date() }).where(eq(franchiseNotificationLog.id, claimed.id));
        sent++;
      } catch (e) {
        await db.update(franchiseNotificationLog).set({ status: "FAILED", detail: e instanceof Error ? e.message.slice(0, 300) : String(e) }).where(eq(franchiseNotificationLog.id, claimed.id));
      }
    }
    await db.update(franchiseMonthlySnapshots).set({ statementEmailedAt: new Date() }).where(eq(franchiseMonthlySnapshots.id, r.id));
  }
  return sent;
}

/** The moment the statements of `month` are due: the statement day of the next month at the statement hour (IST). */
export function statementDueAt(month: string, day: number, hourIst: number): Date {
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return istInstant(`${next}-${String(day).padStart(2, "0")}`, hourIst);
}
