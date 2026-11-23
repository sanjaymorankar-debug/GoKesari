/**
 * RBAC v2 Phase 3 — bank-statement reconciliation (docs/rbac/03-phase3-accounting.md §Bank reconciliation).
 *
 *   Accountant (BANK_RECON_PREPARE)  imports a statement (CSV / Excel) for one bank account → lines are matched
 *                                    automatically where a bank reference (UTR) and the amount agree with a
 *                                    recorded payout or refund → the rest are matched by hand, or excluded with a
 *                                    reason (bank charges, interest …) → submits it to the CA
 *   CA                               signs it off (RECONCILED, final) or sends it back with a comment; never their own
 *
 * What a line can be matched to (all only read, never written):
 *   debits   shop payouts (payout_items, shop_settlements), rider payouts and bank transfers, dealer payouts
 *            (net of TDS), bank refunds to customers — each once it is PAID / SUCCESS — and posted journal entries
 *   credits  posted journal entries (gateway settlements, capital, interest … are recorded by a journal entry)
 * One record is matched to at most one bank line, across every statement (DB unique index).
 *
 * The other direction — payouts recorded as paid in the statement's dates that are not on the statement — is
 * listed by `unmatchedBookItems` for the Accountant to chase.
 */
import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  finBankStatementLines,
  finBankStatements,
  type BankLineSuggestion,
  type BankMatchKind,
  type FinBankStatement,
  type FinBankStatementLine,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { requireFeatureForRole } from "@/server/services/feature-flags";
import { cancelApproval, registerApprovalHandler, submitApproval, type ApprovalActor } from "@/server/approvals/engine";
import { parseBankStatementFile, referenceTokens, type ParsedBankFile } from "./bank-statement-file";

export const BANK_RECON_APPROVAL = "BANK_RECONCILIATION";

interface Actor {
  id: string;
  role: UserRole;
}

export const MATCH_KIND_LABELS: Record<BankMatchKind, string> = {
  SHOP_PAYOUT: "Shop payout",
  SHOP_SETTLEMENT: "Shop settlement",
  RIDER_PAYOUT: "Rider payout",
  RIDER_TRANSFER: "Rider bank transfer",
  DEALER_PAYOUT: "Dealer payout",
  BANK_REFUND: "Refund to customer's bank",
  JOURNAL: "Journal entry",
};

/** Kinds that are money leaving the bank. A journal entry can be either side. */
const DEBIT_KINDS: BankMatchKind[] = ["SHOP_PAYOUT", "SHOP_SETTLEMENT", "RIDER_PAYOUT", "RIDER_TRANSFER", "DEALER_PAYOUT", "BANK_REFUND", "JOURNAL"];
const CREDIT_KINDS: BankMatchKind[] = ["JOURNAL"];
const kindsFor = (line: Pick<FinBankStatementLine, "debitPaise">) => (line.debitPaise > 0 ? DEBIT_KINDS : CREDIT_KINDS);
const amountOf = (line: Pick<FinBankStatementLine, "debitPaise" | "creditPaise">) => (line.debitPaise > 0 ? line.debitPaise : line.creditPaise);

const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ------------------------------------------------------------ the books */

export interface BookRecord {
  kind: BankMatchKind;
  id: string;
  reference: string | null;
  amountPaise: number;
  /** IST date it was paid / posted (YYYY-MM-DD). */
  date: string | null;
  label: string;
  /** Matched to a bank line already (line id), or null. */
  matchedLineId: string | null;
}

