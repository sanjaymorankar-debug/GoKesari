/**
 * Shop prepaid wallet (rule `shopWallet`, docs/shop-wallet-delivery-otp-2026-10).
 *
 *   owner tops up (Cashfree, payments.ts)          → TOP_UP        credit
 *   order DELIVERED (orders.ts updateOrderStatus)  → COMMISSION    debit  ┐ same transaction
 *                                                  → DELIVERY_CHARGE debit ┘ as the delivery
 *   admin correction                               → MANUAL_CREDIT / MANUAL_DEBIT
 *
 * The same three mechanisms as the customer wallet (wallet.ts), plus the
 * database's own enforcement (migration 0059):
 *  1. Row lock — every entry opens with `SELECT … FOR UPDATE` on the wallet,
 *     so concurrent entries for one shop serialise.
 *  2. Idempotency — every entry has a UNIQUE key, and an order can carry one
 *     COMMISSION and one DELIVERY_CHARGE only (partial unique index), so a
 *     retried delivery, a double tap or a replayed webhook never moves money
 *     twice.
 *  3. The ledger is the balance — this module never UPDATEs balance_paise. It
 *     inserts a ledger row; a trigger checks it against the locked wallet and
 *     applies it. Any other change to the balance is refused by the database.
 *
 * A delivered order is always charged, even when that takes the balance below
 * zero — the delivery already happened. What the minimum balance does is stop
 * the shop ACCEPTING new orders (assertShopMayAcceptOrders) until it recharges.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { AppError, conflict, isUniqueViolation, notFound, validationFailed } from "@/lib/errors";
import { formatPaise } from "@/lib/money";
import { db, type DbClient } from "@/server/db";
import {
  orderFinancials,
  orders,
  shopWalletTransactions,
  shopWallets,
  shops,
  type ShopWallet,
  type ShopWalletEntryType,
  type ShopWalletTransaction,
  type UserRole,
} from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { postLedger, resolveCommissionRate } from "./finance";
import { getRule } from "./settings";

interface Actor {
  id: string;
  role: UserRole;
}

const CREDIT_TYPES: ReadonlySet<ShopWalletEntryType> = new Set(["TOP_UP", "MANUAL_CREDIT"]);
const ORDER_CHARGE_TYPES: ReadonlySet<ShopWalletEntryType> = new Set(["COMMISSION", "DELIVERY_CHARGE"]);

export const SHOP_WALLET_URL = "/shop/wallet";

/* ------------------------------------------------------------- read APIs */

/** The shop's wallet, created at zero on first use. */
export async function getOrCreateShopWallet(shopId: string, client: DbClient = db): Promise<ShopWallet> {
  const existing = await client.query.shopWallets.findFirst({ where: eq(shopWallets.shopId, shopId) });
  if (existing) return existing;
  await client.insert(shopWallets).values({ shopId }).onConflictDoNothing();
  const created = await client.query.shopWallets.findFirst({ where: eq(shopWallets.shopId, shopId) });
  if (!created) throw notFound("Shop wallet");
  return created;
}

/** Balance without creating a wallet — 0 for a shop that never had one. */
export async function getShopWalletBalance(shopId: string, client: DbClient = db): Promise<number> {
  const wallet = await client.query.shopWallets.findFirst({ where: eq(shopWallets.shopId, shopId) });
  return wallet?.balancePaise ?? 0;
}

