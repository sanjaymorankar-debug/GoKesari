/**
 * Registration fee schedule (requirement §12).
 *
 * The single rule this file exists to enforce: **changing the current fee must
 * never alter what an already-registered shop was charged.** That is achieved by
 * snapshotting the amount onto `shops.registration_fee_paise` at registration
 * time and treating `registration_fees` as an append-only schedule — a change
 * deactivates the old row and inserts a new one, so the amount in force on any
 * past date stays recoverable.
 *
 * Only ADMIN reaches this service (REGISTRATION_FEE_MANAGE).
 */
import { and, desc, eq, lte } from "drizzle-orm";

import { notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  registrationFeeHistory,
  registrationFees,
  type RegistrationFee,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { insertReturning } from "@/server/db/returning";

interface Actor {
  id: string;
  role: UserRole;
}

/** The fee currently in force, or undefined if none has been configured yet. */
export async function getActiveFee(
  client: DbClient = db,
): Promise<RegistrationFee | undefined> {
  const [fee] = await client
    .select()
    .from(registrationFees)
    .where(eq(registrationFees.isActive, true))
    .orderBy(
      desc(registrationFees.effectiveFrom),
      desc(registrationFees.createdAt),
    )
    .limit(1);
  return fee;
}

/**
 * The fee that was in force on a given date.
 *
 * Used for reporting over historical registrations. Note this is a *lookup of
 * the schedule*, not the authority on what a shop actually paid — that is the
 * snapshot on the shop row, which wins whenever the two disagree (a shop may
 * have been given a manual override).
 */
export async function getFeeEffectiveOn(
  date: string,
  client: DbClient = db,
): Promise<RegistrationFee | undefined> {
  const [fee] = await client
    .select()
    .from(registrationFees)
    .where(lte(registrationFees.effectiveFrom, date))
    .orderBy(
      desc(registrationFees.effectiveFrom),
      desc(registrationFees.createdAt),
    )
    .limit(1);
  return fee;
}

export async function listFeeHistory(limit = 100) {
  return db
    .select()
    .from(registrationFeeHistory)
    .orderBy(desc(registrationFeeHistory.createdAt))
    .limit(limit);
}

export async function listFees(limit = 100): Promise<RegistrationFee[]> {
  return db
    .select()
    .from(registrationFees)
    .orderBy(
      desc(registrationFees.effectiveFrom),
      desc(registrationFees.createdAt),
    )
    .limit(limit);
}

export interface SetFeeInput {
  amountPaise: number;
  /** ISO date. Defaults to today. Future dates schedule the change. */
  effectiveFrom?: string;
  reason?: string | null;
  note?: string | null;
}

/**
 * Sets a new registration fee.
 *
 * Deactivates the previous row and appends a new one plus a history entry, all
 * in one transaction. Existing shops are deliberately left untouched — their
 * snapshot is what they owe (§12, §25.11).
 */
export async function setRegistrationFee(
  input: SetFeeInput,
  actor: Actor,
): Promise<RegistrationFee> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 0) {
    throw validationFailed(
      "Registration fee must be a whole number of paise, zero or more.",
    );
  }

  const effectiveFrom =
    input.effectiveFrom ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    throw validationFailed("Effective date must be an ISO date (YYYY-MM-DD).");
  }

  return db.transaction(async (tx) => {
    const previous = await getActiveFee(tx);

    if (previous) {
      await tx
        .update(registrationFees)
        .set({ isActive: false })
        .where(eq(registrationFees.id, previous.id));
    }

    const [created] = await insertReturning(tx, registrationFees, {
      amountPaise: input.amountPaise,
      effectiveFrom,
      isActive: true,
      note: input.note ?? null,
      createdBy: actor.id,
    });

    await tx.insert(registrationFeeHistory).values({
      registrationFeeId: created.id,
      previousAmountPaise: previous?.amountPaise ?? null,
      newAmountPaise: created.amountPaise,
      effectiveFrom,
      changedBy: actor.id,
      reason: input.reason ?? null,
    });

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.REGISTRATION_FEE_CHANGED,
        entityType: "registration_fee",
        entityId: created.id,
        previousValue: previous ? { amountPaise: previous.amountPaise } : null,
        newValue: { amountPaise: created.amountPaise, effectiveFrom },
      },
      tx,
    );

    return created;
  });
}

/** Reads one fee row; used when resolving a shop's snapshot provenance. */
export async function getFeeById(id: string): Promise<RegistrationFee> {
  const [fee] = await db
    .select()
    .from(registrationFees)
    .where(eq(registrationFees.id, id))
    .limit(1);
  if (!fee) throw notFound("Registration fee");
  return fee;
}

/**
 * Resolves the fee to charge a shop registering now, as an
 * (amount, sourceRowId) pair to be snapshotted onto the shop.
 */
export async function resolveFeeForNewRegistration(
  client: DbClient = db,
): Promise<{ amountPaise: number; feeId: string | null }> {
  const active = await getActiveFee(client);
  return {
    amountPaise: active?.amountPaise ?? 0,
    feeId: active?.id ?? null,
  };
}

/** Fee rows scheduled to take effect in the future, for the admin screen. */
export async function listScheduledFees(): Promise<RegistrationFee[]> {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .select()
    .from(registrationFees)
    .where(and(eq(registrationFees.isActive, true)))
    .orderBy(desc(registrationFees.effectiveFrom))
    .then((rows) => rows.filter((r) => r.effectiveFrom > today));
}