/** Every recorded payment a bank line can be matched to, as one relation. */
const BOOK = sql`
  SELECT 'SHOP_PAYOUT'::text AS kind, pi.id, pi.utr AS reference, pi.amount_paise::bigint AS amount_paise, pi.paid_at AS at,
         'Shop payout to ' || coalesce(s.name, 'shop') AS label
    FROM payout_items pi LEFT JOIN shops s ON s.id = pi.shop_id
   WHERE pi.status = 'PAID'
  UNION ALL
  SELECT 'SHOP_SETTLEMENT', ss.id, ss.payment_reference, ss.net_payable_paise::bigint, ss.paid_at,
         'Settlement to ' || coalesce(s.name, 'shop') || ' (' || to_char(ss.period_start, 'DD-Mon') || ' to ' || to_char(ss.period_end, 'DD-Mon-YYYY') || ')'
    FROM shop_settlements ss LEFT JOIN shops s ON s.id = ss.shop_id
   WHERE ss.status = 'PAID'
  UNION ALL
  SELECT 'RIDER_PAYOUT', rp.id, rp.payment_reference, rp.amount_paise::bigint, rp.paid_at,
         'Rider payout (' || to_char(rp.period_start, 'DD-Mon') || ' to ' || to_char(rp.period_end, 'DD-Mon-YYYY') || ')'
    FROM rider_payouts rp
   WHERE rp.status = 'PAID'
  UNION ALL
  SELECT 'RIDER_TRANSFER', rt.id, rt.utr, rt.net_paise::bigint, rt.completed_at, 'Rider bank transfer (' || rt.kind || ')'
    FROM rider_bank_transfers rt
   WHERE rt.status = 'SUCCESS'
  UNION ALL
  SELECT 'DEALER_PAYOUT', dp.id, dp.payment_reference, (dp.total_paise - dp.tds_paise)::bigint, dp.paid_at,
         'Dealer payout' || coalesce(' ' || dp.period_month, '') || ' (net of TDS)'
    FROM dealer_payout_batches dp
   WHERE dp.status = 'PAID'
  UNION ALL
  SELECT 'BANK_REFUND', br.id, br.payout_reference, br.amount_paise::bigint, br.paid_at, 'Refund to ' || coalesce(br.account_holder_name, 'customer') || '''s bank'
    FROM bank_refund_requests br
   WHERE br.status = 'PAID'
  UNION ALL
  SELECT 'JOURNAL', je.id, je.entry_number, je.total_paise::bigint, (je.entry_date::timestamp AT TIME ZONE 'Asia/Kolkata'),
         je.entry_number || ': ' || je.narration
    FROM fin_journal_entries je
   WHERE je.status IN ('POSTED', 'REVERSED')
`;

interface BookQuery {
  kinds?: BankMatchKind[];
  ids?: string[];
  references?: string[];
  amounts?: number[];
  from?: string;
  to?: string;
  unmatchedOnly?: boolean;
  search?: string;
  limit?: number;
}

export async function findBookRecords(q: BookQuery): Promise<BookRecord[]> {
  const where: SQL[] = [];
  if (q.kinds?.length) where.push(sql`b.kind IN (${sql.join(q.kinds.map((k) => sql`${k}`), sql`, `)})`);
  if (q.ids?.length) where.push(sql`b.id IN (${sql.join(q.ids.map((i) => sql`${i}::uuid`), sql`, `)})`);
  if (q.references?.length) where.push(sql`upper(trim(b.reference)) IN (${sql.join(q.references.map((r) => sql`${r}`), sql`, `)})`);
  if (q.amounts?.length) where.push(sql`b.amount_paise IN (${sql.join(q.amounts.map((a) => sql`${a}::bigint`), sql`, `)})`);
  if (q.from) where.push(sql`(b.at AT TIME ZONE 'Asia/Kolkata')::date >= ${q.from}::date`);
  if (q.to) where.push(sql`(b.at AT TIME ZONE 'Asia/Kolkata')::date <= ${q.to}::date`);
  if (q.search) {
    const like = `%${q.search.replace(/[%_\\]/g, "\\$&")}%`;
    where.push(sql`(b.reference ILIKE ${like} OR b.label ILIKE ${like})`);
  }
  if (q.unmatchedOnly) where.push(sql`m.id IS NULL`);
  const rows = (await db.execute(sql`
    WITH book AS (${BOOK})
    SELECT b.kind, b.id::text AS id, b.reference, b.amount_paise, to_char(b.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS date,
           b.label, m.id::text AS matched_line_id
      FROM book b
      LEFT JOIN fin_bank_statement_lines m ON m.status = 'MATCHED' AND m.match_kind = b.kind AND m.match_id = b.id
     ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
     ORDER BY b.at DESC NULLS LAST
     LIMIT ${Math.min(q.limit ?? 500, 5000)}`)) as unknown as {
    kind: BankMatchKind;
    id: string;
    reference: string | null;
    amount_paise: string | number;
    date: string | null;
    label: string;
    matched_line_id: string | null;
  }[];
  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    reference: r.reference,
    amountPaise: Number(r.amount_paise),
    date: r.date,
    label: r.label,
    matchedLineId: r.matched_line_id,
  }));
}

/* ------------------------------------------------------------- guards */

async function assertPreparer(actor: Actor): Promise<void> {
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  if (!can(actor.role, PERMISSIONS.BANK_RECON_PREPARE)) throw forbidden("Only an Accountant reconciles bank statements.");
}

