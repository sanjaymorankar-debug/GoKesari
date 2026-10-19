/**
 * The shop's books (docs/inventory-accounting-2026-10, Part 2): balanced
 * vouchers in acc_ledger_entries, the settings row, document counters and
 * the change log. Append-only: a correction posts a reversing voucher.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import type { BookAccount, VoucherType } from "@/lib/accounts/constants";
import { db, type DbClient } from "@/server/db";
import { accChangeLog, accCounters, accLedgerEntries, invSettings, type AccLedgerEntry, type InvSettings } from "@/server/db/schema";
import { upsertRow } from "@/server/db/split/upsert";

export interface Leg {
  account: BookAccount;
  debitPaise?: number;
  creditPaise?: number;
  partyId?: string | null;
  subAccount?: string | null;
}

export interface VoucherInput {
  shopId: string;
  voucherType: VoucherType;
  entryDate: string;
  sourceType: AccLedgerEntry["sourceType"];
  sourceId: string;
  docRef?: string | null;
  narration?: string | null;
  reversesVoucherId?: string | null;
  createdBy: string | null;
  legs: Leg[];
}

/** Writes one balanced voucher. Zero legs are dropped; an unbalanced voucher is a bug and throws. */
export async function postVoucher(input: VoucherInput, client: DbClient): Promise<string> {
  const legs = input.legs
    .map((l) => ({ ...l, debitPaise: l.debitPaise ?? 0, creditPaise: l.creditPaise ?? 0 }))
    // A negative amount on one side is the same amount on the other side.
    .map((l) => ({
      ...l,
      debitPaise: (l.debitPaise < 0 ? 0 : l.debitPaise) + (l.creditPaise < 0 ? -l.creditPaise : 0),
      creditPaise: (l.creditPaise < 0 ? 0 : l.creditPaise) + (l.debitPaise < 0 ? -l.debitPaise : 0),
    }))
    .filter((l) => l.debitPaise !== 0 || l.creditPaise !== 0);
  const dr = legs.reduce((n, l) => n + l.debitPaise, 0);
  const cr = legs.reduce((n, l) => n + l.creditPaise, 0);
  if (dr !== cr) throw new Error(`Unbalanced voucher (${input.voucherType} ${input.docRef ?? ""}): Dr ${dr} ≠ Cr ${cr}`);
  const voucherId = randomUUID();
  if (legs.length === 0) return voucherId;
  await client.insert(accLedgerEntries).values(
    legs.map((l) => ({
      shopId: input.shopId,
      voucherId,
      voucherType: input.voucherType,
      entryDate: input.entryDate,
      account: l.account,
      partyId: l.partyId ?? null,
      subAccount: l.subAccount ?? null,
      debitPaise: l.debitPaise,
      creditPaise: l.creditPaise,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      docRef: input.docRef ?? null,
      narration: input.narration ?? null,
      reversesVoucherId: input.reversesVoucherId ?? null,
      createdBy: input.createdBy,
    })),
  );
  return voucherId;
}

/** Reverses every voucher posted for a source that is not itself reversed yet. Returns the reversal voucher ids. */
export async function reverseSource(
  shopId: string,
  sourceType: AccLedgerEntry["sourceType"],
  sourceId: string,
  entryDate: string,
  createdBy: string | null,
  narration: string,
  client: DbClient,
): Promise<string[]> {
  const rows = await client
    .select()
    .from(accLedgerEntries)
    .where(and(eq(accLedgerEntries.shopId, shopId), eq(accLedgerEntries.sourceType, sourceType), eq(accLedgerEntries.sourceId, sourceId)));
  const reversed = new Set(rows.map((r) => r.reversesVoucherId).filter(Boolean) as string[]);
  const isReversal = new Set(rows.filter((r) => r.reversesVoucherId).map((r) => r.voucherId));
  const byVoucher = new Map<string, AccLedgerEntry[]>();
  for (const r of rows) {
    if (isReversal.has(r.voucherId) || reversed.has(r.voucherId)) continue;
    byVoucher.set(r.voucherId, [...(byVoucher.get(r.voucherId) ?? []), r]);
  }
  const out: string[] = [];
  for (const [voucherId, legs] of byVoucher) {
    out.push(
      await postVoucher(
        {
          shopId,
          voucherType: "REVERSAL",
          entryDate,
          sourceType,
          sourceId,
          docRef: legs[0].docRef,
          narration,
          reversesVoucherId: voucherId,
          createdBy,
          legs: legs.map((l) => ({ account: l.account, partyId: l.partyId, subAccount: l.subAccount, debitPaise: l.creditPaise, creditPaise: l.debitPaise })),
        },
        client,
      ),
    );
  }
  return out;
}

