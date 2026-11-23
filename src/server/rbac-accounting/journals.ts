/**
 * RBAC v2 Phase 3 — platform journal entries and financial periods (docs/rbac/03-phase3-accounting.md).
 *
 *   Accountant (JOURNAL_PREPARE)  drafts an entry → submits it to the CA
 *   CA (JOURNAL_APPROVE)          approves (the engine posts it) or rejects with a comment; never their own
 *   High value (rule rbacV2.highValueJournalPaise, default ₹50,000): a CA and then an admin (CA_THEN_ADMIN)
 *   CA (FIN_PERIOD_CLOSE)         closes / reopens a month; nothing is submitted or posted into a CLOSED month
 *
 * A POSTED entry is never edited (DB trigger fin_journal_entries_guard): it is corrected by a reversing entry,
 * which goes through the same approval. These books sit beside the existing finance ledger
 * (finance_ledger_entries), which they never write.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  finJournalEntries,
  finJournalLines,
  finPeriods,
  type FinJournalEntry,
  type FinJournalLine,
  type FinPeriod,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { requireFeatureForRole } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";
import { cancelApproval, registerApprovalHandler, submitApproval, type ApprovalActor } from "@/server/approvals/engine";

export const JOURNAL_APPROVAL = "JOURNAL_ENTRY";
export const JOURNAL_APPROVAL_HIGH_VALUE = "JOURNAL_ENTRY_HIGH_VALUE";

interface Actor {
  id: string;
  role: UserRole;
}

export interface JournalLineInput {
  accountCode: string;
  accountName: string;
  debitPaise?: number;
  creditPaise?: number;
  memo?: string | null;
}

export interface JournalInput {
  entryDate: string;
  narration: string;
  lines: JournalLineInput[];
}

/* ----------------------------------------------------------------- periods */

export const periodCodeOf = (isoDate: string): string => isoDate.slice(0, 7);

function periodBounds(code: string): { startsOn: string; endsOn: string } {
  const [y, m] = code.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { startsOn: `${code}-01`, endsOn: `${code}-${String(last).padStart(2, "0")}` };
}

/** The period row for a month, created OPEN on first use. */
export async function ensurePeriod(code: string): Promise<FinPeriod> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(code)) throw validationFailed("A period is a month (YYYY-MM).");
  await db.insert(finPeriods).values({ code, ...periodBounds(code) }).onConflictDoNothing();
  const [row] = await db.select().from(finPeriods).where(eq(finPeriods.code, code));
  return row;
}

async function assertPeriodOpen(code: string): Promise<void> {
  const period = await ensurePeriod(code);
  if (period.status === "CLOSED") throw conflict(`The period ${code} is closed. Ask the CA to reopen it, or date the entry in an open period.`);
}

export async function listPeriods(limit = 24): Promise<FinPeriod[]> {
  return db.select().from(finPeriods).orderBy(desc(finPeriods.code)).limit(limit);
}

export async function closePeriod(code: string, actor: Actor, note?: string | null): Promise<FinPeriod> {
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  if (!can(actor.role, PERMISSIONS.FIN_PERIOD_CLOSE)) throw forbidden("Only the CA closes a financial period.");
  await ensurePeriod(code);
  const [pending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(finJournalEntries)
    .where(and(eq(finJournalEntries.periodCode, code), eq(finJournalEntries.status, "SUBMITTED")));
  if ((pending?.n ?? 0) > 0) throw conflict(`${pending.n} entr${pending.n === 1 ? "y waits" : "ies wait"} for approval in ${code}. Decide them before closing.`);
  const [row] = await db
    .update(finPeriods)
    .set({ status: "CLOSED", closedBy: actor.id, closedAt: new Date(), note: note?.trim() || null, updatedAt: new Date() })
    .where(and(eq(finPeriods.code, code), eq(finPeriods.status, "OPEN")))
    .returning();
  if (!row) throw conflict(`The period ${code} is already closed.`);
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FIN_PERIOD_CLOSED, entityType: "fin_period", entityId: code, newValue: { note: row.note } });
  return row;
}

export async function reopenPeriod(code: string, actor: Actor, reason: string): Promise<FinPeriod> {
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  if (!can(actor.role, PERMISSIONS.FIN_PERIOD_CLOSE)) throw forbidden("Only the CA reopens a financial period.");
  if (reason.trim().length < 5) throw validationFailed("Say why the period is reopened.", { fields: { reason: "At least 5 characters." } });
  const [row] = await db
    .update(finPeriods)
    .set({ status: "OPEN", reopenedBy: actor.id, reopenedAt: new Date(), note: reason.trim(), updatedAt: new Date() })
    .where(and(eq(finPeriods.code, code), eq(finPeriods.status, "CLOSED")))
    .returning();
  if (!row) throw conflict(`The period ${code} is not closed.`);
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.FIN_PERIOD_REOPENED, entityType: "fin_period", entityId: code, newValue: { reason: reason.trim() } });
  return row;
}

