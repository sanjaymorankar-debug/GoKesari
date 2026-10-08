/**
 * Voucher / promotional-credit system (Part B of the wallet/voucher brief).
 *
 * The one rule everything here protects: a voucher NEVER represents money the
 * customer paid. It only ever authorises an extra PROMOTIONAL_CREDIT wallet
 * entry alongside a separately, independently verified TOP_UP. Nothing in
 * this file ever moves money — `redeemVoucher()` is called by
 * `payments.ts` AFTER `verifyAndCreditTopUp` has already confirmed and
 * credited the real payment, never before.
 *
 * §32 discipline: every number the client can influence (voucher code,
 * top-up amount) is treated as a claim to verify, not a fact. The bonus
 * percentage, cap, eligibility and amount are always recomputed here from the
 * stored voucher row — a client-supplied bonus figure is never read.
 */
import ExcelJS from "exceljs";
import { and, count, desc, eq, gte, ilike, inArray, lte, or } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  voucherRedemptions,
  voucherUploadItems,
  voucherUploads,
  vouchers,
  type UserRole,
  type Voucher,
  type VoucherRedemption,
  type VoucherStatus,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { MAX_UPLOAD_BYTES, sanitiseCell } from "./excel";

interface Actor {
  id: string;
  role: UserRole;
}

/** §17 "bonus percentage within configured maximum" — the platform-wide ceiling. */
export const MAX_VOUCHER_BONUS_PERCENT = 100;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The status a voucher EFFECTIVELY has right now, independent of the stored
 * `status` column. Expiry and budget exhaustion are derived rather than
 * cron-flipped, so a voucher can never be "still ACTIVE" past its end date
 * just because nothing happened to run and update it (§21).
 */
export function resolveEffectiveStatus(voucher: Voucher, asOf = todayIso()): VoucherStatus {
  if (voucher.status === "DRAFT" || voucher.status === "PAUSED") return voucher.status;
  if (voucher.endDate < asOf) return "EXPIRED";
  if (
    voucher.totalBudgetPaise != null &&
    voucher.budgetUsedPaise >= voucher.totalBudgetPaise
  ) {
    return "BUDGET_EXHAUSTED";
  }
  if (voucher.usageLimit != null && voucher.redemptionCount >= voucher.usageLimit) {
    return "BUDGET_EXHAUSTED";
  }
  if (voucher.startDate > asOf) return "PAUSED"; // scheduled, not yet live
  return "ACTIVE";
}

function computeBonusPaise(voucher: Voucher, topupAmountPaise: number): number {
  const raw = Math.floor((topupAmountPaise * voucher.bonusPercent) / 100);
  return voucher.maximumBonusPaise != null ? Math.min(raw, voucher.maximumBonusPaise) : raw;
}

/* --------------------------------------------------------------- lookup */

export async function findVoucherByCode(
  code: string,
  client: DbClient = db,
): Promise<Voucher | undefined> {
  return client.query.vouchers.findFirst({
    where: eq(vouchers.code, code.trim().toUpperCase()),
  });
}

export interface VoucherPreview {
  voucherId: string;
  code: string | null;
  name: string;
  bonusPercent: number;
  topupAmountPaise: number;
  bonusAmountPaise: number;
  totalCreditPaise: number;
}

/**
 * Read-only preview for the "Apply Voucher" step (§18). Runs the same
 * eligibility checks `redeemVoucher` will, EXCEPT the per-customer-usage
 * count and budget reservation, which must happen under lock at redemption
 * time to be race-safe — this is a preview, not a hold.
 */