export async function assertBankReconViewer(actor: Actor): Promise<void> {
  await requireFeatureForRole("rbac_v2_accounting", actor.role);
  if (!can(actor.role, PERMISSIONS.BANK_RECON_PREPARE) && !can(actor.role, PERMISSIONS.BANK_RECON_SIGNOFF)) {
    throw forbidden("Bank reconciliation is for the Accountant and the CA.");
  }
}

async function loadOpenStatement(statementId: string): Promise<FinBankStatement> {
  const [statement] = await db.select().from(finBankStatements).where(eq(finBankStatements.id, statementId));
  if (!statement) throw notFound("Bank statement");
  if (statement.status !== "OPEN") {
    throw conflict(statement.status === "SUBMITTED" ? "This statement is with the CA. Withdraw it to change it." : "This statement is reconciled and final.");
  }
  return statement;
}

async function loadLine(lineId: string): Promise<{ line: FinBankStatementLine; statement: FinBankStatement }> {
  const [line] = await db.select().from(finBankStatementLines).where(eq(finBankStatementLines.id, lineId));
  if (!line) throw notFound("Bank statement line");
  const statement = await loadOpenStatement(line.statementId);
  return { line, statement };
}

/* -------------------------------------------------------------- import */

export interface ImportInput {
  accountLabel: string;
  file: Buffer;
  filename: string;
}

export function checkAccountLabel(label: string): string {
  const t = label.trim().replace(/\s+/g, " ");
  if (t.length < 3 || t.length > 80) throw validationFailed("Name the bank account, e.g. “HDFC current ••1234”.", { fields: { accountLabel: "3 to 80 characters." } });
  if (/\d{7,}/.test(t.replace(/\s/g, ""))) {
    throw validationFailed("Use only the last 4 digits of the account number in its name, e.g. “HDFC current ••1234”.", { fields: { accountLabel: "No full account number." } });
  }
  return t;
}

/** Reads the file without saving anything: lines, problems, warnings, totals. */
export async function previewStatement(input: Pick<ImportInput, "file" | "filename">, actor: Actor): Promise<ParsedBankFile> {
  await assertPreparer(actor);
  checkFile(input);
  try {
    return await parseBankStatementFile(input.file, input.filename);
  } catch (e) {
    throw validationFailed(e instanceof Error ? e.message : String(e));
  }
}

function checkFile(input: Pick<ImportInput, "file" | "filename">): void {
  if (!/\.(csv|xlsx)$/i.test(input.filename)) throw validationFailed("Upload the bank statement as .csv or .xlsx (save an .xls or PDF statement as one of these first).");
  if (input.file.length === 0) throw validationFailed("The file is empty.");
  if (input.file.length > 10_000_000) throw validationFailed("The file is larger than 10 MB. Split the statement by month.");
}

export interface ImportResult {
  statement: FinBankStatement;
  matched: number;
  suggested: number;
  unmatched: number;
}

export async function importStatement(input: ImportInput, actor: Actor): Promise<ImportResult> {
  await assertPreparer(actor);
  const accountLabel = checkAccountLabel(input.accountLabel);
  checkFile(input);
  let parsed: ParsedBankFile;
  try {
    parsed = await parseBankStatementFile(input.file, input.filename);
  } catch (e) {
    throw validationFailed(e instanceof Error ? e.message : String(e));
  }
  if (parsed.errors.length) {
    throw validationFailed(
      `${parsed.errors.length} row${parsed.errors.length === 1 ? " has a problem" : "s have problems"}; nothing was imported. Fix the file and upload it again.`,
      { rows: parsed.errors.slice(0, 200) },
    );
  }
  if (!parsed.lines.length || !parsed.periodFrom || !parsed.periodTo) throw validationFailed("The file has no transactions under the header.");

  const sha = createHash("sha256").update(input.file).digest("hex");
  const [same] = await db.select({ n: finBankStatements.statementNumber }).from(finBankStatements).where(eq(finBankStatements.fileSha256, sha));
  if (same) throw conflict(`This file was already imported as ${same.n}.`);
  const [overlap] = await db
    .select({ n: finBankStatements.statementNumber, from: finBankStatements.periodFrom, to: finBankStatements.periodTo })
    .from(finBankStatements)
    .where(
      and(
        sql`lower(${finBankStatements.accountLabel}) = lower(${accountLabel})`,
        sql`${finBankStatements.periodFrom} <= ${parsed.periodTo}::date`,
        sql`${finBankStatements.periodTo} >= ${parsed.periodFrom}::date`,
      ),
    )
    .limit(1);
  if (overlap) {
    throw conflict(`${overlap.n} already covers ${overlap.from} to ${overlap.to} for this account. Import only the dates after it, or delete ${overlap.n} first if it is still open.`);
  }

  const statement = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(finBankStatements)
      .values({
        accountLabel,
        periodFrom: parsed.periodFrom!,
        periodTo: parsed.periodTo!,
        openingBalancePaise: parsed.openingBalancePaise,
        closingBalancePaise: parsed.closingBalancePaise,
        totalDebitPaise: parsed.totalDebitPaise,
        totalCreditPaise: parsed.totalCreditPaise,
        lineCount: parsed.lines.length,
        fileName: input.filename.slice(0, 200),
        fileSha256: sha,
        warnings: parsed.warnings,
        uploadedBy: actor.id,
      })
      .returning();
    for (let i = 0; i < parsed.lines.length; i += 1000) {
      await tx.insert(finBankStatementLines).values(
        parsed.lines.slice(i, i + 1000).map((l) => ({
          statementId: row.id,
          lineNo: l.lineNo,
          txnDate: l.txnDate,
          valueDate: l.valueDate,
          description: l.description,
          reference: l.reference,
          debitPaise: l.debitPaise,
          creditPaise: l.creditPaise,
          balancePaise: l.balancePaise,
        })),
      );
    }
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_STATEMENT_IMPORTED,
        entityType: "fin_bank_statement",
        entityId: row.id,
        newValue: { statementNumber: row.statementNumber, accountLabel, from: row.periodFrom, to: row.periodTo, lines: row.lineCount },
      },
      tx,
    );
    return row;
  });
  const summary = await autoMatchStatement(statement.id);
  return { statement, ...summary };
}

