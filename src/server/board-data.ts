/**
 * Everything the four Tile Board home screens show, read in one place.
 * Read-only and best-effort: each part may come back undefined, and the board
 * then leaves that badge, banner or line out.
 */
import { addDays, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import type { Counts } from "@/lib/board/menus";
import type { CustomerLocation } from "@/lib/location";
import { lineTotalPaise, MILLI_PER_UNIT } from "@/lib/money";
import type { AuthenticatedUser } from "@/server/authz/guards";
import { listAddresses } from "@/server/services/addresses";
import {
  customerCounts,
  getActiveOrder,
  getBuyAgain,
  getFirstActiveSubscriptionId,
  getLastWalletPayment,
  operatorAlerts,
  settle,
  shopBoardFacts,
  shopCounts,
  staffCounts,
  type ActiveOrderSummary,
  type BuyAgainItem,
  type OperatorAlerts,
  type ShopFacts,
} from "@/server/services/board-counts";
import { getCart } from "@/server/services/cart";
import { getTomorrowDelivery } from "@/server/services/tomorrow-delivery";

export interface CartBarData {
  itemCount: number;
  totalPaise: number;
  firstShop: string | null;
  otherShops: number;
}

export interface TomorrowBanner {
  firstLine: string;
  moreLines: number;
  costPaise: number;
  cutoffHour: number;
  beforeCutoff: boolean;
}

export interface CustomerBoardData {
  counts: Counts;
  activeOrder?: ActiveOrderSummary;
  tomorrow?: TomorrowBanner | null;
  subscriptionId?: string;
  cart?: CartBarData;
  lastPayment?: { amountPaise: number; createdAt: Date };
  defaultAddress?: string | null;
  buyAgain?: BuyAgainItem[];
}

/** "Toned Milk · 1 L" — the product as entered, then the quantity. */
function lineText(name: string, quantityMilli: number, unit: string): string {
  return `${name} · ${quantityMilli / MILLI_PER_UNIT} ${unit === "piece" ? "pc" : unit}`;
}

export async function loadCustomerBoard(user: AuthenticatedUser | null, location: CustomerLocation | null): Promise<CustomerBoardData> {
  if (!user) return { counts: await customerCounts(null, location) };
  const [counts, activeOrder, tomorrow, subscriptionId, cart, lastPayment, addresses, buyAgain] = await Promise.all([
    customerCounts(user.id, location),
    getActiveOrder(user.id),
    settle("tomorrow", async () => {
      const t = await getTomorrowDelivery(user.id);
      const due = t?.lines.filter((l) => !l.skipped && l.quantityMilli > 0) ?? [];
      if (!t || due.length === 0) return null;
      return {
        firstLine: lineText(due[0].productName, due[0].quantityMilli, due[0].unit),
        moreLines: due.length - 1,
        costPaise: due.reduce((sum, l) => sum + (l.unitPricePaise ? lineTotalPaise(l.unitPricePaise, l.quantityMilli) : 0), 0),
        cutoffHour: t.cutoffHour,
        beforeCutoff: t.beforeCutoff,
      } satisfies TomorrowBanner;
    }),
    getFirstActiveSubscriptionId(user.id),
    settle("cart", async () => {
      const c = await getCart(user.id);
      return {
        itemCount: c.itemCount,
        totalPaise: c.grandTotalPaise,
        firstShop: c.groups[0]?.shop.name ?? null,
        otherShops: Math.max(0, c.groups.length - 1),
      } satisfies CartBarData;
    }),
    getLastWalletPayment(user.id),
    settle("addresses", () => listAddresses(user.id)),
    getBuyAgain(user.id),
  ]);
  const home = addresses?.[0];
  return {
    counts,
    activeOrder,
    tomorrow,
    subscriptionId,
    cart,
    lastPayment,
    defaultAddress: home ? `${home.label ? `${home.label} · ` : ""}${[home.area, home.pincode].filter(Boolean).join(" ")}` : addresses ? null : undefined,
    buyAgain,
  };
}

export interface ShopBoardData {
  counts: Counts;
  facts: ShopFacts;
}

export async function loadShopBoard(shopId: string, user: AuthenticatedUser): Promise<ShopBoardData> {
  const [counts, facts] = await Promise.all([shopCounts(shopId), shopBoardFacts(shopId, user)]);
  return { counts, facts };
}

export interface StaffBoardData {
  counts: Counts;
  alerts: OperatorAlerts;
}

export async function loadStaffBoard(role: "ADMIN" | "OPERATOR"): Promise<StaffBoardData> {
  const [counts, alerts] = await Promise.all([staffCounts(role), role === "OPERATOR" ? operatorAlerts() : Promise.resolve({})]);
  return { counts, alerts };
}

/** Tomorrow as a calendar date in the app's time zone (for labels). */
export function tomorrowIso(): string {
  return addDays(todayIn(getEnv().APP_TIMEZONE), 1);
}