export async function previewVoucher(
  code: string,
  topupAmountPaise: number,
  userId: string,
): Promise<VoucherPreview> {
  const voucher = await findVoucherByCode(code);
  if (!voucher) throw validationFailed("That voucher code was not found.");

  const effective = resolveEffectiveStatus(voucher);
  if (effective !== "ACTIVE") {
    throw validationFailed(voucherStatusMessage(effective));
  }
  if (topupAmountPaise < voucher.minimumTopupPaise) {
    throw validationFailed(
      `This voucher requires a minimum top-up of ₹${voucher.minimumTopupPaise / 100}.`,
    );
  }

  const [{ n: priorUses }] = await db
    .select({ n: count() })
    .from(voucherRedemptions)
    .where(
      and(
        eq(voucherRedemptions.voucherId, voucher.id),
        eq(voucherRedemptions.userId, userId),
        eq(voucherRedemptions.status, "APPLIED"),
      ),
    );
  if (priorUses >= voucher.perCustomerLimit) {
    throw validationFailed("You have already used this voucher the maximum number of times.");
  }

  const bonusAmountPaise = computeBonusPaise(voucher, topupAmountPaise);
  return {
    voucherId: voucher.id,
    code: voucher.code,
    name: voucher.name,
    bonusPercent: voucher.bonusPercent,
    topupAmountPaise,
    bonusAmountPaise,
    totalCreditPaise: topupAmountPaise + bonusAmountPaise,
  };
}

function voucherStatusMessage(status: VoucherStatus): string {
  switch (status) {
    case "EXPIRED":
      return "This voucher has expired.";
    case "BUDGET_EXHAUSTED":
      return "This voucher is no longer available — its usage limit or budget has been reached.";
    case "PAUSED":
      return "This voucher is not currently active.";
    case "DRAFT":
      return "This voucher is not yet published.";
    default:
      return "This voucher cannot be applied.";
  }
}

/* ------------------------------------------------------------ redemption */

export interface RedeemVoucherInput {
  code: string;
  userId: string;
  walletId: string;
  topupAmountPaise: number;
  paymentId: string;
}

/**
 * Atomically redeems a voucher against an ALREADY-VERIFIED top-up (§18, §19,
 * §22, §33).
 *
 * Locking the voucher row for the duration of the eligibility check + insert
 * is what makes "prevent duplicate use even under concurrent requests" true:
 * two simultaneous redemption attempts for the same voucher serialise on this
 * lock, so the usage-limit and budget checks always see a consistent count —
 * the same mechanism `applyWalletMutation` uses for the wallet row itself.
 *
 * Idempotent on `payment.id`: retrying with the same payment returns the
 * existing redemption rather than double-crediting (§33 "duplicate webhook").
 *
 * Does NOT move wallet money — returns the bonus for the caller
 * (`payments.ts`) to apply as a PROMOTIONAL_CREDIT via `applyWalletMutation`,
 * so the wallet ledger and the voucher ledger commit in the same transaction.
 */