/* ---------------------------------------------------------- auto match */

const shiftDate = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const AMOUNT_WINDOW_DAYS = 4;

/**
 * Matches the open statement's UNMATCHED lines where it is certain: one unclaimed record whose bank reference
 * appears on the line and whose amount is the same. Otherwise leaves a suggestion (reference agrees but amount
 * differs; or exactly one unclaimed record of the same amount paid within 4 days). Re-runnable.
 */
export async function autoMatchStatement(statementId: string, actor?: Actor): Promise<{ matched: number; suggested: number; unmatched: number }> {
  if (actor) await assertPreparer(actor);
  const statement = await loadOpenStatement(statementId);
  const lines = await db
    .select()
    .from(finBankStatementLines)
    .where(and(eq(finBankStatementLines.statementId, statementId), eq(finBankStatementLines.status, "UNMATCHED")))
    .orderBy(asc(finBankStatementLines.lineNo));
  if (!lines.length) return { matched: 0, suggested: 0, unmatched: 0 };

  const tokensOf = new Map(lines.map((l) => [l.id, referenceTokens(l.reference, l.description)]));
  const allTokens = [...new Set([...tokensOf.values()].flat())];
  const byRef = new Map<string, BookRecord[]>();
  for (let i = 0; i < allTokens.length; i += 1000) {
    for (const r of await findBookRecords({ references: allTokens.slice(i, i + 1000), limit: 5000 })) {
      const key = (r.reference ?? "").trim().toUpperCase();
      byRef.set(key, [...(byRef.get(key) ?? []), r]);
    }
  }
  const amounts = [...new Set(lines.map(amountOf))];
  const byAmount = new Map<number, BookRecord[]>();
  for (let i = 0; i < amounts.length; i += 1000) {
    const records = await findBookRecords({
      amounts: amounts.slice(i, i + 1000),
      from: shiftDate(statement.periodFrom, -AMOUNT_WINDOW_DAYS),
      to: shiftDate(statement.periodTo, AMOUNT_WINDOW_DAYS),
      unmatchedOnly: true,
      limit: 5000,
    });
    for (const r of records) byAmount.set(r.amountPaise, [...(byAmount.get(r.amountPaise) ?? []), r]);
  }

  const claimed = new Set<string>();
  const updates: { id: string; set: Partial<FinBankStatementLine> }[] = [];
  let matched = 0;
  let suggested = 0;
  for (const line of lines) {
    const kinds = kindsFor(line);
    const amount = amountOf(line);
    const free = (r: BookRecord) => kinds.includes(r.kind) && !r.matchedLineId && !claimed.has(`${r.kind}:${r.id}`);
    const refHits = (tokensOf.get(line.id) ?? []).flatMap((t) => byRef.get(t) ?? []).filter(free);
    const uniqueRefHits = [...new Map(refHits.map((r) => [`${r.kind}:${r.id}`, r])).values()];
    const exact = uniqueRefHits.filter((r) => r.amountPaise === amount);
    let suggestion: BankLineSuggestion | null = null;
    if (exact.length === 1) {
      claimed.add(`${exact[0].kind}:${exact[0].id}`);
      updates.push({ id: line.id, set: { status: "MATCHED", matchKind: exact[0].kind, matchId: exact[0].id, matchMethod: "AUTO", matchedAt: new Date(), suggestion: null } });
      matched += 1;
      continue;
    }
    if (exact.length > 1) {
      suggestion = { ...pick(exact[0]), why: `${exact.length} records carry this reference and amount; pick the right one.` };
    } else if (uniqueRefHits.length) {
      suggestion = { ...pick(uniqueRefHits[0]), why: `The reference agrees but the amount differs: bank ${rupees(amount)}, record ${rupees(uniqueRefHits[0].amountPaise)}.` };
    } else {
      const near = (byAmount.get(amount) ?? []).filter(
        (r) => free(r) && r.date && r.date >= shiftDate(line.txnDate, -AMOUNT_WINDOW_DAYS) && r.date <= shiftDate(line.txnDate, AMOUNT_WINDOW_DAYS),
      );
      if (near.length === 1) suggestion = { ...pick(near[0]), why: `Same amount, recorded on ${near[0].date}; no bank reference to confirm it.` };
    }
    if (suggestion) suggested += 1;
    if (suggestion || line.suggestion) updates.push({ id: line.id, set: { suggestion } });
  }

  if (updates.length) {
    await db.transaction(async (tx) => {
      for (const u of updates) {
        await tx
          .update(finBankStatementLines)
          .set(u.set)
          .where(and(eq(finBankStatementLines.id, u.id), eq(finBankStatementLines.status, "UNMATCHED")));
      }
    });
  }
  return { matched, suggested, unmatched: lines.length - matched };
}

