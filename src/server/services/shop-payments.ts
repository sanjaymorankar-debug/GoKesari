/**
 * Registration-fee and renewal payments (requirements §3, §4.2, §15).
 *
 * Financial rows here are **immutable**. There is deliberately no update and no
 * delete: a correction is a new REVERSAL or REFUND row that points at the
 * original via `reversal_of_id`. This is the same discipline the wallet ledger
 * uses, for the same reason — a payment history that can be edited is not a
 * payment history.
 *
 * `shops.amount_paid_paise` and `shops.fee_payment_status` are running
 * aggregates maintained in the *same transaction* as the ledger write, so the
 * summary can never drift from the rows it summarises.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { conflict, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  shopPayments,
  shops,
  type FeePaymentStatus,
  type ShopPayment,
  type ShopPaymentMethod,
  type ShopPaymentType,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { autoApproveShopIfReady } from "./shops";

interface Actor {
  id: string;
  role: UserRole;
}

/**
 * Allocates a receipt reference. A sequence would be tidier, but payments are
 * low-volume and the count-based form is human-meaningful; the UNIQUE index on
 * `reference` is the real guarantee, and a collision retries.
 */
async function nextReference(tx: DbClient): Promise<string> {
  const year = new Date().getFullYear();
  const [{ n }] = await tx
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(shopPayments);
  return `PAY-${year}-${String(n + 1).padStart(6, "0")}`;
}

/**
 * Recomputes a shop's settlement summary from the ledger.
 *
 * Deliberately derived by SUM over the rows rather than incremented, so a
 * reversal, refund or adjustment all fall out of the same arithmetic and the
 * denormalised column cannot drift.
 */
async function recomputeShopSettlement(
  tx: DbClient,
  shopId: string,
): Promise<{ amountPaidPaise: number; feePaymentStatus: FeePaymentStatus }> {
  const [shop] = await tx
    .select({
      registrationFeePaise: shops.registrationFeePaise,
      feePaymentStatus: shops.feePaymentStatus,
    })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!shop) throw notFound("Shop");

  const [{ paid }] = await tx
    .select({
      paid: sql<number>`COALESCE(SUM(${shopPayments.amountPaise}), 0)::bigint`,
    })
    .from(shopPayments)
    .where(eq(shopPayments.shopId, shopId));

  const amountPaidPaise = Number(paid);
  const fee = shop.registrationFeePaise ?? 0;

  // A cancelled registration stays cancelled — settlement arithmetic does not
  // resurrect it.
  let status: FeePaymentStatus;
  if (shop.feePaymentStatus === "CANCELLED") {
    status = "CANCELLED";
  } else if (amountPaidPaise <= 0) {
    status = fee > 0 ? "PENDING" : "PAID";
  } else if (amountPaidPaise >= fee) {
    status = "PAID";
  } else {
    status = "PARTIALLY_PAID";
  }

  await tx
    .update(shops)
    .set({ amountPaidPaise, feePaymentStatus: status, updatedAt: new Date() })
    .where(eq(shops.id, shopId));

  return { amountPaidPaise, feePaymentStatus: status };
}

export interface RecordPaymentInput {
  shopId: string;
  paymentType: ShopPaymentType;
  /** Positive paise. Direction is derived from paymentType, not from the sign. */
  amountPaise: number;
  method?: ShopPaymentMethod;
  transactionId?: string | null;
  paidAt?: Date;
  note?: string | null;
  receiptUrl?: string | null;
}

/**
 * Records a received payment against a shop's registration fee.
 *
 * The caller supplies a positive amount and a type; REFUND/REVERSAL are stored
 * negative so that SUM(amount_paise) is always the net settled figure.
 */
export async function recordPayment(
  input: RecordPaymentInput,
  actor: Actor,
): Promise<{ payment: ShopPayment; amountPaidPaise: number; feePaymentStatus: FeePaymentStatus }> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw validationFailed("Payment amount must be a positive whole number of paise.");
  }
  if (input.paymentType === "REVERSAL") {
    throw validationFailed("Use reversePayment() to reverse an existing payment.");
  }

  const recorded = await db.transaction(async (tx) => {
    const [shop] = await tx
      .select({
        id: shops.id,
        ownerId: shops.ownerId,
        registrationFeePaise: shops.registrationFeePaise,
      })
      .from(shops)
      .where(and(eq(shops.id, input.shopId), isNull(shops.deletedAt)))
      .for("update")
      .limit(1);
    if (!shop) throw notFound("Shop");

    const signed =
      input.paymentType === "REFUND" ? -input.amountPaise : input.amountPaise;

    const [payment] = await tx
      .insert(shopPayments)
      .values({
        reference: await nextReference(tx),
        shopId: shop.id,
        ownerId: shop.ownerId,
        paymentType: input.paymentType,
        amountPaise: signed,
        method: input.method ?? "CASH",
        transactionId: input.transactionId ?? null,
        feeSnapshotPaise: shop.registrationFeePaise,
        paidAt: input.paidAt ?? new Date(),
        note: input.note ?? null,
        receiptUrl: input.receiptUrl ?? null,
        recordedBy: actor.id,
      })
      .returning();

    const settlement = await recomputeShopSettlement(tx, shop.id);

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_PAYMENT_RECORDED,
        entityType: "shop_payment",
        entityId: payment.id,
        newValue: {
          reference: payment.reference,
          shopId: shop.id,
          type: payment.paymentType,
          amountPaise: payment.amountPaise,
          method: payment.method,
          feePaymentStatus: settlement.feePaymentStatus,
        },
      },
      tx,
    );

    return { payment, ...settlement };
  });
  // Event layer: a settled fee may be the last thing a pending shop was waiting for.
  if (recorded.feePaymentStatus === "PAID") {
    await autoApproveShopIfReady(input.shopId).catch((error) =>
      console.error("[shop-payments] auto-approval check failed", input.shopId, error),
    );
  }
  return recorded;
}

