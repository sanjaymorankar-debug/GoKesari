/**
 * F6.1.3 (NEW-006, D10) — the after-packing cancellation fee.
 *
 * Admin sets the platform default and the limits (rule
 * afterPackingCancellation); a shop owner may set the shop's own fee within
 * those limits (shop_cancellation_fee_settings). The server refuses a shop
 * value above the limits, and caps a stored value again at quote time, so an
 * admin lowering a limit later takes effect at once.
 *
 * The fee only ever applies to a customer's own cancellation of a packed
 * order (READY, or ASSIGNED to a rider who has not picked it up) while the
 * rule is on. Everything else is unchanged (orders.ts cancelOrder).
 */
import { eq } from "drizzle-orm";

import { conflict, forbidden, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import type { RuleValue } from "@/server/config/rules";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db, type DbClient } from "@/server/db";
import {
  shopCancellationFeeSettings,
  shops,
  type OrderStatus,
  type ShopCancellationFeeSetting,
  type UserRole,
} from "@/server/db/schema";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";
import { getRule } from "@/server/services/settings";

export type FeeType = "FLAT" | "PERCENT";
type FeeRule = RuleValue<"afterPackingCancellation">;

/** Statuses at which the order counts as packed but not yet picked up by a rider. */
export const AFTER_PACKING_STATUSES: readonly OrderStatus[] = ["READY", "ASSIGNED"];

export interface FeePolicy {
  /** The fee is charged at all (rule on, and the shop has not switched it off). */
  active: boolean;
  feeType: FeeType;
  feePaise: number;
  feeBp: number;
  capPaise: number;
  source: "SHOP" | "PLATFORM_DEFAULT";
}

export interface FeeQuote {
  amountPaise: number;
  basis: {
    feeType: FeeType;
    feePaise: number;
    feeBp: number;
    capPaise: number;
    source: FeePolicy["source"];
    goodsPaise: number;
    /** The fee was cut down to what the customer paid. */
    limitedToPaid: boolean;
  };
}

/** Whether a customer may cancel a packed order at this status (the rule is on). */
export async function afterPackingCancellationOpen(status: OrderStatus): Promise<boolean> {
  if (!AFTER_PACKING_STATUSES.includes(status)) return false;
  return (await getRule("afterPackingCancellation")).enabled;
}

function clampPolicy(policy: Omit<FeePolicy, "active">, rule: FeeRule): Omit<FeePolicy, "active"> {
  return {
    ...policy,
    feePaise: Math.min(policy.feePaise, rule.maxFeePaise),
    feeBp: Math.min(policy.feeBp, rule.maxFeeBp),
    capPaise: Math.min(policy.capPaise, rule.maxFeePaise),
  };
}

/** The fee policy that applies to a shop right now (platform default unless the shop set its own). */
export async function effectiveFeePolicy(shopId: string, client: DbClient = db): Promise<FeePolicy> {
  const rule = await getRule("afterPackingCancellation");
  const platform = clampPolicy(
    {
      feeType: rule.defaultFeeType,
      feePaise: rule.defaultFeePaise,
      feeBp: rule.defaultFeeBp,
      capPaise: rule.defaultCapPaise,
      source: "PLATFORM_DEFAULT",
    },
    rule,
  );
  if (!rule.enabled) return { ...platform, active: false };
  if (!rule.shopOverrideAllowed) return { ...platform, active: true };
  const [own] = await client
    .select()
    .from(shopCancellationFeeSettings)
    .where(eq(shopCancellationFeeSettings.shopId, shopId));
  if (!own) return { ...platform, active: true };
  return {
    ...clampPolicy(
      {
        feeType: own.feeType,
        feePaise: own.feePaise,
        feeBp: own.feeBp,
        capPaise: own.capPaise ?? rule.maxFeePaise,
        source: "SHOP",
      },
      rule,
    ),
    active: own.enabled,
  };
}

/** The fee for an order under a policy: never more than the cap, the admin maximum, or what was paid. */
export function feeFor(policy: FeePolicy, order: { subtotalPaise: number; paidPaise: number }): FeeQuote {
  const raw =
    policy.feeType === "FLAT"
      ? policy.feePaise
      : Math.min(Math.round((order.subtotalPaise * policy.feeBp) / 10_000), policy.capPaise);
  const capped = policy.active ? Math.max(0, raw) : 0;
  const amountPaise = Math.min(capped, Math.max(0, order.paidPaise));
  return {
    amountPaise,
    basis: {
      feeType: policy.feeType,
      feePaise: policy.feePaise,
      feeBp: policy.feeBp,
      capPaise: policy.capPaise,
      source: policy.source,
      goodsPaise: order.subtotalPaise,
      limitedToPaid: amountPaise < capped,
    },
  };
}

/** Plain-words description of a fee policy ("₹20.00", "10% of the items, at most ₹50.00"). */
export function describeFeePolicy(policy: Pick<FeePolicy, "feeType" | "feePaise" | "feeBp" | "capPaise">): string {
  if (policy.feeType === "FLAT") return formatPaise(policy.feePaise);
  return `${(policy.feeBp / 100).toFixed(policy.feeBp % 100 === 0 ? 0 : 2)}% of the items, at most ${formatPaise(policy.capPaise)}`;
}

