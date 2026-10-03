/**
 * External price references.
 *
 * Three different numbers must never be confused:
 *   MRP                     — the printed maximum retail price (products.mrp_paise)
 *   Gokesari selling price  — what a shop charges (shop_products.*_price_paise)
 *   External reference price— what some outside source shows (this module)
 *
 * A reference is information for operations and, where allowed, for shops
 * setting prices. This module never writes to the other two, and nothing
 * calls it to "sync" a price. Every change is appended to
 * external_price_reference_history and audited.
 */
import { and, desc, eq, gte } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import {
  externalPriceReferenceHistory,
  externalPriceReferences,
  products,
  type ExternalPriceReference,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { getRule } from "./settings";
import { insertReturning, updateReturning } from "@/server/db/returning";

interface Actor {
  id: string;
  role: UserRole;
}

const STAFF: readonly UserRole[] = ["OPERATOR", "ADMIN"];

/** Accepts a product uuid or its stable code ("P00042") — operators type codes, not uuids. */
export async function resolveProductId(idOrCode: string): Promise<string> {
  const value = idOrCode.trim();
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    );
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(
      isUuid ? eq(products.id, value) : eq(products.code, value.toUpperCase()),
    );
  if (!row) throw notFound("Product");
  return row.id;
}

export interface ReferenceInput {
  productId: string;
  pricePaise: number;
  unitBasis?: string | null;
  sourceType: ExternalPriceReference["sourceType"];
  sourceName: string;
  sourceIdentifier?: string | null;
  referenceUrl?: string | null;
  marketLocation?: string | null;
  pincode?: string | null;
  referencedAt: Date;
}

function validate(input: ReferenceInput): void {
  if (!Number.isInteger(input.pricePaise) || input.pricePaise <= 0) {
    throw validationFailed(
      "The reference price must be a whole amount in paise, above zero.",
    );
  }
  if (!input.sourceName.trim())
    throw validationFailed("Name the source of this price.");
  if (Number.isNaN(input.referencedAt.getTime()))
    throw validationFailed("Give the date this price was observed.");
  if (input.referencedAt.getTime() > Date.now() + 5 * 60_000) {
    throw validationFailed("A price cannot be observed in the future.");
  }
  if (input.referenceUrl) {
    try {
      const url = new URL(input.referenceUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("scheme");
    } catch {
      throw validationFailed(
        "The reference URL must start with http:// or https://.",
      );
    }
  }
  if (input.pincode && !/^\d{6}$/.test(input.pincode))
    throw validationFailed("PIN code must be 6 digits.");
}

const snapshot = (r: ExternalPriceReference) => ({
  pricePaise: r.pricePaise,
  unitBasis: r.unitBasis,
  sourceType: r.sourceType,
  sourceName: r.sourceName,
  sourceIdentifier: r.sourceIdentifier,
  referenceUrl: r.referenceUrl,
  marketLocation: r.marketLocation,
  pincode: r.pincode,
  referencedAt: r.referencedAt.toISOString(),
  verificationStatus: r.verificationStatus,
});

function assertStaff(actor: Actor) {
  if (!STAFF.includes(actor.role))
    throw forbidden("Only operations can manage reference prices.");
}

export async function createReference(
  input: ReferenceInput,
  actor: Actor,
): Promise<ExternalPriceReference> {
  assertStaff(actor);
  validate(input);
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, input.productId));
  if (!product) throw notFound("Product");

  return db.transaction(async (tx) => {
    const [row] = await insertReturning(tx, externalPriceReferences, {
      productId: input.productId,
      pricePaise: input.pricePaise,
      unitBasis: input.unitBasis?.trim() || null,
      sourceType: input.sourceType,
      sourceName: input.sourceName.trim(),
      sourceIdentifier: input.sourceIdentifier?.trim() || null,
      referenceUrl: input.referenceUrl?.trim() || null,
      marketLocation: input.marketLocation?.trim() || null,
      pincode: input.pincode?.trim() || null,
      referencedAt: input.referencedAt,
      createdBy: actor.id,
    });
    await tx.insert(externalPriceReferenceHistory).values({
      referenceId: row.id,
      action: "CREATED",
      previous: null,
      next: snapshot(row),
      actorId: actor.id,
      actorRole: actor.role,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRICE_REFERENCE_SAVED,
        entityType: "external_price_reference",
        entityId: row.id,
        newValue: snapshot(row),
      },
      tx,
    );
    return row;
  });
}

