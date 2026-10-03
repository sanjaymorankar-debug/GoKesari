/**
 * MRP governance.
 *
 * The master MRP is written only by operations (product-master.ts
 * setMasterMrp: role-gated, history-appended, audited). This module adds the
 * rest of the discipline around it:
 *
 *  - a selling price above a (verified) MRP is refused when a shop sets it —
 *    `assertPriceWithinMrp`, governed by the `mrp` rule;
 *  - lowering an MRP below prices shops already charge never edits those
 *    prices; the affected shops are told and operations see the list;
 *  - a shop that believes the MRP is wrong raises a correction, decided by
 *    operations, with the claimed figure kept until then.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { forbidden, notFound, validationFailed } from "@/lib/errors";
import { db, type DbClient } from "@/server/db";
import {
  mrpCorrections,
  products,
  shopProducts,
  shops,
  type MrpCorrection,
  type MrpSource,
  type Product,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { NOTIFICATION_TYPES, notify } from "./notifications";
import { setMasterMrp, submitMrpCorrection } from "./product-master";
import { getRule } from "./settings";
import { insertReturning, updateReturning } from "@/server/db/returning";

interface Actor {
  id: string;
  role: UserRole;
}

export interface MrpViolation {
  channel: "ONLINE" | "OFFLINE";
  pricePaise: number;
  mrpPaise: number;
}

/** Which of a shop's prices exceed the product's MRP, and whether that is currently enforced. */
export async function checkPriceAgainstMrp(
  productId: string,
  prices: { online?: number | null; offline?: number | null },
  client: DbClient = db,
): Promise<{ enforced: boolean; violations: MrpViolation[] }> {
  const [product] = await client
    .select({
      kind: products.kind,
      mrpPaise: products.mrpPaise,
      status: products.mrpVerificationStatus,
    })
    .from(products)
    .where(eq(products.id, productId));
  if (!product || product.kind !== "PACKAGED" || product.mrpPaise == null)
    return { enforced: false, violations: [] };

  const rules = await getRule("mrp");
  const limit = product.mrpPaise + rules.tolerancePaise;
  const violations: MrpViolation[] = [];
  if (prices.online != null && prices.online > limit) {
    violations.push({
      channel: "ONLINE",
      pricePaise: prices.online,
      mrpPaise: product.mrpPaise,
    });
  }
  if (prices.offline != null && prices.offline > limit) {
    violations.push({
      channel: "OFFLINE",
      pricePaise: prices.offline,
      mrpPaise: product.mrpPaise,
    });
  }
  const enforced =
    rules.enforceOn === "ANY" ||
    (rules.enforceOn === "VERIFIED" && product.status === "VERIFIED");
  return { enforced, violations };
}

/** Throws when an enforced MRP is exceeded — called wherever a shop's selling price is written. */
export async function assertPriceWithinMrp(
  productId: string,
  prices: { online?: number | null; offline?: number | null },
  client: DbClient = db,
): Promise<void> {
  const { enforced, violations } = await checkPriceAgainstMrp(
    productId,
    prices,
    client,
  );
  if (!enforced || violations.length === 0) return;
  const v = violations[0];
  throw validationFailed(
    `The ${v.channel.toLowerCase()} price ₹${(v.pricePaise / 100).toFixed(2)} is above the MRP of ₹${(v.mrpPaise / 100).toFixed(2)}. A product cannot be sold above its MRP.`,
    {
      fields: {
        [v.channel === "ONLINE" ? "onlinePricePaise" : "offlinePricePaise"]:
          "Above the MRP",
      },
    },
  );
}

export interface SetMrpInput {
  productId: string;
  mrpPaise: number;
  source: MrpSource;
  effectiveFrom?: string | null;
  reason?: string | null;
}

/**
 * Sets the master MRP (operations only) and, if it now sits below prices shops
 * already charge, tells those shops. Their prices are never edited here.
 */
export async function changeMasterMrp(
  input: SetMrpInput,
  actor: Actor,
): Promise<{ product: Product; conflicts: number }> {
  const product = await setMasterMrp(input, actor);
  const rows = await db
    .select({
      id: shopProducts.id,
      shopId: shopProducts.shopId,
      ownerId: shops.ownerId,
      online: shopProducts.onlinePricePaise,
      offline: shopProducts.offlinePricePaise,
    })
    .from(shopProducts)
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(
      and(
        eq(shopProducts.productId, input.productId),
        isNull(shopProducts.deletedAt),
        sql`(${shopProducts.onlinePricePaise} > ${input.mrpPaise} OR ${shopProducts.offlinePricePaise} > ${input.mrpPaise})`,
      ),
    );
  if (product.kind === "PACKAGED" && rows.length > 0) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.MRP_CONFLICT_DETECTED,
      entityType: "product",
      entityId: input.productId,
      newValue: {
        mrpPaise: input.mrpPaise,
        shopProductIds: rows.map((r) => r.id),
      },
    });
    for (const row of rows) {
      await notify({
        userId: row.ownerId,
        type: NOTIFICATION_TYPES.PRICE_CHANGED,
        title: "A selling price is above the new MRP",
        body: `The MRP of ${product.name} is now ₹${(input.mrpPaise / 100).toFixed(2)}. Please lower your price to no more than that.`,
        actionUrl: "/shop",
        dedupeKey: `mrp-conflict:${row.id}:${input.mrpPaise}`,
      });
    }
  }
  return { product, conflicts: product.kind === "PACKAGED" ? rows.length : 0 };
}

/* ------------------------------------------------------------ corrections */

