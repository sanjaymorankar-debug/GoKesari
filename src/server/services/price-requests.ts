/**
 * Price update approval workflow (requirements §2.4, §7, §10, §25.7–§25.10).
 *
 * The rule the whole file turns on:
 *
 *   SHOP_OWNER edits their own price  → live immediately
 *   OPERATOR proposes a price         → PENDING, awaiting that owner's decision
 *   ADMIN                             → may decide, or override straight to live
 *
 * A pending request never touches `shop_products`. The live price changes in
 * exactly one place — `applyApprovedRequest()` — which delegates to
 * `updateShopProduct()` so that price history and audit entries are written by
 * the same code path as a direct edit. There is no second way for a price to
 * move.
 */
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  priceUpdateBatches,
  priceUpdateRequests,
  products,
  shopProducts,
  shops,
  type PriceRequestSource,
  type PriceUpdateBatch,
  type PriceUpdateRequest,
  type UserRole,
} from "@/server/db/schema";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { updateShopProduct } from "./catalogue";
import { insertReturning } from "@/server/db/returning";

interface Actor {
  id: string;
  role: UserRole;
}

export type PriceChannel = "ONLINE" | "OFFLINE";

export interface ProposedChange {
  shopProductId: string;
  priceType: PriceChannel;
  proposedPricePaise: number;
}

/**
 * Maps a role to the `source` recorded on the request. Kept separate from the
 * role itself so the review UI can say "Operator" without re-deriving it.
 */
function sourceForRole(role: UserRole): PriceRequestSource {
  if (role === "ADMIN") return "ADMIN";
  if (role === "OPERATOR") return "OPERATOR";
  return "SHOP_OWNER";
}

/**
 * True when this actor's price edits apply immediately rather than queueing.
 *
 * An owner editing their own shop is the whole point of §10's "becomes live
 * according to the configured business rule"; an admin can always override.
 */
export function appliesImmediately(actor: Actor, shopOwnerId: string): boolean {
  if (actor.id === shopOwnerId) return true;
  return can(actor.role, PERMISSIONS.PRICE_REQUEST_OVERRIDE);
}

/**
 * Creates a PENDING batch of proposed price changes.
 *
 * Any earlier PENDING request for the same (shop product, channel) is marked
 * SUPERSEDED, so an owner reviewing their queue only ever sees the current
 * proposal for a product rather than a stack of stale ones.
 */
export async function submitPriceRequests(
  input: {
    shopId: string;
    changes: readonly ProposedChange[];
    note?: string | null;
    excelUploadId?: string | null;
  },
  actor: Actor,
  client?: DbClient,
): Promise<{ batch: PriceUpdateBatch; requests: PriceUpdateRequest[] }> {
  if (input.changes.length === 0) {
    throw validationFailed("No price changes were supplied.");
  }

  const run = async (tx: DbClient) => {
    const [shop] = await tx
      .select({ id: shops.id, ownerId: shops.ownerId })
      .from(shops)
      .where(and(eq(shops.id, input.shopId), isNull(shops.deletedAt)))
      .limit(1);
    if (!shop) throw notFound("Shop");

    // Every target must belong to this shop. This is the IDOR guard for the
    // bulk path: a caller cannot smuggle another shop's product id into the
    // array and have it priced.
    const ids = input.changes.map((c) => c.shopProductId);
    const owned = await tx
      .select({ id: shopProducts.id })
      .from(shopProducts)
      .where(
        and(
          inArray(shopProducts.id, ids),
          eq(shopProducts.shopId, input.shopId),
          isNull(shopProducts.deletedAt),
        ),
      );
    const ownedIds = new Set(owned.map((r) => r.id));
    const stray = ids.filter((id) => !ownedIds.has(id));
    if (stray.length > 0) {
      throw forbidden("One or more products do not belong to this shop.");
    }

    const source = sourceForRole(actor.role);

    const [batch] = await insertReturning(tx, priceUpdateBatches, {
      shopId: input.shopId,
      source,
      submittedBy: actor.id,
      excelUploadId: input.excelUploadId ?? null,
      status: "PENDING",
      note: input.note ?? null,
    });

    const created: PriceUpdateRequest[] = [];

    for (const change of input.changes) {
      if (
        !Number.isInteger(change.proposedPricePaise) ||
        change.proposedPricePaise < 0
      ) {
        throw validationFailed(
          "Every proposed price must be a whole number of paise, zero or more.",
        );
      }

      const [current] = await tx
        .select({
          onlinePricePaise: shopProducts.onlinePricePaise,
          offlinePricePaise: shopProducts.offlinePricePaise,
        })
        .from(shopProducts)
        .where(eq(shopProducts.id, change.shopProductId))
        .limit(1);

      const previous =
        change.priceType === "ONLINE"
          ? (current?.onlinePricePaise ?? null)
          : (current?.offlinePricePaise ?? null);

      // Retire any older pending proposal for the same target.
      await tx
        .update(priceUpdateRequests)
        .set({ status: "SUPERSEDED", decidedAt: new Date() })
        .where(
          and(
            eq(priceUpdateRequests.shopProductId, change.shopProductId),
            eq(priceUpdateRequests.priceType, change.priceType),
            eq(priceUpdateRequests.status, "PENDING"),
          ),
        );

      const [request] = await insertReturning(tx, priceUpdateRequests, {
        batchId: batch.id,
        shopId: input.shopId,
        shopProductId: change.shopProductId,
        priceType: change.priceType,
        previousPricePaise: previous,
        proposedPricePaise: change.proposedPricePaise,
        status: "PENDING",
        source,
        submittedBy: actor.id,
      });
      created.push(request);
    }

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRICE_REQUEST_SUBMITTED,
        entityType: "price_update_batch",
        entityId: batch.id,
        newValue: {
          shopId: input.shopId,
          source,
          count: created.length,
          excelUploadId: input.excelUploadId ?? null,
        },
      },
      tx,
    );

    return { batch, requests: created };
  };

  return client ? run(client) : db.transaction(run);
}

