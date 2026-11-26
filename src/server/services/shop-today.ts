/**
 * The shop owner's phone home (docs/ux-mobile-2026-11): today's sales and the
 * newest orders waiting for Accept / Reject. Read-only.
 */
import { sql } from "drizzle-orm";

import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { listOrdersForShop } from "@/server/services/orders";

/** Orders that never became a sale (unpaid, cancelled, refunded, failed or sent back). */
const NOT_A_SALE = ["PENDING", "CANCELLED", "PAYMENT_FAILED", "WALLET_INSUFFICIENT", "REFUND_PENDING", "REFUNDED", "FAILED", "RETURNED"] as const;

export interface ShopToday {
  /** Sum of today's order totals (shop's local calendar day, APP_TIMEZONE). */
  salesPaise: number;
  orders: number;
}

export async function getShopToday(shopId: string): Promise<ShopToday> {
  const tz = getEnv().APP_TIMEZONE;
  const notSale = sql.join(NOT_A_SALE.map((s) => sql`${s}`), sql`, `);
  const result = await db.execute<{ sales: string | null; n: string }>(sql`
    SELECT COALESCE(SUM(total_paise), 0) AS sales, COUNT(*) AS n
    FROM orders
    WHERE shop_id = ${shopId}
      AND (created_at AT TIME ZONE ${tz})::date = (now() AT TIME ZONE ${tz})::date
      AND status::text NOT IN (${notSale})`);
  const row = result[0] ?? { sales: "0", n: "0" };
  return { salesPaise: Number(row.sales ?? 0), orders: Number(row.n ?? 0) };
}

export interface NewOrderCard {
  id: string;
  orderNumber: string;
  totalPaise: number;
  items: number;
  createdAt: string;
  acceptByAt: string | null;
}

/** The newest orders waiting for the shop (status CONFIRMED), at most `limit`. */
export async function listNewOrdersForHome(shopId: string, limit = 3): Promise<NewOrderCard[]> {
  const rows = await listOrdersForShop(shopId, { status: "CONFIRMED", limit });
  return rows.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    totalPaise: o.totalPaise,
    items: o.items.length,
    createdAt: o.createdAt.toISOString(),
    acceptByAt: o.acceptByAt ? o.acceptByAt.toISOString() : null,
  }));
}