const pick = (r: BookRecord): Omit<BankLineSuggestion, "why"> => ({ kind: r.kind, id: r.id, label: r.label, amountPaise: r.amountPaise });

/* ------------------------------------------------------- manual match */

/** Records worth offering for one line: same amount within 10 days, or a search by reference / name. */
export async function candidatesForLine(lineId: string, options: { search?: string } = {}, actor: Actor): Promise<BookRecord[]> {
  await assertBankReconViewer(actor);
  const [line] = await db.select().from(finBankStatementLines).where(eq(finBankStatementLines.id, lineId));
  if (!line) throw notFound("Bank statement line");
  const search = options.search?.trim();
  if (search) {
    if (search.length < 3) throw validationFailed("Search with at least 3 characters.");
    return findBookRecords({ kinds: kindsFor(line), search: search.slice(0, 60), unmatchedOnly: true, limit: 50 });
  }
  return findBookRecords({
    kinds: kindsFor(line),
    amounts: [amountOf(line)],
    from: shiftDate(line.txnDate, -10),
    to: shiftDate(line.txnDate, 10),
    unmatchedOnly: true,
    limit: 50,
  });
}

export async function matchLine(lineId: string, target: { kind: BankMatchKind; id: string; note?: string | null }, actor: Actor): Promise<FinBankStatementLine> {
  await assertPreparer(actor);
  const { line } = await loadLine(lineId);
  if (line.status !== "UNMATCHED") throw conflict("This line is already matched or excluded. Undo that first.");
  if (!kindsFor(line).includes(target.kind)) {
    throw validationFailed(line.creditPaise > 0 ? "Money received is matched to a posted journal entry (record the receipt as a journal first)." : "That kind of record cannot be matched to this line.");
  }
  const [record] = await findBookRecords({ kinds: [target.kind], ids: [target.id], limit: 1 });
  if (!record) throw notFound(`${MATCH_KIND_LABELS[target.kind]} (it must be marked paid, or the journal entry posted)`);
  if (record.matchedLineId) {
    const [other] = await db
      .select({ lineNo: finBankStatementLines.lineNo, n: finBankStatements.statementNumber })
      .from(finBankStatementLines)
      .innerJoin(finBankStatements, eq(finBankStatements.id, finBankStatementLines.statementId))
      .where(eq(finBankStatementLines.id, record.matchedLineId));
    throw conflict(`This ${MATCH_KIND_LABELS[target.kind].toLowerCase()} is already matched to line ${other?.lineNo} of ${other?.n}.`);
  }
  const amount = amountOf(line);
  if (record.amountPaise !== amount) {
    throw validationFailed(
      `The amounts differ: bank ${rupees(amount)}, record ${rupees(record.amountPaise)}. Record the difference with a journal entry and match the line to it, or exclude the line with a reason.`,
    );
  }
  try {
    const [row] = await db
      .update(finBankStatementLines)
      .set({ status: "MATCHED", matchKind: target.kind, matchId: target.id, matchMethod: "MANUAL", matchedBy: actor.id, matchedAt: new Date(), note: target.note?.trim() || null, suggestion: null })
      .where(and(eq(finBankStatementLines.id, lineId), eq(finBankStatementLines.status, "UNMATCHED")))
      .returning();
    if (!row) throw conflict("This line changed meanwhile. Reload and try again.");
    await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.BANK_LINE_MATCHED, entityType: "fin_bank_statement_line", entityId: lineId, newValue: { kind: target.kind, id: target.id } });
    return row;
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict("That record was just matched to another line.");
    throw e;
  }
}