/** A shop owner disputes the MRP. The claim is stored; the master value is untouched. */
export async function raiseCorrection(
  input: {
    productId: string;
    shopId?: string | null;
    claimedMrpPaise: number;
    note?: string | null;
  },
  actor: Actor,
): Promise<MrpCorrection> {
  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, input.productId));
  if (!product) throw notFound("Product");
  if (input.shopId) {
    const [shop] = await db
      .select({ ownerId: shops.ownerId })
      .from(shops)
      .where(eq(shops.id, input.shopId));
    if (
      !shop ||
      (shop.ownerId !== actor.id &&
        actor.role !== "ADMIN" &&
        actor.role !== "OPERATOR")
    ) {
      throw forbidden("This shop does not belong to you.");
    }
  }
  const [open] = await db
    .select({ id: mrpCorrections.id })
    .from(mrpCorrections)
    .where(
      and(
        eq(mrpCorrections.productId, input.productId),
        eq(mrpCorrections.status, "PENDING"),
      ),
    );
  if (open)
    throw validationFailed(
      "An MRP correction for this product is already waiting for review.",
    );

  // Existing service: validates, marks the product PENDING_VERIFICATION, audits the claim.
  await submitMrpCorrection(
    input.productId,
    input.claimedMrpPaise,
    actor,
    input.note ?? undefined,
  );
  const [row] = await insertReturning(db, mrpCorrections, {
    productId: input.productId,
    shopId: input.shopId ?? null,
    claimedMrpPaise: input.claimedMrpPaise,
    note: input.note?.trim() || null,
    submittedBy: actor.id,
    previousVerificationStatus: product.mrpVerificationStatus,
  });
  return row;
}

export async function decideCorrection(
  id: string,
  decision: "ACCEPT" | "REJECT",
  note: string,
  actor: Actor,
  mrpPaise?: number,
): Promise<MrpCorrection> {
  if (actor.role !== "ADMIN" && actor.role !== "OPERATOR")
    throw forbidden("Only operations can decide an MRP correction.");
  if (note.trim().length < 3)
    throw validationFailed("Record the reason for the decision.");
  const [correction] = await db
    .select()
    .from(mrpCorrections)
    .where(eq(mrpCorrections.id, id));
  if (!correction) throw notFound("MRP correction");
  if (correction.status !== "PENDING")
    throw validationFailed("This correction has already been decided.");

  let applied: number | null = null;
  if (decision === "ACCEPT") {
    applied = mrpPaise ?? correction.claimedMrpPaise;
    await changeMasterMrp(
      {
        productId: correction.productId,
        mrpPaise: applied,
        source: "ADMIN",
        reason: `Accepted correction: ${note.trim()}`,
      },
      actor,
    );
  } else {
    await db
      .update(products)
      .set({
        mrpVerificationStatus:
          (correction.previousVerificationStatus as
            | Product["mrpVerificationStatus"]
            | null) ?? "UNVERIFIED",
      })
      .where(eq(products.id, correction.productId));
  }
  const [row] = await updateReturning(
    db,
    mrpCorrections,
    {
      status: decision === "ACCEPT" ? "ACCEPTED" : "REJECTED",
      decidedBy: actor.id,
      decidedAt: new Date(),
      decisionNote: note.trim(),
      appliedMrpPaise: applied,
    },
    eq(mrpCorrections.id, id),
  );
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.MRP_CORRECTION_DECIDED,
    entityType: "product",
    entityId: correction.productId,
    newValue: { correctionId: id, decision, appliedMrpPaise: applied, note },
  });
  return row;
}

/* --------------------------------------------------------------- overview */

export async function listCorrections(
  status: MrpCorrection["status"] = "PENDING",
) {
  return db
    .select({
      correction: mrpCorrections,
      productName: products.name,
      productCode: products.code,
      currentMrpPaise: products.mrpPaise,
      shopName: shops.name,
    })
    .from(mrpCorrections)
    .innerJoin(products, eq(mrpCorrections.productId, products.id))
    .leftJoin(shops, eq(mrpCorrections.shopId, shops.id))
    .where(eq(mrpCorrections.status, status))
    .orderBy(desc(mrpCorrections.createdAt))
    .limit(200);
}

/** Shop listings whose price is above the master MRP, whatever the enforcement setting. */
export async function listMrpViolations(limit = 200) {
  return db
    .select({
      shopProductId: shopProducts.id,
      shopName: shops.name,
      productName: products.name,
      productCode: products.code,
      mrpPaise: products.mrpPaise,
      onlinePricePaise: shopProducts.onlinePricePaise,
      offlinePricePaise: shopProducts.offlinePricePaise,
      verification: products.mrpVerificationStatus,
    })
    .from(shopProducts)
    .innerJoin(products, eq(shopProducts.productId, products.id))
    .innerJoin(shops, eq(shopProducts.shopId, shops.id))
    .where(
      and(
        isNull(shopProducts.deletedAt),
        eq(products.kind, "PACKAGED"),
        sql`${products.mrpPaise} IS NOT NULL`,
        sql`(${shopProducts.onlinePricePaise} > ${products.mrpPaise} OR ${shopProducts.offlinePricePaise} > ${products.mrpPaise})`,
      ),
    )
    .limit(Math.min(limit, 1000));
}

/** Counts by verification status — the headline of the governance page. */
export async function mrpVerificationSummary() {
  const rows = await db
    .select({
      status: products.mrpVerificationStatus,
      n: sql<number>`CAST(count(*) AS SIGNED)`,
    })
    .from(products)
    .where(and(isNull(products.deletedAt), eq(products.kind, "PACKAGED")))
    .groupBy(products.mrpVerificationStatus);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Record<
    string,
    number
  >;
}
