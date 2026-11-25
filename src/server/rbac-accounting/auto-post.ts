/**
 * GoKesari's own books (docs/tax-register/BOOKS.md; flag auto_journals, OFF).
 *
 * Every payout that is paid queues a balanced posting — payables, the bank, commission income and
 * the statutory liabilities (TCS payable, TDS payable by section, GST output on fees, s.9(5) GST).
 * The Accountant turns a posting into a journal entry draft (they are the preparer, so the CA
 * approves it as for any journal) or dismisses it with a reason. Nothing posts by itself.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import { finAutoPostings, finJournalEntries, finJournalLines, type FinAutoPosting, type UserRole } from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { isFeatureEnabled } from "@/server/services/feature-flags";

/** GoKesari's chart of accounts for the automatic postings (codes are free text in the journals). */
export const GK_ACCOUNTS = {
  BANK: { code: "1100", name: "Bank — payouts account" },
  SHOP_PAYABLE: { code: "2100", name: "Payable to shops" },
  RIDER_PAYABLE: { code: "2110", name: "Payable to delivery partners" },
  SHOP_WALLET: { code: "2150", name: "Shop prepaid wallets" },
  TCS_PAYABLE: { code: "2310", name: "GST TCS payable (s.52)" },
  TDS_194O_PAYABLE: { code: "2320", name: "TDS payable — s.194-O" },
  TDS_194C_PAYABLE: { code: "2321", name: "TDS payable — s.194C" },
  TDS_194H_PAYABLE: { code: "2322", name: "TDS payable — s.194H" },
  TDS_COMMISSION_PAYABLE: { code: "2323", name: "TDS payable — dealer / team commission" },
  GST_OUTPUT_FEES: { code: "2330", name: "GST output — GoKesari fees" },
  GST_S95_PAYABLE: { code: "2340", name: "GST payable — s.9(5)" },
  COMMISSION_INCOME: { code: "4100", name: "Commission income" },
  FEE_INCOME: { code: "4200", name: "Fee income" },
  REFERRAL_EXPENSE: { code: "5200", name: "Referral commission expense" },
  DEALER_EXPENSE: { code: "5300", name: "Dealer / team commission expense" },
} as const;
type Account = (typeof GK_ACCOUNTS)[keyof typeof GK_ACCOUNTS];

export const LIABILITY_CODES: string[] = [GK_ACCOUNTS.TCS_PAYABLE, GK_ACCOUNTS.TDS_194O_PAYABLE, GK_ACCOUNTS.TDS_194C_PAYABLE, GK_ACCOUNTS.TDS_194H_PAYABLE, GK_ACCOUNTS.TDS_COMMISSION_PAYABLE, GK_ACCOUNTS.GST_OUTPUT_FEES, GK_ACCOUNTS.GST_S95_PAYABLE].map((a) => a.code);

export interface PostingLine {
  accountCode: string;
  accountName: string;
  debitPaise: number;
  creditPaise: number;
  memo?: string | null;
}
export interface Posting {
  sourceType: string;
  sourceId: string;
  entryDate: string;
  narration: string;
  lines: PostingLine[];
}

const dr = (a: Account, paise: number, memo?: string): PostingLine => ({ accountCode: a.code, accountName: a.name, debitPaise: paise, creditPaise: 0, memo: memo ?? null });
const cr = (a: Account, paise: number, memo?: string): PostingLine => ({ accountCode: a.code, accountName: a.name, debitPaise: 0, creditPaise: paise, memo: memo ?? null });
const istDate = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** Drops zero lines; null when nothing is left or it does not balance (never queued). */
export function balanced(p: Posting): Posting | null {
  const lines = p.lines.filter((l) => l.debitPaise > 0 || l.creditPaise > 0);
  const d = lines.reduce((s, l) => s + l.debitPaise, 0);
  const c = lines.reduce((s, l) => s + l.creditPaise, 0);
  if (lines.length < 2 || d !== c || d <= 0) return null;
  return { ...p, lines };
}

/**
 * A shop payout item paid: what was withheld from it (by line type of the payout cycle) is
 * credited to its account, the net to the bank; the shop payable is debited by the total.
 */