export async function excludeLine(lineId: string, reason: string, actor: Actor): Promise<FinBankStatementLine> {
  await assertPreparer(actor);
  const note = reason.trim();
  if (note.length < 5) throw validationFailed("Say why this line needs no match (e.g. bank charges, interest).", { fields: { reason: "At least 5 characters." } });
  const { line } = await loadLine(lineId);
  if (line.status !== "UNMATCHED") throw conflict("This line is already matched or excluded. Undo that first.");
  const [row] = await db
    .update(finBankStatementLines)
    .set({ status: "EXCLUDED", note: note.slice(0, 500), matchedBy: actor.id, matchedAt: new Date(), matchMethod: "MANUAL", suggestion: null })
    .where(and(eq(finBankStatementLines.id, lineId), eq(finBankStatementLines.status, "UNMATCHED")))
    .returning();
  if (!row) throw conflict("This line changed meanwhile. Reload and try again.");
  await recordAudit({ actorId: actor.id, actorRole: actor.role, action: AUDIT_ACTIONS.BANK_LINE_EXCLUDED, entityType: "fin_bank_statement_line", entityId: lineId, newValue: { reason: note } });
  return row;
}

/** Back to UNMATCHED (from MATCHED or EXCLUDED), while the statement is open. */
export async function unmatchLine(lineId: string, actor: Actor): Promise<FinBankStatementLine> {
  await assertPreparer(actor);
  const { line } = await loadLine(lineId);
  if (line.status === "UNMATCHED") return line;
  const [row] = await db
    .update(finBankStatementLines)
    .set({ status: "UNMATCHED", matchKind: null, matchId: null, matchMethod: null, matchedBy: null, matchedAt: null, note: null })
    .where(eq(finBankStatementLines.id, lineId))
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.BANK_LINE_UNMATCHED,
    entityType: "fin_bank_statement_line",
    entityId: lineId,
    previousValue: { status: line.status, kind: line.matchKind, id: line.matchId, note: line.note },
  });
  return row;
}

/** Accepts the line's suggestion (the same checks as a manual match). */
export async function acceptSuggestion(lineId: string, actor: Actor): Promise<FinBankStatementLine> {
  const [line] = await db.select().from(finBankStatementLines).where(eq(finBankStatementLines.id, lineId));
  if (!line) throw notFound("Bank statement line");
  if (!line.suggestion) throw conflict("This line has no suggestion.");
  return matchLine(lineId, { kind: line.suggestion.kind, id: line.suggestion.id }, actor);
}

function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e; cur; cur = (cur as { cause?: unknown }).cause) {
    if ((cur as { code?: string }).code === "23505") return true;
  }
  return false;
}

/* ---------------------------------------------------------- sign-off */

export interface StatementCheck {
  unmatched: number;
  matched: number;
  excluded: number;
  /** opening + credits − debits − closing; 0 when it agrees, null when the file gave no balances. */
  balanceDifferencePaise: number | null;
}

export async function checkStatement(statementId: string): Promise<StatementCheck> {
  const [statement] = await db.select().from(finBankStatements).where(eq(finBankStatements.id, statementId));
  if (!statement) throw notFound("Bank statement");
  const counts = await db
    .select({ status: finBankStatementLines.status, n: sql<number>`count(*)::int` })
    .from(finBankStatementLines)
    .where(eq(finBankStatementLines.statementId, statementId))
    .groupBy(finBankStatementLines.status);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const balanceDifferencePaise =
    statement.openingBalancePaise != null && statement.closingBalancePaise != null
      ? statement.openingBalancePaise + statement.totalCreditPaise - statement.totalDebitPaise - statement.closingBalancePaise
      : null;
  return { unmatched: n("UNMATCHED"), matched: n("MATCHED"), excluded: n("EXCLUDED"), balanceDifferencePaise };
}