/** Edits are allowed only while a reference is unverified; a verified price is corrected by reopening it. */
export async function updateReference(
  id: string,
  patch: Partial<Omit<ReferenceInput, "productId">>,
  actor: Actor,
): Promise<ExternalPriceReference> {
  assertStaff(actor);
  const [current] = await db
    .select()
    .from(externalPriceReferences)
    .where(eq(externalPriceReferences.id, id));
  if (!current) throw notFound("Reference price");
  if (current.verificationStatus !== "UNVERIFIED") {
    throw conflict(
      "Reopen a verified or rejected reference before editing it.",
    );
  }
  const merged: ReferenceInput = {
    productId: current.productId,
    pricePaise: patch.pricePaise ?? current.pricePaise,
    unitBasis:
      patch.unitBasis !== undefined ? patch.unitBasis : current.unitBasis,
    sourceType: patch.sourceType ?? current.sourceType,
    sourceName: patch.sourceName ?? current.sourceName,
    sourceIdentifier:
      patch.sourceIdentifier !== undefined
        ? patch.sourceIdentifier
        : current.sourceIdentifier,
    referenceUrl:
      patch.referenceUrl !== undefined
        ? patch.referenceUrl
        : current.referenceUrl,
    marketLocation:
      patch.marketLocation !== undefined
        ? patch.marketLocation
        : current.marketLocation,
    pincode: patch.pincode !== undefined ? patch.pincode : current.pincode,
    referencedAt: patch.referencedAt ?? current.referencedAt,
  };
  validate(merged);

  return db.transaction(async (tx) => {
    const [row] = await updateReturning(
      tx,
      externalPriceReferences,
      {
        pricePaise: merged.pricePaise,
        unitBasis: merged.unitBasis?.trim() || null,
        sourceType: merged.sourceType,
        sourceName: merged.sourceName.trim(),
        sourceIdentifier: merged.sourceIdentifier?.trim() || null,
        referenceUrl: merged.referenceUrl?.trim() || null,
        marketLocation: merged.marketLocation?.trim() || null,
        pincode: merged.pincode?.trim() || null,
        referencedAt: merged.referencedAt,
      },
      eq(externalPriceReferences.id, id),
    );
    await tx.insert(externalPriceReferenceHistory).values({
      referenceId: id,
      action: "EDITED",
      previous: snapshot(current),
      next: snapshot(row),
      actorId: actor.id,
      actorRole: actor.role,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.PRICE_REFERENCE_SAVED,
        entityType: "external_price_reference",
        entityId: id,
        previousValue: snapshot(current),
        newValue: snapshot(row),
      },
      tx,
    );
    return row;
  });
}

export async function decideReference(
  id: string,
  decision: "VERIFIED" | "REJECTED" | "UNVERIFIED",
  note: string | null,
  actor: Actor,
): Promise<ExternalPriceReference> {
  assertStaff(actor);
  if (decision === "REJECTED" && !note?.trim())
    throw validationFailed("Say why the reference is rejected.");
  const [current] = await db
    .select()
    .from(externalPriceReferences)
    .where(eq(externalPriceReferences.id, id));
  if (!current) throw notFound("Reference price");
  if (current.verificationStatus === decision)
    throw conflict(`That reference is already ${decision.toLowerCase()}.`);

  return db.transaction(async (tx) => {
    const [row] = await updateReturning(
      tx,
      externalPriceReferences,
      {
        verificationStatus: decision,
        verifiedBy: decision === "UNVERIFIED" ? null : actor.id,
        verifiedAt: decision === "UNVERIFIED" ? null : new Date(),
        verificationNote: note?.trim() || null,
      },
      eq(externalPriceReferences.id, id),
    );
    await tx.insert(externalPriceReferenceHistory).values({
      referenceId: id,
      action:
        decision === "VERIFIED"
          ? "VERIFIED"
          : decision === "REJECTED"
            ? "REJECTED"
            : "REOPENED",
      previous: snapshot(current),
      next: snapshot(row),
      note: note?.trim() || null,
      actorId: actor.id,
      actorRole: actor.role,
    });
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action:
          decision === "REJECTED"
            ? AUDIT_ACTIONS.PRICE_REFERENCE_REJECTED
            : AUDIT_ACTIONS.PRICE_REFERENCE_VERIFIED,
        entityType: "external_price_reference",
        entityId: id,
        previousValue: { verificationStatus: current.verificationStatus },
        newValue: { verificationStatus: decision, note: note ?? null },
      },
      tx,
    );
    return row;
  });
}

export type ReferenceViewer = "STAFF" | "SHOP" | "CUSTOMER";

/**
 * References for a product, shaped for who is asking. Operations see
 * everything; shops and customers see only VERIFIED, recent references, and
 * only when the `externalPrices` rule allows their audience (customer display
 * is off until decision D7).
 */
export async function listReferencesForProduct(
  productId: string,
  viewer: ReferenceViewer,
): Promise<ExternalPriceReference[]> {
  if (viewer !== "STAFF") {
    const rules = await getRule("externalPrices");
    if (viewer === "CUSTOMER" && !rules.showToCustomers) return [];
    if (viewer === "SHOP" && !rules.showToShops) return [];
    const since = new Date(Date.now() - rules.maxAgeDays * 86_400_000);
    return db
      .select()
      .from(externalPriceReferences)
      .where(
        and(
          eq(externalPriceReferences.productId, productId),
          eq(externalPriceReferences.verificationStatus, "VERIFIED"),
          gte(externalPriceReferences.referencedAt, since),
        ),
      )
      .orderBy(desc(externalPriceReferences.referencedAt))
      .limit(20);
  }
  return db
    .select()
    .from(externalPriceReferences)
    .where(eq(externalPriceReferences.productId, productId))
    .orderBy(desc(externalPriceReferences.referencedAt))
    .limit(100);
}

export async function listReferenceQueue(
  status: ExternalPriceReference["verificationStatus"] = "UNVERIFIED",
  limit = 100,
) {
  return db
    .select({
      reference: externalPriceReferences,
      productName: products.name,
      productCode: products.code,
    })
    .from(externalPriceReferences)
    .innerJoin(products, eq(externalPriceReferences.productId, products.id))
    .where(eq(externalPriceReferences.verificationStatus, status))
    .orderBy(desc(externalPriceReferences.createdAt))
    .limit(Math.min(limit, 500));
}

export async function getReferenceHistory(referenceId: string) {
  return db
    .select()
    .from(externalPriceReferenceHistory)
    .where(eq(externalPriceReferenceHistory.referenceId, referenceId))
    .orderBy(externalPriceReferenceHistory.createdAt);
}
