/**
 * Admin management of rider earning slots and incentive rules.
 * Everything here changes future earnings only: an earning already written
 * keeps the breakdown it was paid on.
 */
import { desc, eq } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { parseHHMM } from "@/lib/earnings-calc";
import { db } from "@/server/db";
import {
  riderEarningSlots,
  riderIncentiveRules,
  type RiderEarningSlot,
  type RiderIncentiveRule,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { insertReturning, updateReturning } from "@/server/db/returning";

interface Actor {
  id: string;
  role: UserRole;
}

export interface SlotInput {
  name: string;
  startTime: string;
  endTime: string;
  daysOfWeek?: number[];
  baseFeePaise?: number | null;
  perKmFeePaise?: number | null;
  minEarningPaise?: number | null;
  orderFeePaise?: number;
  orderPercentBp?: number;
  peakBonusPaise?: number;
  isPeak?: boolean;
  priority?: number;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

export interface IncentiveInput {
  name: string;
  description?: string | null;
  type: RiderIncentiveRule["type"];
  thresholdValue?: number;
  rewardPaise: number;
  period?: "DAY" | "WEEK";
  startTime?: string | null;
  endTime?: string | null;
  daysOfWeek?: number[];
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
}

const nonNegative = (value: number | null | undefined, label: string) => {
  if (value != null && (!Number.isInteger(value) || value < 0)) {
    throw validationFailed(
      `${label} must be a whole, non-negative amount in paise.`,
    );
  }
};

function checkDays(days: number[] | undefined): number[] {
  const unique = [...new Set(days ?? [])];
  if (unique.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw validationFailed(
      "Days must be numbers from 0 (Sunday) to 6 (Saturday).",
    );
  }
  return unique.sort();
}

function checkDates(
  from: string | null | undefined,
  to: string | null | undefined,
): void {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !iso.test(from)) || (to && !iso.test(to)))
    throw validationFailed("Dates must be YYYY-MM-DD.");
  if (from && to && from > to)
    throw validationFailed("The end date is before the start date.");
}

function checkWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  required: boolean,
): void {
  if (!start && !end && !required) return;
  const s = start ? parseHHMM(start) : null;
  const e = end ? parseHHMM(end) : null;
  if (s == null || e == null)
    throw validationFailed("Times must be HH:MM (24-hour).");
  if (s === e) throw validationFailed("Start and end time cannot be the same.");
}

export async function listSlots(): Promise<RiderEarningSlot[]> {
  return db
    .select()
    .from(riderEarningSlots)
    .orderBy(desc(riderEarningSlots.priority), riderEarningSlots.startTime);
}

export async function saveSlot(
  input: SlotInput,
  actor: Actor,
  id?: string,
): Promise<RiderEarningSlot> {
  const name = input.name.trim();
  if (!name) throw validationFailed("Give the slot a name.");
  checkWindow(input.startTime, input.endTime, true);
  checkDates(input.validFrom, input.validTo);
  nonNegative(input.baseFeePaise, "Base fee");
  nonNegative(input.perKmFeePaise, "Per-km fee");
  nonNegative(input.minEarningPaise, "Minimum earning");
  nonNegative(input.orderFeePaise, "Order fee");
  nonNegative(input.peakBonusPaise, "Peak bonus");
  if (
    input.orderPercentBp !== undefined &&
    (!Number.isInteger(input.orderPercentBp) ||
      input.orderPercentBp < 0 ||
      input.orderPercentBp > 10_000)
  ) {
    throw validationFailed(
      "Order share must be between 0 and 10000 basis points (100%).",
    );
  }

  const values = {
    name,
    startTime: input.startTime,
    endTime: input.endTime,
    daysOfWeek: checkDays(input.daysOfWeek),
    baseFeePaise: input.baseFeePaise ?? null,
    perKmFeePaise: input.perKmFeePaise ?? null,
    minEarningPaise: input.minEarningPaise ?? null,
    orderFeePaise: input.orderFeePaise ?? 0,
    orderPercentBp: input.orderPercentBp ?? 0,
    peakBonusPaise: input.peakBonusPaise ?? 0,
    isPeak: input.isPeak ?? false,
    priority: input.priority ?? 0,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    isActive: input.isActive ?? true,
    updatedAt: new Date(),
  };

  const previous = id
    ? await db.query.riderEarningSlots.findFirst({
        where: eq(riderEarningSlots.id, id),
      })
    : null;
  if (id && !previous) throw notFound("Earning slot");
  const [saved] = id
    ? await updateReturning(
        db,
        riderEarningSlots,
        values,
        eq(riderEarningSlots.id, id),
      )
    : await insertReturning(db, riderEarningSlots, {
        ...values,
        createdBy: actor.id,
      });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_EARNING_SLOT_SAVED,
    entityType: "rider_earning_slot",
    entityId: saved.id,
    previousValue: previous ?? null,
    newValue: saved,
  });
  return saved;
}

export async function listIncentives(): Promise<RiderIncentiveRule[]> {
  return db
    .select()
    .from(riderIncentiveRules)
    .orderBy(desc(riderIncentiveRules.createdAt));
}

export async function saveIncentive(
  input: IncentiveInput,
  actor: Actor,
  id?: string,
): Promise<RiderIncentiveRule> {
  const name = input.name.trim();
  if (!name) throw validationFailed("Give the incentive a name.");
  if (!Number.isInteger(input.rewardPaise) || input.rewardPaise <= 0) {
    throw validationFailed("The reward must be more than zero (paise).");
  }
  const threshold = input.thresholdValue ?? 0;
  if (!Number.isInteger(threshold) || threshold < 0)
    throw validationFailed("Threshold must be a whole number.");
  if (
    ["ORDER_COUNT", "DAILY_TARGET", "WEEKLY_TARGET", "DISTANCE"].includes(
      input.type,
    ) &&
    threshold <= 0
  ) {
    throw validationFailed(
      "This kind of incentive needs a threshold above zero.",
    );
  }
  if (input.type === "PEAK_HOUR")
    checkWindow(input.startTime, input.endTime, true);
  else checkWindow(input.startTime, input.endTime, false);
  checkDates(input.validFrom, input.validTo);
  if (input.type === "CAMPAIGN" && !input.validFrom && !input.validTo) {
    throw validationFailed(
      "A campaign needs a start or end date so it cannot run forever.",
    );
  }

  const values = {
    name,
    description: input.description?.trim() || null,
    type: input.type,
    thresholdValue: threshold,
    rewardPaise: input.rewardPaise,
    period: input.period ?? "DAY",
    startTime: input.startTime || null,
    endTime: input.endTime || null,
    daysOfWeek: checkDays(input.daysOfWeek),
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    isActive: input.isActive ?? true,
    updatedAt: new Date(),
  };

  const previous = id
    ? await db.query.riderIncentiveRules.findFirst({
        where: eq(riderIncentiveRules.id, id),
      })
    : null;
  if (id && !previous) throw notFound("Incentive rule");
  const [saved] = id
    ? await updateReturning(
        db,
        riderIncentiveRules,
        values,
        eq(riderIncentiveRules.id, id),
      )
    : await insertReturning(db, riderIncentiveRules, {
        ...values,
        createdBy: actor.id,
      });

  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.RIDER_INCENTIVE_SAVED,
    entityType: "rider_incentive_rule",
    entityId: saved.id,
    previousValue: previous ?? null,
    newValue: saved,
  });
  return saved;
}
