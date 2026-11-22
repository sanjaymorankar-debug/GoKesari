/**
 * What the shop's WhatsApp messages say (docs/smart-shopping-2026-11/
 * FEATURE3_WHATSAPP_ORDERS.md, where the template texts to submit to Meta are).
 * Read from the committed order when the message is sent, never from the
 * transaction that queued it.
 */
import { asc, eq } from "drizzle-orm";

import { formatIst } from "@/lib/franchise";
import { FULFILMENT_OPTION_LABELS } from "@/lib/fulfilment-options";
import { haversineDistanceKm, parseCoordinates } from "@/lib/geo/haversine";
import { formatPaise, formatQuantity } from "@/lib/money";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { orderFulfilmentArrangements, orderItems, orders, shops, users } from "@/server/db/schema";

/** Quick-reply payloads: "GK1:A:<order id>" (accept) and "GK1:R:<order id>" (reject). */
export const ACCEPT_PREFIX = "GK1:A:";
export const REJECT_PREFIX = "GK1:R:";

export function parseButtonPayload(payload: string | null | undefined): { action: "ACCEPT" | "REJECT"; orderId: string } | null {
  const m = /^GK1:([AR]):([0-9a-f-]{36})$/i.exec((payload ?? "").trim());
  if (!m) return null;
  return { action: m[1].toUpperCase() === "A" ? "ACCEPT" : "REJECT", orderId: m[2].toLowerCase() };
}

export function siteUrl(path: string): string {
  const env = getEnv();
  const base = (env.PAYMENT_PUBLIC_BASE_URL ?? env.AUTH_URL ?? "https://gokesari.com").replace(/\/$/, "");
  return `${base}${path}`;
}

export const shopOrderLink = (orderId: string) => siteUrl(`/shop/orders/${orderId}`);

const WINDOW_LABELS: Record<string, string> = {
  EXPRESS_30: "Delivery in 30 min",
  STANDARD_60: "Delivery in 60 min",
  SCHEDULED: "Scheduled delivery",
};

const PAYMENT_LABELS: Record<string, string> = {
  COD: "Cash on delivery (COD) — collect the cash",
  WALLET: "Prepaid (GoKesari wallet)",
  ONLINE: "Prepaid (online)",
};

export interface NewOrderContent {
  orderNumber: string;
  placedAt: string;
  customerName: string;
  items: string;
  total: string;
  payment: string;
  fulfilment: string;
  area: string;
  link: string;
}

/** The template's nine body parameters, in order ({{1}} … {{9}}). */
export function newOrderParams(c: NewOrderContent): string[] {
  return [c.orderNumber, c.placedAt, c.customerName, c.items, c.total, c.payment, c.fulfilment, c.area, c.link];
}

/** The readable copy kept in the log (what the template shows). */
export function newOrderText(c: NewOrderContent): string {
  return [
    `New order ${c.orderNumber}`,
    `Placed: ${c.placedAt}`,
    `Customer: ${c.customerName}`,
    `Items: ${c.items}`,
    `Total: ${c.total}`,
    `Payment: ${c.payment}`,
    `Fulfilment: ${c.fulfilment}`,
    `Delivery area: ${c.area}`,
    `Open: ${c.link}`,
    "[Accept] [Reject]",
  ].join("\n");
}

export async function loadNewOrderContent(orderId: string): Promise<NewOrderContent | null> {
  const [row] = await db
    .select({
      order: orders,
      customerName: users.name,
      shopLat: shops.latitude,
      shopLng: shops.longitude,
    })
    .from(orders)
    .innerJoin(shops, eq(shops.id, orders.shopId))
    .leftJoin(users, eq(users.id, orders.userId))
    .where(eq(orders.id, orderId));
  if (!row) return null;
  const { order } = row;
  const [lines, [arrangement]] = await Promise.all([
    db
      .select({
        name: orderItems.productNameSnapshot,
        unit: orderItems.unitSnapshot,
        quantityMilli: orderItems.quantityMilli,
        unitPricePaise: orderItems.unitPricePaise,
        lineTotalPaise: orderItems.lineTotalPaise,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId))
      .orderBy(asc(orderItems.id)),
    db
      .select({ option: orderFulfilmentArrangements.option })
      .from(orderFulfilmentArrangements)
      .where(eq(orderFulfilmentArrangements.orderId, orderId)),
  ]);

  // Items fit one template parameter: "Cow Milk 2 L × ₹52.00 = ₹104.00; …", the rest counted.
  const parts = lines.map((l) => `${l.name} ${formatQuantity(l.quantityMilli, l.unit)} × ${formatPaise(l.unitPricePaise)} = ${formatPaise(l.lineTotalPaise)}`);
  let items = "";
  let shown = 0;
  for (const part of parts) {
    const next = items ? `${items}; ${part}` : part;
    if (next.length > 600) break;
    items = next;
    shown += 1;
  }
  if (shown < parts.length) items += `; +${parts.length - shown} more item(s)`;

  const address = order.deliveryAddressSnapshot;
  let fulfilment: string;
  if (arrangement) fulfilment = FULFILMENT_OPTION_LABELS[arrangement.option];
  else if (!address) fulfilment = "Pickup from the shop";
  else {
    fulfilment = (order.deliveryWindow && WINDOW_LABELS[order.deliveryWindow]) || "Home delivery";
    if (order.scheduledSlotStart) fulfilment += ` (from ${formatIst(order.scheduledSlotStart)})`;
  }

  let area = "—";
  if (address) {
    const place = [address.area || address.line2, address.city, address.pincode].filter(Boolean).join(", ");
    const from = parseCoordinates(row.shopLat, row.shopLng);
    const to = parseCoordinates(address.latitude, address.longitude);
    const km = from && to ? haversineDistanceKm(from, to) : null;
    area = km != null ? `${place} (about ${km.toFixed(1)} km from the shop)` : place;
  }

  return {
    orderNumber: order.orderNumber,
    placedAt: formatIst(order.paidAt ?? order.createdAt),
    customerName: row.customerName?.trim() || "GoKesari customer",
    items: items || "—",
    total: formatPaise(order.totalPaise),
    payment: PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod,
    fulfilment,
    area,
    link: shopOrderLink(order.id),
  };
}

export async function loadOrderNumber(orderId: string): Promise<string | null> {
  const [row] = await db.select({ orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, orderId));
  return row?.orderNumber ?? null;
}