/**
 * Authorises a decision on a request.
 *
 * An owner may decide requests against their own shop; an admin may decide any.
 * An operator may decide *nothing* — that separation is the point of §7.
 */
async function assertMayDecide(
  tx: DbClient,
  shopId: string,
  actor: Actor,
): Promise<void> {
  if (can(actor.role, PERMISSIONS.PRICE_REQUEST_DECIDE_ANY)) return;

  const [shop] = await tx
    .select({ ownerId: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  if (!shop) throw notFound("Shop");

  if (
    shop.ownerId === actor.id &&
    can(actor.role, PERMISSIONS.PRICE_REQUEST_DECIDE_OWN)
  ) {
    return;
  }
  throw forbidden("You cannot decide price updates for this shop.");
}

/**
 * Writes an approved proposal through to the live price.
 *
 * Routed through `updateShopProduct` on purpose: price history, the
 * price-changed audit entry and the online/offline pricing invariants are all
 * enforced there, and duplicating them here would be a second source of truth.
 */
async function applyApprovedRequest(
  tx: DbClient,
  request: PriceUpdateRequest,
  actor: Actor,
): Promise<void> {
  const patch =
    request.priceType === "ONLINE"
      ? { onlinePricePaise: request.proposedPricePaise }
      : { offlinePricePaise: request.proposedPricePaise };

  await updateShopProduct(
    request.shopProductId,
    patch,
    { id: actor.id, role: actor.role as "SHOP_OWNER" | "OPERATOR" | "ADMIN" },
    tx,
  );
}

export async function decideRequests(
  input: {
    requestIds: readonly string[];
    decision: "APPROVED" | "REJECTED";
    rejectionReason?: string | null;
  },
  actor: Actor,
): Promise<{ approved: number; rejected: number }> {
  if (input.requestIds.length === 0) {
    throw validationFailed("Select at least one price update to decide.");
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(priceUpdateRequests)
      .where(inArray(priceUpdateRequests.id, [...input.requestIds]))
      .for("update");

    if (rows.length === 0) throw notFound("Price update request");

    const pending = rows.filter((r) => r.status === "PENDING");
    if (pending.length === 0) {
      throw conflict("Those price updates have already been decided.");
    }

    // Authorise once per distinct shop rather than per row.
    for (const shopId of new Set(pending.map((r) => r.shopId))) {
      await assertMayDecide(tx, shopId, actor);
    }

    let approved = 0;
    let rejected = 0;

    for (const request of pending) {
      await tx
        .update(priceUpdateRequests)
        .set({
          status: input.decision,
          decidedBy: actor.id,
          decidedAt: new Date(),
          rejectionReason:
            input.decision === "REJECTED"
              ? (input.rejectionReason ?? null)
              : null,
          appliedAt: input.decision === "APPROVED" ? new Date() : null,
        })
        .where(eq(priceUpdateRequests.id, request.id));

      if (input.decision === "APPROVED") {
        await applyApprovedRequest(tx, request, actor);
        approved += 1;
      } else {
        // §25.9 — a rejected update leaves the live price exactly as it was.
        rejected += 1;
      }

      await recordAudit(
        {
          actorId: actor.id,
          actorRole: actor.role,
          action:
            input.decision === "APPROVED"
              ? AUDIT_ACTIONS.PRICE_REQUEST_APPROVED
              : AUDIT_ACTIONS.PRICE_REQUEST_REJECTED,
          entityType: "price_update_request",
          entityId: request.id,
          previousValue: { price: request.previousPricePaise },
          newValue: {
            price: request.proposedPricePaise,
            priceType: request.priceType,
            reason: input.rejectionReason ?? null,
          },
        },
        tx,
      );
    }

    await closeSettledBatches(tx, [...new Set(pending.map((r) => r.batchId))]);
    return { approved, rejected };
  });
}

/** Decides every pending request in a batch — the "Approve all" path (§2.4). */
export async function decideBatch(
  batchId: string,
  decision: "APPROVED" | "REJECTED",
  actor: Actor,
  rejectionReason?: string | null,
): Promise<{ approved: number; rejected: number }> {
  const pending = await db
    .select({ id: priceUpdateRequests.id })
    .from(priceUpdateRequests)
    .where(
      and(
        eq(priceUpdateRequests.batchId, batchId),
        eq(priceUpdateRequests.status, "PENDING"),
      ),
    );
  if (pending.length === 0) {
    throw conflict("This batch has no updates awaiting a decision.");
  }
  return decideRequests(
    { requestIds: pending.map((r) => r.id), decision, rejectionReason },
    actor,
  );
}

/**
 * A batch is closed once nothing in it is still PENDING. Its status reflects
 * whether anything was approved, so the history list reads sensibly.
 */
async function closeSettledBatches(
  tx: DbClient,
  batchIds: readonly string[],
): Promise<void> {
  for (const batchId of batchIds) {
    const remaining = await tx
      .select({ id: priceUpdateRequests.id })
      .from(priceUpdateRequests)
      .where(
        and(
          eq(priceUpdateRequests.batchId, batchId),
          eq(priceUpdateRequests.status, "PENDING"),
        ),
      )
      .limit(1);
    if (remaining.length > 0) continue;

    const decided = await tx
      .select({ status: priceUpdateRequests.status })
      .from(priceUpdateRequests)
      .where(eq(priceUpdateRequests.batchId, batchId));

    const anyApproved = decided.some((r) => r.status === "APPROVED");
    await tx
      .update(priceUpdateBatches)
      .set({
        status: anyApproved ? "APPROVED" : "REJECTED",
        decidedAt: new Date(),
      })
      .where(eq(priceUpdateBatches.id, batchId));
  }
}

/**
 * Admin override (§10, §11): forces a proposal live without the owner's
 * approval. Separated from `decideRequests` so it is impossible to reach
 * accidentally and trivially greppable in the audit log.
 */
export async function overrideRequest(
  requestId: string,
  actor: Actor,
  reason?: string | null,
): Promise<void> {
  if (!can(actor.role, PERMISSIONS.PRICE_REQUEST_OVERRIDE)) {
    throw forbidden("Only an administrator may override a price update.");
  }

  await db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(priceUpdateRequests)
      .where(eq(priceUpdateRequests.id, requestId))
      .for("update")
      .limit(1);
    if (!request) throw notFound("Price update request");
    if (request.status !== "PENDING") {
      throw conflict("That price update has already been decided.");
    }

    await tx
      .update(priceUpdateRequests)
      .set({
        status: "APPROVED",
        decidedBy: actor.id,
        decidedAt: new Date(),
        appliedAt: new Date(),
      })
      .where(eq(priceUpdateRequests.id, requestId));

    await applyApprovedRequest(tx, request, actor);

    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRICE_REQUEST_OVERRIDDEN,
        entityType: "price_update_request",
        entityId: requestId,
        previousValue: { price: request.previousPricePaise },
        newValue: { price: request.proposedPricePaise, reason: reason ?? null },
      },
      tx,
    );

    await closeSettledBatches(tx, [request.batchId]);
  });
}