export async function redeemVoucher(
  input: RedeemVoucherInput,
  client?: DbClient,
): Promise<VoucherRedemption> {
  const run = async (tx: DbClient): Promise<VoucherRedemption> => {
    const idempotencyKey = `voucher:${input.paymentId}`;

    const existing = await tx.query.voucherRedemptions.findFirst({
      where: eq(voucherRedemptions.idempotencyKey, idempotencyKey),
    });
    if (existing) return existing;

    const [voucher] = await tx
      .select()
      .from(vouchers)
      .where(eq(vouchers.code, input.code.trim().toUpperCase()))
      .for("update");
    if (!voucher) throw validationFailed("That voucher code was not found.");

    const effective = resolveEffectiveStatus(voucher);
    if (effective !== "ACTIVE") throw validationFailed(voucherStatusMessage(effective));
    if (input.topupAmountPaise < voucher.minimumTopupPaise) {
      throw validationFailed(
        `This voucher requires a minimum top-up of ₹${voucher.minimumTopupPaise / 100}.`,
      );
    }

    const [{ n: priorUses }] = await tx
      .select({ n: count() })
      .from(voucherRedemptions)
      .where(
        and(
          eq(voucherRedemptions.voucherId, voucher.id),
          eq(voucherRedemptions.userId, input.userId),
          eq(voucherRedemptions.status, "APPLIED"),
        ),
      );
    if (priorUses >= voucher.perCustomerLimit) {
      throw validationFailed("You have already used this voucher the maximum number of times.");
    }

    const bonusAmountPaise = computeBonusPaise(voucher, input.topupAmountPaise);

    // §23: reject outright rather than partially crediting a smaller bonus —
    // "cannot be used further" once the budget is spent.
    if (
      voucher.totalBudgetPaise != null &&
      voucher.budgetUsedPaise + bonusAmountPaise > voucher.totalBudgetPaise
    ) {
      throw validationFailed("This voucher's promotional budget has been used up.");
    }

    const [redemption] = await tx
      .insert(voucherRedemptions)
      .values({
        voucherId: voucher.id,
        userId: input.userId,
        walletId: input.walletId,
        paymentId: input.paymentId,
        topupAmountPaise: input.topupAmountPaise,
        bonusPercent: voucher.bonusPercent,
        bonusAmountPaise,
        status: "APPLIED",
        idempotencyKey,
      })
      .returning();

    const newBudgetUsed = voucher.budgetUsedPaise + bonusAmountPaise;
    const newRedemptionCount = voucher.redemptionCount + 1;
    await tx
      .update(vouchers)
      .set({
        budgetUsedPaise: newBudgetUsed,
        redemptionCount: newRedemptionCount,
        status: resolveEffectiveStatus(
          { ...voucher, budgetUsedPaise: newBudgetUsed, redemptionCount: newRedemptionCount },
        ),
        updatedAt: new Date(),
      })
      .where(eq(vouchers.id, voucher.id));

    await recordAudit(
      {
        actorId: input.userId,
        action: AUDIT_ACTIONS.VOUCHER_REDEEMED,
        entityType: "voucher_redemption",
        entityId: redemption.id,
        newValue: {
          voucherId: voucher.id,
          code: voucher.code,
          topupAmountPaise: input.topupAmountPaise,
          bonusAmountPaise,
        },
      },
      tx,
    );

    return redemption;
  };

  return client ? run(client) : db.transaction(run);
}

/* ---------------------------------------------------------------- admin CRUD */

export interface VoucherInput {
  name: string;
  code?: string | null;
  description?: string | null;
  termsAndConditions?: string | null;
  applyMode?: "CODE" | "AUTO_APPLY";
  bonusPercent: number;
  minimumTopupPaise?: number;
  maximumBonusPaise?: number | null;
  startDate: string;
  endDate: string;
  usageLimit?: number | null;
  perCustomerLimit?: number;
  totalBudgetPaise?: number | null;
}

function validateVoucherInput(input: VoucherInput): void {
  if (input.name.trim().length < 3) {
    throw validationFailed("Voucher name must be at least 3 characters.");
  }
  if ((input.applyMode ?? "CODE") === "CODE" && !input.code?.trim()) {
    throw validationFailed("A voucher code is required unless apply mode is AUTO_APPLY.");
  }
  if (
    !Number.isFinite(input.bonusPercent) ||
    input.bonusPercent <= 0 ||
    input.bonusPercent > MAX_VOUCHER_BONUS_PERCENT
  ) {
    throw validationFailed(
      `Bonus percentage must be greater than 0 and at most ${MAX_VOUCHER_BONUS_PERCENT}%.`,
    );
  }
  if ((input.minimumTopupPaise ?? 0) < 0) {
    throw validationFailed("Minimum top-up cannot be negative.");
  }
  if (input.maximumBonusPaise != null && input.maximumBonusPaise < 0) {
    throw validationFailed("Maximum bonus cannot be negative.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    throw validationFailed("Dates must be in YYYY-MM-DD format.");
  }
  if (input.endDate < input.startDate) {
    throw validationFailed("End date must be on or after the start date.");
  }
  if (input.usageLimit != null && input.usageLimit <= 0) {
    throw validationFailed("Usage limit must be a positive number.");
  }
  if (input.perCustomerLimit != null && input.perCustomerLimit <= 0) {
    throw validationFailed("Per-customer limit must be a positive number.");
  }
  if (input.totalBudgetPaise != null && input.totalBudgetPaise < 0) {
    throw validationFailed("Total budget cannot be negative.");
  }
}

export async function createVoucher(
  input: VoucherInput,
  actor: Actor,
): Promise<Voucher> {
  validateVoucherInput(input);
  const code = input.code ? input.code.trim().toUpperCase() : null;

  if (code) {
    const existing = await findVoucherByCode(code);
    if (existing) throw conflict(`Voucher code ${code} already exists.`);
  }

  const [voucher] = await db
    .insert(vouchers)
    .values({
      name: input.name.trim(),
      code,
      description: input.description ?? null,
      termsAndConditions: input.termsAndConditions ?? null,
      applyMode: input.applyMode ?? "CODE",
      bonusPercent: input.bonusPercent,
      minimumTopupPaise: input.minimumTopupPaise ?? 0,
      maximumBonusPaise: input.maximumBonusPaise ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      usageLimit: input.usageLimit ?? null,
      perCustomerLimit: input.perCustomerLimit ?? 1,
      totalBudgetPaise: input.totalBudgetPaise ?? null,
      status: "ACTIVE",
      createdBy: actor.id,
    })
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.VOUCHER_CREATED,
    entityType: "voucher",
    entityId: voucher.id,
    newValue: { name: voucher.name, code: voucher.code, bonusPercent: voucher.bonusPercent },
  });
  return voucher;
}