export function shopPayoutPosting(item: { id: string; shopName: string; amountPaise: number; breakdown: Record<string, number>; paidAt: Date; utr: string }): Posting | null {
  const neg = (k: string) => Math.max(0, -(item.breakdown[k] ?? 0));
  const credits = [
    cr(GK_ACCOUNTS.COMMISSION_INCOME, neg("COMMISSION")),
    cr(GK_ACCOUNTS.GST_OUTPUT_FEES, neg("FEE_GST")),
    cr(GK_ACCOUNTS.TCS_PAYABLE, neg("TCS")),
    cr(GK_ACCOUNTS.TDS_194O_PAYABLE, neg("TDS")),
    cr(GK_ACCOUNTS.GST_S95_PAYABLE, neg("SEC95_GST")),
    cr(GK_ACCOUNTS.SHOP_WALLET, neg("WALLET_TOPUP")),
    cr(GK_ACCOUNTS.BANK, item.amountPaise, `UTR ${item.utr}`),
  ];
  const total = credits.reduce((s, l) => s + l.creditPaise, 0);
  return balanced({ sourceType: "payout_items", sourceId: item.id, entryDate: istDate(item.paidAt), narration: `Payout to ${item.shopName} (UTR ${item.utr})`, lines: [dr(GK_ACCOUNTS.SHOP_PAYABLE, total), ...credits] });
}

/** A weekly shop settlement paid (before the payout cycle): the commission withheld and the net. */
export function shopSettlementPosting(s: { id: string; shopName: string; netPayablePaise: number; commissionPaise: number; paidAt: Date; reference: string | null }): Posting | null {
  return balanced({
    sourceType: "shop_settlements",
    sourceId: s.id,
    entryDate: istDate(s.paidAt),
    narration: `Weekly settlement to ${s.shopName}${s.reference ? ` (${s.reference})` : ""}`,
    lines: [dr(GK_ACCOUNTS.SHOP_PAYABLE, s.netPayablePaise + s.commissionPaise), cr(GK_ACCOUNTS.COMMISSION_INCOME, s.commissionPaise), cr(GK_ACCOUNTS.BANK, s.netPayablePaise)],
  });
}

/** A rider payment (weekly payout or transfer): gross payable, TDS s.194C, fee, net to the bank. */
export function riderPosting(r: { sourceType: "rider_payouts" | "rider_bank_transfers"; id: string; riderName: string; grossPaise: number; tdsPaise: number; feePaise: number; netPaise: number; paidAt: Date; reference: string | null }): Posting | null {
  return balanced({
    sourceType: r.sourceType,
    sourceId: r.id,
    entryDate: istDate(r.paidAt),
    narration: `Payment to delivery partner ${r.riderName}${r.reference ? ` (${r.reference})` : ""}`,
    lines: [dr(GK_ACCOUNTS.RIDER_PAYABLE, r.grossPaise), cr(GK_ACCOUNTS.TDS_194C_PAYABLE, r.tdsPaise), cr(GK_ACCOUNTS.FEE_INCOME, r.feePaise), cr(GK_ACCOUNTS.BANK, r.netPaise)],
  });
}

/** A commission paid to a dealer / team member or a referrer: expense, TDS, net to the bank. */
export function commissionPosting(c: { sourceType: "dealer_payout_batches" | "referral_commissions"; id: string; payee: string; grossPaise: number; tdsPaise: number; paidAt: Date; reference: string | null }): Posting | null {
  const dealer = c.sourceType === "dealer_payout_batches";
  return balanced({
    sourceType: c.sourceType,
    sourceId: c.id,
    entryDate: istDate(c.paidAt),
    narration: `${dealer ? "Commission" : "Referral commission"} paid to ${c.payee}${c.reference ? ` (${c.reference})` : ""}`,
    lines: [
      dr(dealer ? GK_ACCOUNTS.DEALER_EXPENSE : GK_ACCOUNTS.REFERRAL_EXPENSE, c.grossPaise),
      cr(dealer ? GK_ACCOUNTS.TDS_COMMISSION_PAYABLE : GK_ACCOUNTS.TDS_194H_PAYABLE, c.tdsPaise),
      cr(GK_ACCOUNTS.BANK, c.grossPaise - c.tdsPaise),
    ],
  });
}

/**
 * Queues a posting (flag auto_journals). Called inside the payment's transaction; a source is
 * queued once (a repeated call is ignored). Never throws for an unbalanced posting — it is skipped.
 */
export async function queuePosting(posting: Posting | null, client: DbClient = db): Promise<void> {
  if (!posting) return;
  if (!(await isFeatureEnabled("auto_journals"))) return;
  const total = posting.lines.reduce((s, l) => s + l.debitPaise, 0);
  await client
    .insert(finAutoPostings)
    .values({ sourceType: posting.sourceType, sourceId: posting.sourceId, entryDate: posting.entryDate, narration: posting.narration.slice(0, 500), lines: posting.lines, totalPaise: total })
    .onConflictDoNothing();
}