/* ------------------------------------------------------------------ reads */

export interface PendingRequestRow {
  id: string;
  batchId: string;
  shopId: string;
  shopName: string;
  shopProductId: string;
  productName: string;
  productCode: string;
  unit: string;
  priceType: PriceChannel;
  previousPricePaise: number | null;
  proposedPricePaise: number;
  source: PriceRequestSource;
  submittedBy: string;
  createdAt: Date;
}

/** The owner's "Pending Updates from Operator" queue (§2.4). */
export async function listPendingForShop(
  shopId: string,
): Promise<PendingRequestRow[]> {
  const rows = await db
    .select({
      request: priceUpdateRequests,
      productName: products.name,
      productCode: products.code,
      unit: products.unit,
      shopName: shops.name,
    })
    .from(priceUpdateRequests)
    .innerJoin(
      shopProducts,
      eq(shopProducts.id, priceUpdateRequests.shopProductId),
    )
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, priceUpdateRequests.shopId))
    .where(
      and(
        eq(priceUpdateRequests.shopId, shopId),
        eq(priceUpdateRequests.status, "PENDING"),
      ),
    )
    .orderBy(desc(priceUpdateRequests.createdAt));

  return rows.map((r) => ({
    id: r.request.id,
    batchId: r.request.batchId,
    shopId: r.request.shopId,
    shopName: r.shopName,
    shopProductId: r.request.shopProductId,
    productName: r.productName,
    productCode: r.productCode,
    unit: r.unit,
    priceType: r.request.priceType as PriceChannel,
    previousPricePaise: r.request.previousPricePaise,
    proposedPricePaise: r.request.proposedPricePaise,
    source: r.request.source,
    submittedBy: r.request.submittedBy,
    createdAt: r.request.createdAt,
  }));
}