export async function updateVoucher(
  id: string,
  input: Partial<VoucherInput>,
  actor: Actor,
): Promise<Voucher> {
  const current = await db.query.vouchers.findFirst({ where: eq(vouchers.id, id) });
  if (!current) throw notFound("Voucher");

  const merged: VoucherInput = {
    name: input.name ?? current.name,
    code: input.code !== undefined ? input.code : current.code,
    description: input.description !== undefined ? input.description : current.description,
    termsAndConditions:
      input.termsAndConditions !== undefined
        ? input.termsAndConditions
        : current.termsAndConditions,
    applyMode: input.applyMode ?? current.applyMode,
    bonusPercent: input.bonusPercent ?? current.bonusPercent,
    minimumTopupPaise: input.minimumTopupPaise ?? current.minimumTopupPaise,
    maximumBonusPaise:
      input.maximumBonusPaise !== undefined ? input.maximumBonusPaise : current.maximumBonusPaise,
    startDate: input.startDate ?? current.startDate,
    endDate: input.endDate ?? current.endDate,
    usageLimit: input.usageLimit !== undefined ? input.usageLimit : current.usageLimit,
    perCustomerLimit: input.perCustomerLimit ?? current.perCustomerLimit,
    totalBudgetPaise:
      input.totalBudgetPaise !== undefined ? input.totalBudgetPaise : current.totalBudgetPaise,
  };
  validateVoucherInput(merged);

  const code = merged.code ? merged.code.trim().toUpperCase() : null;
  if (code && code !== current.code) {
    const existing = await findVoucherByCode(code);
    if (existing) throw conflict(`Voucher code ${code} already exists.`);
  }

  const [updated] = await db
    .update(vouchers)
    .set({
      name: merged.name.trim(),
      code,
      description: merged.description ?? null,
      termsAndConditions: merged.termsAndConditions ?? null,
      applyMode: merged.applyMode,
      bonusPercent: merged.bonusPercent,
      minimumTopupPaise: merged.minimumTopupPaise ?? 0,
      maximumBonusPaise: merged.maximumBonusPaise ?? null,
      startDate: merged.startDate,
      endDate: merged.endDate,
      usageLimit: merged.usageLimit ?? null,
      perCustomerLimit: merged.perCustomerLimit ?? 1,
      totalBudgetPaise: merged.totalBudgetPaise ?? null,
      updatedAt: new Date(),
    })
    .where(eq(vouchers.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.VOUCHER_UPDATED,
    entityType: "voucher",
    entityId: id,
    previousValue: { bonusPercent: current.bonusPercent, status: current.status },
    newValue: { bonusPercent: updated.bonusPercent, status: updated.status },
  });
  return updated;
}