/* ------------------------------------------------------- shop settings */

interface Actor {
  id: string;
  role: UserRole;
}

async function assertShopFeeAccess(shopId: string, actor: Actor): Promise<void> {
  const [shop] = await db.select({ id: shops.id, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  if (shop.ownerId === actor.id) {
    if (!can(actor.role, PERMISSIONS.SHOP_CANCELLATION_FEE_MANAGE_OWN)) {
      throw forbidden("You cannot change this shop's cancellation fee.");
    }
    return;
  }
  if (!can(actor.role, PERMISSIONS.SHOP_UPDATE_ANY)) throw forbidden("This shop does not belong to you.");
}

export interface ShopFeeSettingsView {
  rule: FeeRule;
  own: ShopCancellationFeeSetting | null;
  effective: FeePolicy;
  effectiveLabel: string;
}

export async function getShopCancellationFeeSettings(shopId: string, actor: Actor): Promise<ShopFeeSettingsView> {
  await assertShopFeeAccess(shopId, actor);
  const rule = await getRule("afterPackingCancellation");
  const [own] = await db.select().from(shopCancellationFeeSettings).where(eq(shopCancellationFeeSettings.shopId, shopId));
  const effective = await effectiveFeePolicy(shopId);
  return { rule, own: own ?? null, effective, effectiveLabel: describeFeePolicy(effective) };
}

export interface ShopFeeInput {
  enabled: boolean;
  feeType: FeeType;
  feePaise?: number;
  feeBp?: number;
  capPaise?: number | null;
}

/**
 * The shop owner's own fee. Refused when the admin does not allow shop
 * overrides, or when any value is above the admin's limits.
 */
export async function setShopCancellationFee(
  shopId: string,
  input: ShopFeeInput,
  actor: Actor,
): Promise<ShopCancellationFeeSetting> {
  await assertShopFeeAccess(shopId, actor);
  const rule = await getRule("afterPackingCancellation");
  if (!rule.shopOverrideAllowed) {
    throw conflict("GoKesari has not allowed shops to set their own cancellation fee — the platform fee applies.");
  }
  const feePaise = input.feePaise ?? 0;
  const feeBp = input.feeBp ?? 0;
  const capPaise = input.capPaise ?? null;
  const fields: Record<string, string> = {};
  const isInt = (n: number) => Number.isInteger(n) && n >= 0;
  if (!isInt(feePaise)) fields.feePaise = "Enter the fee in whole paise.";
  else if (feePaise > rule.maxFeePaise) fields.feePaise = `The fee can be at most ${formatPaise(rule.maxFeePaise)}.`;
  if (!isInt(feeBp)) fields.feeBp = "Enter the percentage in basis points (1000 = 10%).";
  else if (feeBp > rule.maxFeeBp) fields.feeBp = `The percentage can be at most ${(rule.maxFeeBp / 100).toFixed(2)}%.`;
  if (capPaise !== null) {
    if (!isInt(capPaise)) fields.capPaise = "Enter the cap in whole paise.";
    else if (capPaise > rule.maxFeePaise) fields.capPaise = `The cap can be at most ${formatPaise(rule.maxFeePaise)}.`;
  }
  if (input.feeType === "PERCENT" && feeBp === 0 && input.enabled) fields.feeBp = "Enter the percentage.";
  if (Object.keys(fields).length > 0) {
    throw validationFailed("That fee is outside the limits GoKesari allows.", { fields });
  }

  const [previous] = await db.select().from(shopCancellationFeeSettings).where(eq(shopCancellationFeeSettings.shopId, shopId));
  const values = {
    enabled: input.enabled,
    feeType: input.feeType,
    feePaise,
    feeBp,
    capPaise,
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(shopCancellationFeeSettings)
    .values({ shopId, ...values })
    .onConflictDoUpdate({ target: shopCancellationFeeSettings.shopId, set: values })
    .returning();
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_CANCELLATION_FEE_CHANGED,
    entityType: "shop",
    entityId: shopId,
    previousValue: previous ? { enabled: previous.enabled, feeType: previous.feeType, feePaise: previous.feePaise, feeBp: previous.feeBp, capPaise: previous.capPaise } : null,
    newValue: { enabled: row.enabled, feeType: row.feeType, feePaise: row.feePaise, feeBp: row.feeBp, capPaise: row.capPaise },
  });
  return row;
}

/** Back to the platform default. */
export async function resetShopCancellationFee(shopId: string, actor: Actor): Promise<void> {
  await assertShopFeeAccess(shopId, actor);
  await db.delete(shopCancellationFeeSettings).where(eq(shopCancellationFeeSettings.shopId, shopId));
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.SHOP_CANCELLATION_FEE_CHANGED,
    entityType: "shop",
    entityId: shopId,
    newValue: { reset: true },
  });
}