/** Every pending request across all shops — the admin approvals queue (§11). */
export async function listAllPending(
  limit = 200,
): Promise<PendingRequestRow[]> {
  const rows = await db
    .select({
      request: priceUpdateRequests,
      productName: products.name,
      productCode: products.code,
      unit: products.unit,
      shopName: shops.name,
    })
    .from(priceUpdateRequests)
    .innerJoin(
      shopProducts,
      eq(shopProducts.id, priceUpdateRequests.shopProductId),
    )
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .innerJoin(shops, eq(shops.id, priceUpdateRequests.shopId))
    .where(eq(priceUpdateRequests.status, "PENDING"))
    .orderBy(desc(priceUpdateRequests.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.request.id,
    batchId: r.request.batchId,
    shopId: r.request.shopId,
    shopName: r.shopName,
    shopProductId: r.request.shopProductId,
    productName: r.productName,
    productCode: r.productCode,
    unit: r.unit,
    priceType: r.request.priceType as PriceChannel,
    previousPricePaise: r.request.previousPricePaise,
    proposedPricePaise: r.request.proposedPricePaise,
    source: r.request.source,
    submittedBy: r.request.submittedBy,
    createdAt: r.request.createdAt,
  }));
}

/** Decided history for one shop — §16 "Price Updates: approved / rejected". */
export async function listDecidedForShop(shopId: string, limit = 100) {
  return db
    .select({
      request: priceUpdateRequests,
      productName: products.name,
      unit: products.unit,
    })
    .from(priceUpdateRequests)
    .innerJoin(
      shopProducts,
      eq(shopProducts.id, priceUpdateRequests.shopProductId),
    )
    .innerJoin(products, eq(products.id, shopProducts.productId))
    .where(
      and(
        eq(priceUpdateRequests.shopId, shopId),
        ne(priceUpdateRequests.status, "PENDING"),
      ),
    )
    .orderBy(desc(priceUpdateRequests.decidedAt))
    .limit(limit);
}

export async function countPendingForShop(shopId: string): Promise<number> {
  const rows = await db
    .select({ id: priceUpdateRequests.id })
    .from(priceUpdateRequests)
    .where(
      and(
        eq(priceUpdateRequests.shopId, shopId),
        eq(priceUpdateRequests.status, "PENDING"),
      ),
    );
  return rows.length;
}