export async function submitStatement(statementId: string, actor: Actor): Promise<FinBankStatement> {
  await assertPreparer(actor);
  const statement = await loadOpenStatement(statementId);
  if (statement.uploadedBy !== actor.id) throw forbidden("Only the Accountant who imported this statement submits it.");
  const check = await checkStatement(statementId);
  if (check.unmatched > 0) throw conflict(`${check.unmatched} line${check.unmatched === 1 ? " is" : "s are"} still unmatched. Match or exclude every line first.`);
  if (check.balanceDifferencePaise) {
    throw conflict(`Opening balance + credits − debits differs from the closing balance by ${rupees(Math.abs(check.balanceDifferencePaise))}. A line is missing from the file.`);
  }
  const byKind = await db
    .select({ kind: finBankStatementLines.matchKind, status: finBankStatementLines.status, n: sql<number>`count(*)::int`, paise: sql<number>`sum(${finBankStatementLines.debitPaise} + ${finBankStatementLines.creditPaise})::bigint` })
    .from(finBankStatementLines)
    .where(eq(finBankStatementLines.statementId, statementId))
    .groupBy(finBankStatementLines.matchKind, finBankStatementLines.status);
  const request = await submitApproval({
    type: BANK_RECON_APPROVAL,
    actor,
    subjectType: "fin_bank_statement",
    subjectId: statementId,
    title: `${statement.statementNumber}: ${statement.accountLabel}, ${statement.periodFrom} to ${statement.periodTo} (${statement.lineCount} lines)`,
    reason: `Bank statement reconciled: ${check.matched} matched, ${check.excluded} excluded.`,
    payload: { statementId, statementNumber: statement.statementNumber, ...check },
    items: byKind.map((k) => ({
      entityType: "fin_bank_statement",
      entityId: statementId,
      field: k.status === "EXCLUDED" ? "Excluded (no record needed)" : MATCH_KIND_LABELS[k.kind as BankMatchKind] ?? String(k.kind),
      proposedValue: { lines: k.n, amountPaise: Number(k.paise) },
    })),
  });
  const [row] = await db
    .update(finBankStatements)
    .set({ status: "SUBMITTED", approvalRequestId: request.id, rejectionComment: null, updatedAt: new Date() })
    .where(and(eq(finBankStatements.id, statementId), eq(finBankStatements.status, "OPEN")))
    .returning();
  if (!row) throw conflict("This statement changed while it was being submitted.");
  return row;
}

export async function withdrawStatement(statementId: string, actor: Actor): Promise<FinBankStatement> {
  await assertPreparer(actor);
  const [statement] = await db.select().from(finBankStatements).where(eq(finBankStatements.id, statementId));
  if (!statement) throw notFound("Bank statement");
  if (statement.uploadedBy !== actor.id) throw forbidden("Only the Accountant who submitted this statement can withdraw it.");
  if (statement.status !== "SUBMITTED" || !statement.approvalRequestId) throw conflict("Only a submitted statement can be withdrawn.");
  await cancelApproval(statement.approvalRequestId, actor, "Withdrawn by the Accountant");
  const [row] = await db
    .update(finBankStatements)
    .set({ status: "OPEN", approvalRequestId: null, updatedAt: new Date() })
    .where(and(eq(finBankStatements.id, statementId), eq(finBankStatements.status, "SUBMITTED")))
    .returning();
  return row;
}

/** An OPEN statement imported by mistake. Its matches are released with it. */
export async function deleteStatement(statementId: string, actor: Actor): Promise<void> {
  await assertPreparer(actor);
  const statement = await loadOpenStatement(statementId);
  if (statement.uploadedBy !== actor.id) throw forbidden("Only the Accountant who imported this statement can delete it.");
  await db.transaction(async (tx) => {
    await tx.delete(finBankStatements).where(and(eq(finBankStatements.id, statementId), eq(finBankStatements.status, "OPEN")));
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.BANK_STATEMENT_DELETED,
        entityType: "fin_bank_statement",
        entityId: statementId,
        previousValue: { statementNumber: statement.statementNumber, accountLabel: statement.accountLabel, from: statement.periodFrom, to: statement.periodTo, lines: statement.lineCount },
      },
      tx,
    );
  });
}