/* ----------------------------------------------------------------- entries */

function validate(input: JournalInput): { lines: Required<Omit<JournalLineInput, "memo">>[] & { memo: string | null }[]; total: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.entryDate) || Number.isNaN(Date.parse(input.entryDate))) {
    throw validationFailed("Give the entry date (YYYY-MM-DD).", { fields: { entryDate: "A valid date." } });
  }
  const narration = input.narration.trim();
  if (narration.length < 3) throw validationFailed("Describe the entry.", { fields: { narration: "At least 3 characters." } });
  if (input.lines.length < 2) throw validationFailed("A journal entry needs at least two lines.");
  if (input.lines.length > 200) throw validationFailed("At most 200 lines in one entry.");
  let debit = 0;
  let credit = 0;
  const lines = input.lines.map((l, i) => {
    const d = l.debitPaise ?? 0;
    const c = l.creditPaise ?? 0;
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0) throw validationFailed(`Line ${i + 1}: amounts are whole paise, zero or more.`);
    if ((d > 0) === (c > 0)) throw validationFailed(`Line ${i + 1}: enter a debit or a credit, not both and not neither.`);
    const code = l.accountCode.trim();
    const name = l.accountName.trim();
    if (!code || !name) throw validationFailed(`Line ${i + 1}: give the account code and name.`);
    debit += d;
    credit += c;
    return { accountCode: code.slice(0, 40), accountName: name.slice(0, 200), debitPaise: d, creditPaise: c, memo: l.memo?.trim() || null };
  });
  if (debit !== credit) throw validationFailed(`The entry does not balance: debits ₹${(debit / 100).toFixed(2)}, credits ₹${(credit / 100).toFixed(2)}.`);
  return { lines: lines as never, total: debit };
}

async function assertPreparer(actor: Actor): Promise<void> {
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  if (!can(actor.role, PERMISSIONS.JOURNAL_PREPARE)) throw forbidden("Only an Accountant prepares journal entries.");
}

export async function createJournalDraft(input: JournalInput, actor: Actor, options: { reversesEntryId?: string } = {}): Promise<FinJournalEntry> {
  await assertPreparer(actor);
  const { lines, total } = validate(input);
  const periodCode = periodCodeOf(input.entryDate);
  await assertPeriodOpen(periodCode);
  return db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(finJournalEntries)
      .values({
        entryDate: input.entryDate,
        periodCode,
        narration: input.narration.trim(),
        totalPaise: total,
        preparedBy: actor.id,
        reversesEntryId: options.reversesEntryId ?? null,
      })
      .returning();
    await tx.insert(finJournalLines).values(lines.map((l, position) => ({ ...l, entryId: entry.id, position })));
    await recordAudit(
      { actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.JOURNAL_DRAFTED, entityType: "fin_journal_entry", entityId: entry.id, newValue: { entryNumber: entry.entryNumber, totalPaise: total } },
      tx,
    );
    return entry;
  });
}

/** The preparer edits a DRAFT, or a REJECTED entry (which becomes a DRAFT again). */
export async function updateJournalDraft(entryId: string, input: JournalInput, actor: Actor): Promise<FinJournalEntry> {
  await assertPreparer(actor);
  const { lines, total } = validate(input);
  const periodCode = periodCodeOf(input.entryDate);
  await assertPeriodOpen(periodCode);
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId)).for("update");
    if (!current) throw notFound("Journal entry");
    if (current.preparedBy !== actor.id) throw forbidden("Only the Accountant who prepared this entry can change it.");
    if (current.status !== "DRAFT" && current.status !== "REJECTED") throw conflict("Only a draft or a rejected entry can be changed.");
    await tx.delete(finJournalLines).where(eq(finJournalLines.entryId, entryId));
    await tx.insert(finJournalLines).values(lines.map((l, position) => ({ ...l, entryId, position })));
    const [entry] = await tx
      .update(finJournalEntries)
      .set({ entryDate: input.entryDate, periodCode, narration: input.narration.trim(), totalPaise: total, status: "DRAFT", rejectionComment: null, updatedAt: new Date() })
      .where(eq(finJournalEntries.id, entryId))
      .returning();
    return entry;
  });
}