export async function listAutoPostings(status?: FinAutoPosting["status"], limit = 200): Promise<FinAutoPosting[]> {
  const q = db.select().from(finAutoPostings);
  return status ? q.where(eq(finAutoPostings.status, status)).orderBy(desc(finAutoPostings.createdAt)).limit(limit) : q.orderBy(desc(finAutoPostings.createdAt)).limit(limit);
}

interface Actor {
  id: string;
  role: UserRole;
}

/** The Accountant turns a queued posting into a journal draft (they are its preparer). */
export async function draftFromPosting(id: string, actor: Actor): Promise<{ posting: FinAutoPosting; entryId: string }> {
  const [p] = await db.select().from(finAutoPostings).where(eq(finAutoPostings.id, id));
  if (!p) throw notFound("Posting");
  if (p.status !== "PENDING") throw conflict("This posting is already drafted or dismissed.");
  const { createJournalDraft } = await import("./journals");
  const entry = await createJournalDraft({ entryDate: p.entryDate, narration: `Auto: ${p.narration}`, lines: p.lines }, actor);
  const [row] = await db
    .update(finAutoPostings)
    .set({ status: "DRAFTED", journalEntryId: entry.id, decidedBy: actor.id, decidedAt: new Date() })
    .where(and(eq(finAutoPostings.id, id), eq(finAutoPostings.status, "PENDING")))
    .returning();
  if (!row) throw conflict("It changed meanwhile; reload.");
  return { posting: row, entryId: entry.id };
}

export async function dismissPosting(id: string, reason: string, actor: Actor): Promise<FinAutoPosting> {
  const text = reason.trim();
  if (text.length < 5) throw validationFailed("Give a reason of at least 5 characters.");
  const [row] = await db
    .update(finAutoPostings)
    .set({ status: "DISMISSED", dismissedReason: text, decidedBy: actor.id, decidedAt: new Date() })
    .where(and(eq(finAutoPostings.id, id), eq(finAutoPostings.status, "PENDING")))
    .returning();
  if (!row) throw conflict("Only a pending posting can be dismissed.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.JOURNAL_DRAFTED, entityType: "fin_auto_posting", entityId: id, newValue: { event: "DISMISSED", reason: text } });
  return row;
}

/**
 * Statutory liabilities of a month (YYYY-MM): what posted journal entries credited to TCS / TDS /
 * GST accounts, and what is still waiting as queued postings — the figures for challans and returns.
 */
export async function statutoryLiabilities(month: string): Promise<{ accountCode: string; accountName: string; postedPaise: number; pendingPaise: number }[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw validationFailed("Month: YYYY-MM.");
  const posted = await db
    .select({ code: finJournalLines.accountCode, name: sql<string>`max(${finJournalLines.accountName})`, net: sql<string>`coalesce(sum(${finJournalLines.creditPaise} - ${finJournalLines.debitPaise}), 0)` })
    .from(finJournalLines)
    .innerJoin(finJournalEntries, eq(finJournalLines.entryId, finJournalEntries.id))
    .where(and(eq(finJournalEntries.status, "POSTED"), inArray(finJournalLines.accountCode, LIABILITY_CODES), sql`to_char(${finJournalEntries.entryDate}::date, 'YYYY-MM') = ${month}`))
    .groupBy(finJournalLines.accountCode);
  const pending = await db.select().from(finAutoPostings).where(and(eq(finAutoPostings.status, "PENDING"), sql`to_char(${finAutoPostings.entryDate}::date, 'YYYY-MM') = ${month}`));
  const out = new Map<string, { accountCode: string; accountName: string; postedPaise: number; pendingPaise: number }>();
  for (const a of Object.values(GK_ACCOUNTS)) if (LIABILITY_CODES.includes(a.code)) out.set(a.code, { accountCode: a.code, accountName: a.name, postedPaise: 0, pendingPaise: 0 });
  for (const r of posted) if (out.has(r.code)) out.get(r.code)!.postedPaise = Number(r.net);
  for (const p of pending) for (const l of p.lines) if (out.has(l.accountCode)) out.get(l.accountCode)!.pendingPaise += l.creditPaise - l.debitPaise;
  return [...out.values()];
}