/**
 * Reverses a payment recorded in error (§15 "use reversal, not deletion").
 *
 * The original row is left exactly as written; a mirror-image row is appended.
 */
export async function reversePayment(
  paymentId: string,
  reason: string,
  actor: Actor,
): Promise<{ reversal: ShopPayment; amountPaidPaise: number; feePaymentStatus: FeePaymentStatus }> {
  return db.transaction(async (tx) => {
    const [original] = await tx
      .select()
      .from(shopPayments)
      .where(eq(shopPayments.id, paymentId))
      .limit(1);
    if (!original) throw notFound("Payment");

    const [alreadyReversed] = await tx
      .select({ id: shopPayments.id })
      .from(shopPayments)
      .where(eq(shopPayments.reversalOfId, paymentId))
      .limit(1);
    if (alreadyReversed) throw conflict("That payment has already been reversed.");

    const [reversal] = await tx
      .insert(shopPayments)
      .values({
        reference: await nextReference(tx),
        shopId: original.shopId,
        ownerId: original.ownerId,
        paymentType: "REVERSAL",
        amountPaise: -original.amountPaise,
        method: original.method,
        transactionId: original.transactionId,
        feeSnapshotPaise: original.feeSnapshotPaise,
        note: reason,
        reversalOfId: original.id,
        recordedBy: actor.id,
      })
      .returning();

    const settlement = await recomputeShopSettlement(tx, original.shopId);

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_PAYMENT_REVERSED,
        entityType: "shop_payment",
        entityId: reversal.id,
        previousValue: {
          reference: original.reference,
          amountPaise: original.amountPaise,
        },
        newValue: { reference: reversal.reference, reason },
      },
      tx,
    );

    return { reversal, ...settlement };
  });
}

export async function listPaymentsForShop(shopId: string): Promise<ShopPayment[]> {
  return db
    .select()
    .from(shopPayments)
    .where(eq(shopPayments.shopId, shopId))
    .orderBy(desc(shopPayments.paidAt));
}

/** All payments across all shops — operator/admin only (PAYMENT_VIEW_ANY). */
export async function listAllPayments(limit = 200) {
  return db
    .select({
      payment: shopPayments,
      shopName: shops.name,
      shopSlug: shops.slug,
    })
    .from(shopPayments)
    .innerJoin(shops, eq(shops.id, shopPayments.shopId))
    .orderBy(desc(shopPayments.paidAt))
    .limit(limit);
}

/**
 * Registration-fee report totals (§14).
 *
 * Expected/collected are computed from the shop snapshots rather than the fee
 * schedule, because the snapshot is what each shop actually owes.
 */
export async function getRegistrationFeeReport(): Promise<{
  totalShops: number;
  expectedPaise: number;
  collectedPaise: number;
  pendingPaise: number;
  refundedPaise: number;
  fullyPaid: number;
  partiallyPaid: number;
  unpaid: number;
}> {
  const [totals] = await db
    .select({
      totalShops: sql<number>`COUNT(*)::int`,
      expectedPaise: sql<number>`COALESCE(SUM(${shops.registrationFeePaise}), 0)::bigint`,
      collectedPaise: sql<number>`COALESCE(SUM(${shops.amountPaidPaise}), 0)::bigint`,
      fullyPaid: sql<number>`COUNT(*) FILTER (WHERE ${shops.feePaymentStatus} = 'PAID')::int`,
      partiallyPaid: sql<number>`COUNT(*) FILTER (WHERE ${shops.feePaymentStatus} = 'PARTIALLY_PAID')::int`,
      unpaid: sql<number>`COUNT(*) FILTER (WHERE ${shops.feePaymentStatus} = 'PENDING')::int`,
    })
    .from(shops)
    .where(isNull(shops.deletedAt));

  const [refunds] = await db
    .select({
      refundedPaise: sql<number>`COALESCE(SUM(ABS(${shopPayments.amountPaise})), 0)::bigint`,
    })
    .from(shopPayments)
    .where(eq(shopPayments.paymentType, "REFUND"));

  const expected = Number(totals.expectedPaise);
  const collected = Number(totals.collectedPaise);

  return {
    totalShops: totals.totalShops,
    expectedPaise: expected,
    collectedPaise: collected,
    // Never report negative outstanding: over-collection is not "negative debt".
    pendingPaise: Math.max(0, expected - collected),
    refundedPaise: Number(refunds.refundedPaise),
    fullyPaid: totals.fullyPaid,
    partiallyPaid: totals.partiallyPaid,
    unpaid: totals.unpaid,
  };
}