export async function setVoucherStatus(
  id: string,
  status: "ACTIVE" | "PAUSED",
  actor: Actor,
): Promise<Voucher> {
  const current = await db.query.vouchers.findFirst({ where: eq(vouchers.id, id) });
  if (!current) throw notFound("Voucher");

  const [updated] = await db
    .update(vouchers)
    .set({ status, updatedAt: new Date() })
    .where(eq(vouchers.id, id))
    .returning();

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action:
      status === "ACTIVE" ? AUDIT_ACTIONS.VOUCHER_ACTIVATED : AUDIT_ACTIONS.VOUCHER_DEACTIVATED,
    entityType: "voucher",
    entityId: id,
    previousValue: { status: current.status },
    newValue: { status },
  });
  return updated;
}

/* -------------------------------------------------------------------- reads */

export async function listVouchers(options: {
  search?: string;
  status?: VoucherStatus;
  limit?: number;
} = {}): Promise<Voucher[]> {
  const conditions = [];
  if (options.search) {
    const term = `%${options.search}%`;
    conditions.push(or(ilike(vouchers.name, term), ilike(vouchers.code, term))!);
  }
  if (options.status) conditions.push(eq(vouchers.status, options.status));

  return db
    .select()
    .from(vouchers)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(vouchers.createdAt))
    .limit(options.limit ?? 200);
}

export interface VoucherDashboard {
  totalVouchers: number;
  activeVouchers: number;
  expiredVouchers: number;
  scheduledVouchers: number;
  totalRedemptions: number;
  totalPromotionalIssuedPaise: number;
  totalPromotionalUsedPaise: number;
  remainingLiabilityPaise: number;
}

export async function getVoucherDashboard(): Promise<VoucherDashboard> {
  const all = await db.select().from(vouchers);
  const today = todayIso();

  let active = 0;
  let expired = 0;
  let scheduled = 0;
  let budgetUsed = 0;
  let budgetTotal = 0;

  for (const v of all) {
    const effective = resolveEffectiveStatus(v, today);
    if (effective === "ACTIVE") active += 1;
    else if (effective === "EXPIRED") expired += 1;
    else if (v.status !== "DRAFT" && v.status !== "PAUSED" && v.startDate > today) scheduled += 1;
    budgetUsed += v.budgetUsedPaise;
    if (v.totalBudgetPaise != null) budgetTotal += v.totalBudgetPaise;
  }

  const [{ n: totalRedemptions }] = await db
    .select({ n: count() })
    .from(voucherRedemptions)
    .where(eq(voucherRedemptions.status, "APPLIED"));

  return {
    totalVouchers: all.length,
    activeVouchers: active,
    expiredVouchers: expired,
    scheduledVouchers: scheduled,
    totalRedemptions,
    totalPromotionalIssuedPaise: budgetUsed,
    totalPromotionalUsedPaise: budgetUsed,
    remainingLiabilityPaise: Math.max(0, budgetTotal - budgetUsed),
  };
}