/** Submit to the CA (or CA then admin, above the high-value threshold). */
export async function submitJournal(entryId: string, actor: Actor): Promise<FinJournalEntry> {
  await assertPreparer(actor);
  const [current] = await db.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId));
  if (!current) throw notFound("Journal entry");
  if (current.preparedBy !== actor.id) throw forbidden("Only the Accountant who prepared this entry can submit it.");
  if (current.status !== "DRAFT") throw conflict("Only a draft can be submitted.");
  await assertPeriodOpen(current.periodCode);
  const { highValueJournalPaise } = await getRule("rbacV2");
  const highValue = current.totalPaise >= highValueJournalPaise;
  const lines = await db.select().from(finJournalLines).where(eq(finJournalLines.entryId, entryId)).orderBy(asc(finJournalLines.position));
  const request = await submitApproval({
    type: highValue ? JOURNAL_APPROVAL_HIGH_VALUE : JOURNAL_APPROVAL,
    actor,
    subjectType: "fin_journal_entry",
    subjectId: entryId,
    title: `${current.entryNumber}: ${current.narration} (₹${(current.totalPaise / 100).toFixed(2)})`,
    reason: current.narration,
    payload: { entryId, entryNumber: current.entryNumber, totalPaise: current.totalPaise, highValue },
    items: lines.map((l) => ({
      entityType: "fin_journal_line",
      entityId: l.id,
      field: `${l.accountCode} ${l.accountName}`,
      proposedValue: { debitPaise: l.debitPaise, creditPaise: l.creditPaise, memo: l.memo },
    })),
  });
  const [entry] = await db
    .update(finJournalEntries)
    .set({ status: "SUBMITTED", approvalRequestId: request.id, updatedAt: new Date() })
    .where(and(eq(finJournalEntries.id, entryId), eq(finJournalEntries.status, "DRAFT")))
    .returning();
  if (!entry) throw conflict("This entry changed while it was being submitted.");
  return entry;
}

/** The preparer takes a SUBMITTED entry back to DRAFT (the open request is cancelled). */
export async function withdrawJournal(entryId: string, actor: Actor): Promise<FinJournalEntry> {
  await assertPreparer(actor);
  const [current] = await db.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId));
  if (!current) throw notFound("Journal entry");
  if (current.preparedBy !== actor.id) throw forbidden("Only the Accountant who prepared this entry can withdraw it.");
  if (current.status !== "SUBMITTED" || !current.approvalRequestId) throw conflict("Only a submitted entry can be withdrawn.");
  await cancelApproval(current.approvalRequestId, actor, "Withdrawn by the preparer");
  const [entry] = await db
    .update(finJournalEntries)
    .set({ status: "DRAFT", approvalRequestId: null, updatedAt: new Date() })
    .where(and(eq(finJournalEntries.id, entryId), eq(finJournalEntries.status, "SUBMITTED")))
    .returning();
  return entry;
}

/** A reversing draft of a POSTED entry: same lines, debit and credit swapped. Submitted like any entry. */
export async function createReversal(entryId: string, input: { entryDate: string; reason: string }, actor: Actor): Promise<FinJournalEntry> {
  await assertPreparer(actor);
  const [original] = await db.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId));
  if (!original) throw notFound("Journal entry");
  if (original.status !== "POSTED") throw conflict("Only a posted entry can be reversed.");
  const [open] = await db
    .select({ id: finJournalEntries.id })
    .from(finJournalEntries)
    .where(and(eq(finJournalEntries.reversesEntryId, entryId), inArray(finJournalEntries.status, ["DRAFT", "SUBMITTED", "REJECTED"])));
  if (open) throw conflict("A reversal of this entry is already being prepared.");
  if (input.reason.trim().length < 5) throw validationFailed("Say why the entry is reversed.", { fields: { reason: "At least 5 characters." } });
  const lines = await db.select().from(finJournalLines).where(eq(finJournalLines.entryId, entryId)).orderBy(asc(finJournalLines.position));
  return createJournalDraft(
    {
      entryDate: input.entryDate,
      narration: `Reversal of ${original.entryNumber}: ${input.reason.trim()}`,
      lines: lines.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, debitPaise: l.creditPaise, creditPaise: l.debitPaise, memo: l.memo })),
    },
    actor,
    { reversesEntryId: entryId },
  );
}