export async function listShopWalletTransactions(
  shopId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<(ShopWalletTransaction & { orderNumber: string | null })[]> {
  const rows = await db
    .select({ entry: shopWalletTransactions, orderNumber: orders.orderNumber })
    .from(shopWalletTransactions)
    .leftJoin(orders, eq(orders.id, shopWalletTransactions.orderId))
    .where(eq(shopWalletTransactions.shopId, shopId))
    .orderBy(desc(shopWalletTransactions.seq))
    .limit(Math.min(options.limit ?? 50, 200))
    .offset(options.offset ?? 0);
  return rows.map((r) => ({ ...r.entry, orderNumber: r.orderNumber }));
}

export interface ShopWalletStatus {
  shopId: string;
  shopName: string;
  /** Rule shopWallet.enabled: when off, nothing is charged and orders are not gated. */
  enabled: boolean;
  balancePaise: number;
  minBalancePaise: number;
  lowBalanceThresholdPaise: number;
  /** False while the rule is on and the balance is below the minimum. */
  canAcceptOrders: boolean;
  lowBalance: boolean;
  commissionRateBp: number;
  deliveryChargePaise: number;
  topupMinPaise: number;
  topupMaxPaise: number;
}

export interface ShopWalletView extends ShopWalletStatus {
  transactions: (ShopWalletTransaction & { orderNumber: string | null })[];
}

/** Balance, levels and whether the shop can accept orders — for banners on the shop's pages. */
export async function getShopWalletStatus(shopId: string): Promise<ShopWalletStatus> {
  const shop = await db.query.shops.findFirst({ where: eq(shops.id, shopId) });
  if (!shop) throw notFound("Shop");
  const [rules, balancePaise, rate] = await Promise.all([
    getRule("shopWallet"),
    getShopWalletBalance(shopId),
    resolveCommissionRate(shop),
  ]);
  return {
    shopId,
    shopName: shop.name,
    enabled: rules.enabled,
    balancePaise,
    minBalancePaise: rules.minBalancePaise,
    lowBalanceThresholdPaise: rules.lowBalanceThresholdPaise,
    canAcceptOrders: !rules.enabled || balancePaise >= rules.minBalancePaise,
    lowBalance: rules.enabled && balancePaise < rules.lowBalanceThresholdPaise,
    commissionRateBp: rate.rateBp,
    deliveryChargePaise: rules.deliveryChargePaise,
    topupMinPaise: rules.topupMinPaise,
    topupMaxPaise: rules.topupMaxPaise,
  };
}

/** Everything the shop's wallet page shows. */
export async function getShopWalletView(shopId: string, options: { limit?: number; offset?: number } = {}): Promise<ShopWalletView> {
  const [status, transactions] = await Promise.all([getShopWalletStatus(shopId), listShopWalletTransactions(shopId, options)]);
  return { ...status, transactions };
}

/* ------------------------------------------------------- ledger engine */

export interface ShopWalletEntryInput {
  shopId: string;
  type: ShopWalletEntryType;
  /** Always a positive magnitude; the direction follows from `type`. */
  amountPaise: number;
  reason: string;
  /** Stable key for this logical operation — reusing it is the way to retry. */
  idempotencyKey: string;
  orderId?: string | null;
  paymentId?: string | null;
  createdBy?: string | null;
  /**
   * Debits only. An order charge must happen even when the balance cannot
   * cover it (the order was delivered); a manual debit must not overdraw.
   */
  allowNegative?: boolean;
}

export interface ShopWalletEntryResult {
  transaction: ShopWalletTransaction;
  balancePaise: number;
  /** True when this operation had already been recorded: no money moved now. */
  deduplicated: boolean;
}

/**
 * Writes one ledger entry and, through the database trigger, moves the
 * balance. Safe inside a caller's transaction, so an order charge commits or
 * rolls back with the delivery it belongs to.
 */
export async function applyShopWalletEntry(input: ShopWalletEntryInput, client?: DbClient): Promise<ShopWalletEntryResult> {
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw validationFailed("Amount must be a positive whole number of paise.");
  }
  if (!input.idempotencyKey.trim()) throw validationFailed("An idempotency key is required.");
  const reason = input.reason.trim();
  if (!reason) throw validationFailed("Give a reason for this wallet entry.");
  if (ORDER_CHARGE_TYPES.has(input.type) && !input.orderId) {
    throw validationFailed("A commission or delivery charge must name its order.");
  }

  const run = async (tx: DbClient): Promise<ShopWalletEntryResult> => {
    const wallet = await getOrCreateShopWallet(input.shopId, tx);
    // 1. Lock the wallet: concurrent entries for this shop queue here.
    const [locked] = await tx.select().from(shopWallets).where(eq(shopWallets.id, wallet.id)).for("update");

    // 2. Inside the lock: has this operation already happened?
    const prior =
      (await tx.query.shopWalletTransactions.findFirst({
        where: eq(shopWalletTransactions.idempotencyKey, input.idempotencyKey),
      })) ??
      (ORDER_CHARGE_TYPES.has(input.type)
        ? await tx.query.shopWalletTransactions.findFirst({
            where: and(eq(shopWalletTransactions.orderId, input.orderId!), eq(shopWalletTransactions.type, input.type)),
          })
        : undefined);
    if (prior) {
      if (prior.shopId !== input.shopId) throw conflict("That wallet operation belongs to another shop.");
      return { transaction: prior, balancePaise: locked.balancePaise, deduplicated: true };
    }

    const credit = CREDIT_TYPES.has(input.type);
    const before = locked.balancePaise;
    const after = credit ? before + input.amountPaise : before - input.amountPaise;
    if (!credit && after < 0 && !input.allowNegative) {
      throw new AppError(
        "INSUFFICIENT_BALANCE",
        `The shop wallet holds ${formatPaise(before)}, less than ${formatPaise(input.amountPaise)}.`,
        { requiredPaise: input.amountPaise, availablePaise: before, shortfallPaise: input.amountPaise - before },
      );
    }

    // 3. The ledger row IS the balance change (trigger shop_wallet_txn_apply).
    const [transaction] = await tx
      .insert(shopWalletTransactions)
      .values({
        walletId: locked.id,
        shopId: input.shopId,
        type: input.type,
        direction: credit ? "CREDIT" : "DEBIT",
        amountPaise: input.amountPaise,
        balanceBeforePaise: before,
        balanceAfterPaise: after,
        orderId: input.orderId ?? null,
        paymentId: input.paymentId ?? null,
        reason,
        idempotencyKey: input.idempotencyKey,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    return { transaction, balancePaise: after, deduplicated: false };
  };

  try {
    return client ? await run(client) : await db.transaction(run);
  } catch (error) {
    // Belt and braces, as in wallet.ts: if two writers raced past the in-lock
    // check, the unique index stopped the second — report the winner's row.
    if (!client && isUniqueViolation(error)) {
      const existing = await db.query.shopWalletTransactions.findFirst({
        where: eq(shopWalletTransactions.idempotencyKey, input.idempotencyKey),
      });
      if (existing) {
        return { transaction: existing, balancePaise: await getShopWalletBalance(input.shopId), deduplicated: true };
      }
    }
    throw error;
  }
}

/* ------------------------------------------------- low-balance alerting */

interface ShopFacts {
  id: string;
  name: string;
  ownerId: string;
}

async function shopFacts(shopId: string, client: DbClient): Promise<ShopFacts> {
  const [shop] = await client
    .select({ id: shops.id, name: shops.name, ownerId: shops.ownerId })
    .from(shops)
    .where(eq(shops.id, shopId));
  if (!shop) throw notFound("Shop");
  return shop;
}

/**
 * Event-driven, not a sweep: called right after the balance moves. Alerts the
 * owner once when a debit takes the balance below the threshold (stamped on
 * the wallet) and re-arms once a credit takes it back to the threshold or above.
 */
async function refreshLowBalanceAlert(
  shop: ShopFacts,
  result: ShopWalletEntryResult,
  client: DbClient,
): Promise<void> {
  if (result.deduplicated) return;
  const rules = await getRule("shopWallet");
  const walletId = result.transaction.walletId;
  if (result.balancePaise >= rules.lowBalanceThresholdPaise) {
    await client
      .update(shopWallets)
      .set({ lowBalanceNotifiedAt: null })
      .where(and(eq(shopWallets.id, walletId), sql`${shopWallets.lowBalanceNotifiedAt} IS NOT NULL`));
    return;
  }
  // Only a debit takes the balance down; a recharge that still leaves it low is not news.
  if (!rules.enabled || result.transaction.direction !== "DEBIT") return;
  const [armed] = await client
    .update(shopWallets)
    .set({ lowBalanceNotifiedAt: new Date() })
    .where(and(eq(shopWallets.id, walletId), isNull(shopWallets.lowBalanceNotifiedAt)))
    .returning({ id: shopWallets.id });
  if (!armed) return;
  await emitEvent(
    {
      type: "shop_wallet.low_balance",
      subjectId: shop.id,
      payload: {
        shopId: shop.id,
        shopName: shop.name,
        ownerId: shop.ownerId,
        balancePaise: result.balancePaise,
        minBalancePaise: rules.minBalancePaise,
        thresholdPaise: rules.lowBalanceThresholdPaise,
      },
      idempotencyKey: `shop-wallet-low:${result.transaction.id}`,
    },
    client,
  );
}

/* ------------------------------------------------- accepting new orders */

/**
 * Server-side gate on the shop taking a new order (CONFIRMED → ACCEPTED or
 * straight to PREPARING). While rule shopWallet is on, a balance below
 * `minBalancePaise` refuses with a "recharge your wallet" message.
 */
export async function assertShopMayAcceptOrders(shopId: string, client: DbClient = db): Promise<void> {
  const rules = await getRule("shopWallet");
  if (!rules.enabled) return;
  const balancePaise = await getShopWalletBalance(shopId, client);
  if (balancePaise >= rules.minBalancePaise) return;
  throw new AppError(
    "INSUFFICIENT_BALANCE",
    `Recharge your shop wallet to accept new orders. Balance ${formatPaise(balancePaise)}, minimum ${formatPaise(rules.minBalancePaise)}.`,
    { balancePaise, minBalancePaise: rules.minBalancePaise, rechargeUrl: SHOP_WALLET_URL },
  );
}

/* --------------------------------------------------- order completion */

export interface OrderWalletCharge {
  commissionPaise: number;
  deliveryChargePaise: number;
  balancePaise: number;
  /** The new balance is below the minimum: the shop cannot accept new orders. */
  belowMinimum: boolean;
}

/**
 * Debits the commission and the delivery charge recorded on the order's
 * finance snapshot, each as its own ledger entry linked to the order. Runs in
 * the DELIVERED transaction (orders.ts), so the order is complete and charged
 * together or not at all; a cancelled or undelivered order never gets here.
 * Returns null when nothing new was charged (rule off when delivered, or a
 * second DELIVERED after a dispute — the first one already charged).
 */
export async function chargeShopWalletForDeliveredOrder(
  orderId: string,
  actor: { id: string | null },
  client: DbClient,
): Promise<OrderWalletCharge | null> {
  const [row] = await client
    .select({ snapshot: orderFinancials, orderNumber: orders.orderNumber })
    .from(orderFinancials)
    .innerJoin(orders, eq(orders.id, orderFinancials.orderId))
    .where(eq(orderFinancials.orderId, orderId));
  if (!row || row.snapshot.commissionCollection !== "SHOP_WALLET") return null;
  const { snapshot, orderNumber } = row;
  const shop = await shopFacts(snapshot.shopId, client);

  const charges: { type: "COMMISSION" | "DELIVERY_CHARGE"; amountPaise: number; reason: string }[] = [
    {
      type: "COMMISSION",
      amountPaise: snapshot.commissionPaise,
      reason: `Commission ${(snapshot.commissionRateBp / 100).toFixed(2)}% on ${formatPaise(snapshot.goodsPaise)} — order ${orderNumber}`,
    },
    { type: "DELIVERY_CHARGE", amountPaise: snapshot.shopDeliveryChargePaise, reason: `Delivery charge — order ${orderNumber}` },
  ];

  let last: ShopWalletEntryResult | null = null;
  let lastCharged: ShopWalletEntryResult | null = null;
  let charged = 0;
  const amounts = { COMMISSION: 0, DELIVERY_CHARGE: 0 };
  for (const charge of charges) {
    if (charge.amountPaise <= 0) continue;
    const result = await applyShopWalletEntry(
      {
        shopId: snapshot.shopId,
        type: charge.type,
        amountPaise: charge.amountPaise,
        reason: charge.reason,
        orderId,
        idempotencyKey: `shop-wallet:order:${orderId}:${charge.type.toLowerCase()}`,
        createdBy: actor.id,
        allowNegative: true,
      },
      client,
    );
    last = result;
    if (result.deduplicated) continue;
    lastCharged = result;
    charged += 1;
    amounts[charge.type] = charge.amountPaise;
    if (charge.type === "DELIVERY_CHARGE") {
      // Platform revenue, journaled like the customer's delivery fee (D6).
      const base = { orderId, entryType: "DELIVERY_FEE" as const, sourceType: "shop_wallet_transactions", sourceId: result.transaction.id };
      await postLedger(
        [
          { ...base, entityType: "SHOP", entityId: snapshot.shopId, direction: "DEBIT", amountPaise: charge.amountPaise, key: `order:${orderId}:shop-delivery-charge:shop` },
          { ...base, entityType: "PLATFORM", direction: "CREDIT", amountPaise: charge.amountPaise, key: `order:${orderId}:shop-delivery-charge:platform` },
        ],
        actor.id,
        client,
      );
    }
  }
  if (charged === 0 || !last) return null;
  // Once, after both debits, so the alert quotes the balance the shop now has.
  if (lastCharged) await refreshLowBalanceAlert(shop, lastCharged, client);

  await recordAudit(
    {
      actorId: actor.id,
      action: AUDIT_ACTIONS.SHOP_WALLET_ORDER_CHARGED,
      entityType: "shop_wallet",
      entityId: last.transaction.walletId,
      newValue: {
        orderId,
        orderNumber,
        commissionPaise: amounts.COMMISSION,
        deliveryChargePaise: amounts.DELIVERY_CHARGE,
        balancePaise: last.balancePaise,
      },
    },
    client,
  );
  const rules = await getRule("shopWallet");
  return {
    commissionPaise: amounts.COMMISSION,
    deliveryChargePaise: amounts.DELIVERY_CHARGE,
    balancePaise: last.balancePaise,
    belowMinimum: last.balancePaise < rules.minBalancePaise,
  };
}

/* ------------------------------------------------------------ top-ups */

/**
 * Credits a verified gateway payment (payments.ts finalizeVerifiedPayment —
 * the same verify-then-credit path as a customer top-up). Keyed on the
 * gateway payment id, so the client callback and the webhook credit once.
 */
export async function creditShopWalletTopUp(input: {
  shopId: string;
  paymentId: string;
  gatewayPaymentId: string;
  amountPaise: number;
  userId: string;
}): Promise<ShopWalletEntryResult> {
  return db.transaction(async (tx) => {
    const shop = await shopFacts(input.shopId, tx);
    const result = await applyShopWalletEntry(
      {
        shopId: input.shopId,
        type: "TOP_UP",
        amountPaise: input.amountPaise,
        reason: "Wallet recharge",
        paymentId: input.paymentId,
        idempotencyKey: `shop-topup:${input.gatewayPaymentId}`,
        createdBy: input.userId,
      },
      tx,
    );
    if (result.deduplicated) return result;
    await refreshLowBalanceAlert(shop, result, tx);
    await recordAudit(
      {
        actorId: input.userId,
        action: AUDIT_ACTIONS.SHOP_WALLET_TOPUP_VERIFIED,
        entityType: "shop_wallet",
        entityId: result.transaction.walletId,
        newValue: { paymentId: input.paymentId, amountPaise: input.amountPaise, balancePaise: result.balancePaise },
      },
      tx,
    );
    await emitEvent(
      {
        type: "shop_wallet.topped_up",
        subjectId: shop.id,
        actor: { id: input.userId, role: null },
        payload: {
          shopId: shop.id,
          shopName: shop.name,
          ownerId: shop.ownerId,
          amountPaise: input.amountPaise,
          balancePaise: result.balancePaise,
        },
        idempotencyKey: `shop-topup:${input.gatewayPaymentId}`,
      },
      tx,
    );
    return result;
  });
}

/* ----------------------------------------------------- admin correction */

export interface ShopWalletAdjustmentInput {
  shopId: string;
  direction: "CREDIT" | "DEBIT";
  amountPaise: number;
  reason: string;
  /** Client-generated id so a double submit cannot adjust twice. */
  requestId: string;
}

/**
 * Manual credit (e.g. a recharge paid in cash or by bank transfer) or debit
 * (a correction) by an administrator. Never overdraws; always audited; the
 * owner is told. The balance itself is still moved only by the ledger row.
 */
export async function adjustShopWallet(input: ShopWalletAdjustmentInput, actor: Actor): Promise<ShopWalletEntryResult> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw validationFailed("Give a reason for the adjustment.");
  return db.transaction(async (tx) => {
    const shop = await shopFacts(input.shopId, tx);
    const result = await applyShopWalletEntry(
      {
        shopId: input.shopId,
        type: input.direction === "CREDIT" ? "MANUAL_CREDIT" : "MANUAL_DEBIT",
        amountPaise: input.amountPaise,
        reason,
        idempotencyKey: `shop-wallet-adjust:${input.shopId}:${input.requestId}`,
        createdBy: actor.id,
      },
      tx,
    );
    if (result.deduplicated) return result;
    await refreshLowBalanceAlert(shop, result, tx);
    await recordAudit(
      {
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.SHOP_WALLET_ADJUSTED,
        entityType: "shop_wallet",
        entityId: result.transaction.walletId,
        newValue: { direction: input.direction, amountPaise: input.amountPaise, reason, balancePaise: result.balancePaise },
      },
      tx,
    );
    await emitEvent(
      {
        type: "shop_wallet.adjusted",
        subjectId: shop.id,
        actor,
        payload: {
          shopId: shop.id,
          shopName: shop.name,
          ownerId: shop.ownerId,
          amountPaise: input.amountPaise,
          balancePaise: result.balancePaise,
          direction: input.direction,
          reason,
        },
        idempotencyKey: `shop-wallet-adjust:${input.shopId}:${input.requestId}`,
      },
      tx,
    );
    return result;
  });
}

/** Admin overview: every shop wallet, lowest balance first. */
export async function listShopWallets(limit = 200) {
  const rules = await getRule("shopWallet");
  const rows = await db
    .select({
      shopId: shops.id,
      shopName: shops.name,
      balancePaise: sql<number>`coalesce(${shopWallets.balancePaise}, 0)::bigint`,
      updatedAt: shopWallets.updatedAt,
    })
    .from(shops)
    .leftJoin(shopWallets, eq(shopWallets.shopId, shops.id))
    .where(and(eq(shops.status, "APPROVED"), isNull(shops.deletedAt)))
    .orderBy(sql`coalesce(${shopWallets.balancePaise}, 0)`, shops.name)
    .limit(Math.min(limit, 1000));
  return rows.map((r) => ({
    ...r,
    balancePaise: Number(r.balancePaise),
    belowMinimum: rules.enabled && Number(r.balancePaise) < rules.minBalancePaise,
  }));
}