export interface VoucherRedemptionFilters {
  voucherId?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function listRedemptions(filters: VoucherRedemptionFilters = {}) {
  const conditions = [];
  if (filters.voucherId) conditions.push(eq(voucherRedemptions.voucherId, filters.voucherId));
  if (filters.userId) conditions.push(eq(voucherRedemptions.userId, filters.userId));
  if (filters.from) conditions.push(gte(voucherRedemptions.createdAt, new Date(filters.from)));
  if (filters.to) conditions.push(lte(voucherRedemptions.createdAt, new Date(filters.to)));

  return db
    .select({
      redemption: voucherRedemptions,
      voucherName: vouchers.name,
      voucherCode: vouchers.code,
    })
    .from(voucherRedemptions)
    .innerJoin(vouchers, eq(vouchers.id, voucherRedemptions.voucherId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(voucherRedemptions.createdAt))
    .limit(filters.limit ?? 200);
}

/* -------------------------------------------------------- Excel upload (§16) */

const VOUCHER_TEMPLATE_COLUMNS = [
  "Voucher Name",
  "Voucher Code",
  "Bonus %",
  "Min Top-Up",
  "Max Bonus",
  "Start Date",
  "End Date",
] as const;

const VOUCHER_COLUMN_ALIASES: Record<string, string> = {
  "voucher name": "name",
  name: "name",
  "voucher code": "code",
  code: "code",
  "bonus %": "bonusPercent",
  "bonus percent": "bonusPercent",
  bonus: "bonusPercent",
  "min top-up": "minimumTopup",
  "min topup": "minimumTopup",
  "minimum top-up": "minimumTopup",
  "max bonus": "maximumBonus",
  "maximum bonus": "maximumBonus",
  "start date": "startDate",
  "end date": "endDate",
  "usage limit": "usageLimit",
  "per customer limit": "perCustomerLimit",
  "total budget": "totalBudget",
};

/** Accepts an ExcelJS native Date cell, ISO, DD-MM-YYYY, or DD-MMM(-YYYY). */
function parseVoucherDate(raw: unknown): string | null {
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  const text = String(raw ?? "").trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const dmy = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const dmon = text.match(/^(\d{1,2})[- ]([A-Za-z]{3,})[- ]?(\d{4})?$/);
  if (dmon) {
    const [, d, monRaw, yRaw] = dmon;
    const mon = months[monRaw.slice(0, 3).toLowerCase()];
    if (mon) {
      const year = yRaw ?? String(new Date().getUTCFullYear());
      return `${year}-${mon}-${d.padStart(2, "0")}`;
    }
  }
  return null;
}

function parseIntCell(raw: unknown): number | null {
  const text = String(raw ?? "").replace(/[%,\s]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export interface VoucherUploadPreviewRow {
  rowNumber: number;
  name: string;
  code: string;
  bonusPercent: number | null;
  minimumTopupPaise: number | null;
  maximumBonusPaise: number | null;
  startDate: string | null;
  endDate: string | null;
  status: "VALID" | "DUPLICATE_IN_FILE" | "DUPLICATE_EXISTING" | "INVALID";
  errorMessage: string | null;
}

export interface VoucherUploadPreview {
  uploadId: string;
  fileName: string;
  rows: VoucherUploadPreviewRow[];
  counts: { total: number; valid: number; invalid: number; duplicate: number };
}

async function parseVoucherWorkbook(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<VoucherUploadPreviewRow[]> {
  if (!fileName.toLowerCase().endsWith(".xlsx") && !fileName.toLowerCase().endsWith(".xlsm")) {
    throw validationFailed("Upload an .xlsx file exported from Excel or Sheets.");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw validationFailed(`File is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw validationFailed("That file could not be read as a spreadsheet.");
  }

  const sheet = workbook.worksheets[0];
  if (!sheet) throw validationFailed("The workbook has no sheets.");

  const headerRow = sheet.getRow(1);
  const columns = new Map<number, string>();
  headerRow.eachCell((cell, colNumber) => {
    const key = String(cell.value ?? "").trim().toLowerCase();
    const field = VOUCHER_COLUMN_ALIASES[key];
    if (field) columns.set(colNumber, field);
  });
  if (!Array.from(columns.values()).includes("code") && !Array.from(columns.values()).includes("name")) {
    throw validationFailed('The sheet needs at least "Voucher Name" and "Voucher Code" columns.');
  }

  const rows: VoucherUploadPreviewRow[] = [];
  const seenInFile = new Set<string>();

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (rows.length >= 5000) return;

    const raw: Record<string, unknown> = {};
    for (const [colNumber, field] of columns) {
      const cell = row.getCell(colNumber);
      raw[field] = field === "startDate" || field === "endDate" ? cell.value : sanitiseCell(cell.value);
    }
    const hasContent = Object.values(raw).some((v) => v != null && String(v) !== "");
    if (!hasContent) return;

    const name = String(raw.name ?? "").trim();
    const code = String(raw.code ?? "").trim().toUpperCase();
    const bonusPercent = parseIntCell(raw.bonusPercent);
    const minimumTopupPaise = raw.minimumTopup != null ? (parseIntCell(raw.minimumTopup) ?? 0) * 100 : 0;
    const maximumBonusRaw = parseIntCell(raw.maximumBonus);
    const maximumBonusPaise = maximumBonusRaw != null ? maximumBonusRaw * 100 : null;
    const startDate = parseVoucherDate(raw.startDate);
    const endDate = parseVoucherDate(raw.endDate);

    const base = {
      rowNumber,
      name,
      code,
      bonusPercent,
      minimumTopupPaise,
      maximumBonusPaise,
      startDate,
      endDate,
    };

    if (!name || !code) {
      rows.push({ ...base, status: "INVALID", errorMessage: "Voucher name and code are both required." });
      return;
    }
    if (seenInFile.has(code)) {
      rows.push({ ...base, status: "DUPLICATE_IN_FILE", errorMessage: `${code} appears more than once in this file.` });
      return;
    }
    if (bonusPercent == null || bonusPercent <= 0 || bonusPercent > MAX_VOUCHER_BONUS_PERCENT) {
      rows.push({
        ...base,
        status: "INVALID",
        errorMessage: `Bonus % must be greater than 0 and at most ${MAX_VOUCHER_BONUS_PERCENT}.`,
      });
      return;
    }
    if (!startDate || !endDate) {
      rows.push({ ...base, status: "INVALID", errorMessage: "Start Date and End Date must be valid dates." });
      return;
    }
    if (endDate < startDate) {
      rows.push({ ...base, status: "INVALID", errorMessage: "End Date must be on or after Start Date." });
      return;
    }

    seenInFile.add(code);
    rows.push({ ...base, status: "VALID", errorMessage: null });
  });

  if (rows.length === 0) throw validationFailed("The sheet has no data rows.");
  return rows;
}

/** Phase one: validate a voucher spreadsheet. Nothing is created yet. */
export async function validateVoucherUpload(
  input: { fileName: string; buffer: ArrayBuffer },
  actor: Actor,
): Promise<VoucherUploadPreview> {
  const parsed = await parseVoucherWorkbook(input.buffer, input.fileName);

  // Existing-code collisions checked against the live table, on top of the
  // in-file duplicate check parseVoucherWorkbook already did.
  const codes = parsed.filter((r) => r.status === "VALID").map((r) => r.code);
  const existing = codes.length
    ? await db.select({ code: vouchers.code }).from(vouchers).where(inArray(vouchers.code, codes))
    : [];
  const existingCodes = new Set(existing.map((r) => r.code));

  const rows = parsed.map((row) =>
    row.status === "VALID" && existingCodes.has(row.code)
      ? { ...row, status: "DUPLICATE_EXISTING" as const, errorMessage: `Voucher code ${row.code} already exists.` }
      : row,
  );

  const counts = {
    total: rows.length,
    valid: rows.filter((r) => r.status === "VALID").length,
    invalid: rows.filter((r) => r.status === "INVALID").length,
    duplicate: rows.filter((r) => r.status === "DUPLICATE_IN_FILE" || r.status === "DUPLICATE_EXISTING").length,
  };

  const [upload] = await db
    .insert(voucherUploads)
    .values({
      uploadedBy: actor.id,
      fileName: input.fileName,
      status: "VALIDATED",
      totalRecords: counts.total,
      successfulRecords: counts.valid,
      failedRecords: counts.total - counts.valid,
      summary: counts,
    })
    .returning();

  if (rows.length > 0) {
    await db.insert(voucherUploadItems).values(
      rows.map((r) => ({
        uploadId: upload.id,
        rowNumber: r.rowNumber,
        rawData: r as unknown as Record<string, unknown>,
        voucherName: r.name || null,
        voucherCode: r.code || null,
        status: r.status,
        errorMessage: r.errorMessage,
      })),
    );
  }

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.VOUCHER_UPLOADED,
    entityType: "voucher_upload",
    entityId: upload.id,
    newValue: { fileName: input.fileName, ...counts },
  });

  return { uploadId: upload.id, fileName: input.fileName, rows, counts };
}

/** Phase two: create a voucher for every VALID row. */
export async function applyVoucherUpload(
  uploadId: string,
  actor: Actor,
): Promise<{ created: number }> {
  return db.transaction(async (tx) => {
    const [upload] = await tx
      .select()
      .from(voucherUploads)
      .where(eq(voucherUploads.id, uploadId))
      .for("update");
    if (!upload) throw notFound("Voucher upload");
    if (upload.status !== "VALIDATED") {
      throw conflict(`This upload has already been ${upload.status.toLowerCase()}.`);
    }

    const items = await tx
      .select()
      .from(voucherUploadItems)
      .where(and(eq(voucherUploadItems.uploadId, uploadId), eq(voucherUploadItems.status, "VALID")));

    let created = 0;
    for (const item of items) {
      const raw = item.rawData as unknown as VoucherUploadPreviewRow;
      const [voucher] = await tx
        .insert(vouchers)
        .values({
          name: raw.name,
          code: raw.code,
          applyMode: "CODE",
          bonusPercent: raw.bonusPercent!,
          minimumTopupPaise: raw.minimumTopupPaise ?? 0,
          maximumBonusPaise: raw.maximumBonusPaise,
          startDate: raw.startDate!,
          endDate: raw.endDate!,
          status: "ACTIVE",
          createdBy: actor.id,
        })
        .returning();
      created += 1;

      await tx
        .update(voucherUploadItems)
        .set({ createdVoucherId: voucher.id })
        .where(eq(voucherUploadItems.id, item.id));
    }

    await tx.update(voucherUploads).set({ status: "APPLIED", appliedAt: new Date() }).where(eq(voucherUploads.id, uploadId));

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.VOUCHER_UPLOAD_APPLIED,
        entityType: "voucher_upload",
        entityId: uploadId,
        newValue: { created },
      },
      tx,
    );

    return { created };
  });
}

export async function getUploadPreview(uploadId: string): Promise<VoucherUploadPreview> {
  const [upload] = await db.select().from(voucherUploads).where(eq(voucherUploads.id, uploadId));
  if (!upload) throw notFound("Voucher upload");

  const items = await db
    .select()
    .from(voucherUploadItems)
    .where(eq(voucherUploadItems.uploadId, uploadId))
    .orderBy(voucherUploadItems.rowNumber);

  const rows = items.map((i) => ({
    ...(i.rawData as unknown as VoucherUploadPreviewRow),
    rowNumber: i.rowNumber,
    status: i.status,
    errorMessage: i.errorMessage,
  }));

  return {
    uploadId: upload.id,
    fileName: upload.fileName,
    rows,
    counts: {
      total: upload.totalRecords,
      valid: upload.successfulRecords,
      invalid: rows.filter((r) => r.status === "INVALID").length,
      duplicate: rows.filter((r) => r.status === "DUPLICATE_IN_FILE" || r.status === "DUPLICATE_EXISTING").length,
    },
  };
}

export async function buildVoucherTemplate(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Vouchers");
  sheet.columns = VOUCHER_TEMPLATE_COLUMNS.map((header) => ({ header, width: 16 }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(["Diwali 10% Bonus", "DIWALI10", 10, 500, 500, "2026-09-01", "2026-09-30"]);

  const notes = workbook.addWorksheet("How to use");
  notes.addRows([
    ["Required columns", "Voucher Name, Voucher Code, Bonus %, Start Date, End Date"],
    ["Optional columns", "Min Top-Up, Max Bonus (in rupees), Usage Limit, Per Customer Limit, Total Budget"],
    ["Dates", "Use YYYY-MM-DD, or a real Excel date cell"],
    ["Voucher Code", "Must be unique — duplicates within the file or against existing vouchers are rejected"],
  ]);

  return workbook.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