registerApprovalHandler({
  type: BANK_RECON_APPROVAL,
  checker: "CA",
  async apply(context) {
    const statementId = String(context.request.payload.statementId);
    const decidedBy: ApprovalActor = context.decidedBy;
    await db.transaction(async (tx) => {
      const [row] = await tx
        .update(finBankStatements)
        .set({ status: "RECONCILED", signedOffBy: decidedBy.id, signedOffAt: new Date(), updatedAt: new Date() })
        .where(and(eq(finBankStatements.id, statementId), eq(finBankStatements.status, "SUBMITTED")))
        .returning();
      if (!row) throw conflict("The statement is no longer waiting for sign-off.");
      await recordAudit(
        { actorId: decidedBy.id, actorRole: decidedBy.role, action: AUDIT_ACTIONS.BANK_STATEMENT_RECONCILED, entityType: "fin_bank_statement", entityId: statementId, newValue: { statementNumber: row.statementNumber } },
        tx,
      );
    });
  },
  async onRejected(request) {
    await db
      .update(finBankStatements)
      .set({ status: "OPEN", approvalRequestId: null, rejectionComment: request.decisionComment, updatedAt: new Date() })
      .where(and(eq(finBankStatements.id, String(request.payload.statementId)), eq(finBankStatements.status, "SUBMITTED")));
  },
});

/* --------------------------------------------------------------- reads */

export async function listStatements(limit = 100): Promise<FinBankStatement[]> {
  return db.select().from(finBankStatements).orderBy(desc(finBankStatements.periodTo), desc(finBankStatements.createdAt)).limit(Math.min(limit, 500));
}

export interface StatementView {
  statement: FinBankStatement;
  lines: (FinBankStatementLine & { matchLabel: string | null })[];
  check: StatementCheck;
}

export async function getStatement(statementId: string, options: { status?: FinBankStatementLine["status"] } = {}): Promise<StatementView> {
  const [statement] = await db.select().from(finBankStatements).where(eq(finBankStatements.id, statementId));
  if (!statement) throw notFound("Bank statement");
  const where = [eq(finBankStatementLines.statementId, statementId)];
  if (options.status) where.push(eq(finBankStatementLines.status, options.status));
  const lines = await db.select().from(finBankStatementLines).where(and(...where)).orderBy(asc(finBankStatementLines.lineNo)).limit(5000);
  const matched = lines.filter((l) => l.status === "MATCHED" && l.matchKind && l.matchId);
  const labels = new Map<string, string>();
  const kinds = [...new Set(matched.map((l) => l.matchKind!))];
  for (const kind of kinds) {
    const ids = matched.filter((l) => l.matchKind === kind).map((l) => l.matchId!);
    for (let i = 0; i < ids.length; i += 1000) {
      for (const r of await findBookRecords({ kinds: [kind], ids: ids.slice(i, i + 1000), limit: 5000 })) labels.set(`${r.kind}:${r.id}`, r.label);
    }
  }
  return {
    statement,
    lines: lines.map((l) => ({ ...l, matchLabel: l.matchKind && l.matchId ? (labels.get(`${l.matchKind}:${l.matchId}`) ?? MATCH_KIND_LABELS[l.matchKind]) : null })),
    check: await checkStatement(statementId),
  };
}

/** Payouts and refunds recorded as paid within the statement's dates that no bank line is matched to. */
export async function unmatchedBookItems(statementId: string): Promise<BookRecord[]> {
  const [statement] = await db.select().from(finBankStatements).where(eq(finBankStatements.id, statementId));
  if (!statement) throw notFound("Bank statement");
  return findBookRecords({
    kinds: DEBIT_KINDS.filter((k) => k !== "JOURNAL"),
    from: statement.periodFrom,
    to: statement.periodTo,
    unmatchedOnly: true,
    limit: 1000,
  });
}

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The statement with each line's match, for the CA's file. */
export async function statementCsv(statementId: string): Promise<{ filename: string; csv: string }> {
  const view = await getStatement(statementId);
  const head = ["line", "date", "value_date", "description", "reference", "debit_inr", "credit_inr", "balance_inr", "status", "matched_to", "note"];
  const r2 = (p: number | null) => (p == null ? "" : (p / 100).toFixed(2));
  const rows = view.lines.map((l) =>
    [l.lineNo, l.txnDate, l.valueDate ?? "", l.description, l.reference ?? "", l.debitPaise ? r2(l.debitPaise) : "", l.creditPaise ? r2(l.creditPaise) : "", r2(l.balancePaise), l.status, l.matchLabel ?? "", l.note ?? ""]
      .map(csvCell)
      .join(","),
  );
  return { filename: `${view.statement.statementNumber}-reconciliation.csv`, csv: [head.join(","), ...rows].join("\n") + "\n" };
}

export async function countOpenStatements(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(finBankStatements).where(inArray(finBankStatements.status, ["OPEN", "SUBMITTED"]));
  return row?.n ?? 0;
}