/* --------------------------------------------------------------- settings */

export async function getSettings(shopId: string, client: DbClient = db): Promise<InvSettings> {
  const [row] = await client.select().from(invSettings).where(eq(invSettings.shopId, shopId));
  if (row) return row;
  const [created] = await client.insert(invSettings).values({ shopId }).onConflictDoNothing().returning();
  if (created) return created;
  const [again] = await client.select().from(invSettings).where(eq(invSettings.shopId, shopId));
  return again;
}

export interface SettingsPatch {
  valuationMethod?: InvSettings["valuationMethod"];
  purchaseChannel?: InvSettings["purchaseChannel"];
  filingFrequency?: InvSettings["filingFrequency"];
  salesInvoicePrefix?: string;
  reminderDaysBefore?: number;
  expiryAlertDays?: number;
}

export async function updateSettings(shopId: string, patch: SettingsPatch, actorId: string): Promise<InvSettings> {
  if (patch.salesInvoicePrefix !== undefined && !/^[A-Z0-9/-]{1,6}$/i.test(patch.salesInvoicePrefix)) {
    throw validationFailed("Invoice prefix: 1–6 letters, digits, / or -.");
  }
  return db.transaction(async (tx) => {
    const before = await getSettings(shopId, tx);
    const [row] = await tx
      .update(invSettings)
      .set({ ...patch, salesInvoicePrefix: patch.salesInvoicePrefix?.toUpperCase(), updatedBy: actorId, updatedAt: new Date() })
      .where(eq(invSettings.shopId, shopId))
      .returning();
    const changes = (Object.keys(patch) as (keyof SettingsPatch)[])
      .filter((k) => patch[k] !== undefined && before[k] !== row[k])
      .map((k) => ({ field: k, old: before[k], new: row[k] }));
    if (changes.length) await logChange({ shopId, entityType: "settings", entityId: shopId, action: "UPDATE", changes, actorId }, tx);
    return row;
  });
}

/* --------------------------------------------------------------- counters */

/** Next number for the shop's own document of `kind` in financial year `fy` (row-locked, gap-free). */
export async function nextNumber(shopId: string, kind: string, fy: string, client: DbClient): Promise<number> {
  const row = await upsertRow(client, accCounters, { keys: [accCounters.shopId, accCounters.kind, accCounters.fy], values: { shopId, kind, fy, next: 2 }, set: { next: sql`${accCounters.next} + 1` } });
  return row.next - 1;
}

/* ------------------------------------------------------------- change log */

export interface ChangeInput {
  shopId: string;
  entityType: string;
  entityId: string;
  action: string;
  changes?: { field: string; old: unknown; new: unknown }[];
  snapshot?: Record<string, unknown> | null;
  reason?: string | null;
  actorId: string | null;
}

export async function logChange(input: ChangeInput, client: DbClient = db): Promise<void> {
  await client.insert(accChangeLog).values({
    shopId: input.shopId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    changes: input.changes ?? [],
    snapshot: input.snapshot ?? null,
    reason: input.reason ?? null,
    actorId: input.actorId,
  });
}

/** Today in India (YYYY-MM-DD). */
export function todayIst(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Switches the stock-ledger triggers off for the rest of this transaction (the module writes its own rows). */
export async function manageLedgerInThisTransaction(client: DbClient): Promise<void> {
  await client.execute(sql`select set_config('gokesari.inv_ledger_managed', 'on', true)`);
}