/** Engine apply: post the entry (the period must still be open). */
async function postEntry(entryId: string, decidedBy: ApprovalActor): Promise<void> {
  await db.transaction(async (tx) => {
    const [entry] = await tx.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId)).for("update");
    if (!entry) throw notFound("Journal entry");
    if (entry.status !== "SUBMITTED") throw conflict(`The entry is ${entry.status}, not waiting for approval.`);
    const [period] = await tx.select().from(finPeriods).where(eq(finPeriods.code, entry.periodCode));
    if (period?.status === "CLOSED") throw conflict(`The period ${entry.periodCode} was closed before this entry was approved.`);
    const now = new Date();
    await tx.update(finJournalEntries).set({ status: "POSTED", postedBy: decidedBy.id, postedAt: now, updatedAt: now }).where(eq(finJournalEntries.id, entryId));
    if (entry.reversesEntryId) {
      await tx
        .update(finJournalEntries)
        .set({ status: "REVERSED", reversedByEntryId: entryId, updatedAt: now })
        .where(and(eq(finJournalEntries.id, entry.reversesEntryId), eq(finJournalEntries.status, "POSTED")));
    }
    await recordAudit(
      { actorId: decidedBy.id, actorRole: decidedBy.role, action: AUDIT_ACTIONS.JOURNAL_POSTED, entityType: "fin_journal_entry", entityId: entryId, newValue: { entryNumber: entry.entryNumber, totalPaise: entry.totalPaise, reverses: entry.reversesEntryId } },
      tx,
    );
  });
}

for (const [type, checker] of [
  [JOURNAL_APPROVAL, "CA"],
  [JOURNAL_APPROVAL_HIGH_VALUE, "CA_THEN_ADMIN"],
] as const) {
  registerApprovalHandler({
    type,
    checker,
    async apply(context) {
      await postEntry(String(context.request.payload.entryId), context.decidedBy);
    },
    async onRejected(request) {
      await db
        .update(finJournalEntries)
        .set({ status: "REJECTED", rejectionComment: request.decisionComment, updatedAt: new Date() })
        .where(and(eq(finJournalEntries.id, String(request.payload.entryId)), eq(finJournalEntries.status, "SUBMITTED")));
    },
  });
}

/* ------------------------------------------------------------------- reads */

export async function listJournals(options: { periodCode?: string; status?: FinJournalEntry["status"]; limit?: number } = {}): Promise<FinJournalEntry[]> {
  const where = [];
  if (options.periodCode) where.push(eq(finJournalEntries.periodCode, options.periodCode));
  if (options.status) where.push(eq(finJournalEntries.status, options.status));
  return db
    .select()
    .from(finJournalEntries)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(finJournalEntries.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
}

export async function getJournal(entryId: string): Promise<{ entry: FinJournalEntry; lines: FinJournalLine[] }> {
  const [entry] = await db.select().from(finJournalEntries).where(eq(finJournalEntries.id, entryId));
  if (!entry) throw notFound("Journal entry");
  const lines = await db.select().from(finJournalLines).where(eq(finJournalLines.entryId, entryId)).orderBy(asc(finJournalLines.position));
  return { entry, lines };
}

export interface TrialBalanceRow {
  accountCode: string;
  accountName: string;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
}

/** Trial balance of posted entries (a reversed entry and its reversal both count, so they net to zero). */
export async function trialBalance(options: { fromPeriod?: string; toPeriod?: string } = {}): Promise<{ rows: TrialBalanceRow[]; totalDebitPaise: number; totalCreditPaise: number }> {
  const where = [inArray(finJournalEntries.status, ["POSTED", "REVERSED"])];
  if (options.fromPeriod) where.push(sql`${finJournalEntries.periodCode} >= ${options.fromPeriod}`);
  if (options.toPeriod) where.push(sql`${finJournalEntries.periodCode} <= ${options.toPeriod}`);
  const rows = await db
    .select({
      accountCode: finJournalLines.accountCode,
      accountName: sql<string>`min(${finJournalLines.accountName})`,
      debitPaise: sql<number>`coalesce(sum(${finJournalLines.debitPaise}), 0)::bigint`,
      creditPaise: sql<number>`coalesce(sum(${finJournalLines.creditPaise}), 0)::bigint`,
    })
    .from(finJournalLines)
    .innerJoin(finJournalEntries, eq(finJournalEntries.id, finJournalLines.entryId))
    .where(and(...where))
    .groupBy(finJournalLines.accountCode)
    .orderBy(finJournalLines.accountCode);
  const out = rows.map((r) => {
    const d = Number(r.debitPaise);
    const c = Number(r.creditPaise);
    return { accountCode: r.accountCode, accountName: r.accountName, debitPaise: d, creditPaise: c, balancePaise: d - c };
  });
  return {
    rows: out,
    totalDebitPaise: out.reduce((s, r) => s + r.debitPaise, 0),
    totalCreditPaise: out.reduce((s, r) => s + r.creditPaise, 0),
  };
}
