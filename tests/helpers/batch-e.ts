/**
 * batch-2026-10 WS-E test helpers: shops with GST details and bank accounts,
 * delivered (and invoiced) orders, rule switches, and a clean slate for the
 * payout / platform-invoice tables (which are not tied to shops by cascade).
 */
import { eq, inArray, sql } from "drizzle-orm";

import { encryptSecret } from "@/lib/pan-crypto";
import { db } from "@/server/db";
import {
  addresses,
  bankAccounts,
  orderFinancials,
  platformSettings,
  products,
  shops,
  statutoryRates,
  taxInvoices,
  type StatutoryRate,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import type { RuleKey } from "@/server/config/rules";
import { createCategory, createProduct, createShop, createShopProduct, createUser, createUserWithWallet } from "./fixtures";

export const WS_E_RULE_KEYS = ["invoiceDelivery", "payouts", "platformInvoicing", "platformTaxProfile", "invoicing", "shopWallet", "bankAccounts", "settlement"] as const;

/** A GSTIN with a correct check digit. */
export function gstin(state: string, pan: string, entity = "1"): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const body = `${state}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const p = chars.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + chars[(36 - (sum % 36)) % 36];
}

export const GOKESARI_GSTIN = gstin("29", "AABCG1234K"); // Karnataka

let statutorySnapshot: StatutoryRate[] | null = null;

/** Clears WS-E tables and rule overrides; restores statutory_rates to what the migration seeded. */
export async function resetBatchE(): Promise<void> {
  await db.execute(sql`DELETE FROM payout_events`);
  await db.execute(sql`DELETE FROM platform_credit_debit_notes`);
  await db.execute(sql`DELETE FROM platform_invoice_lines`);
  await db.execute(sql`DELETE FROM platform_invoices`);
  await db.execute(sql`DELETE FROM platform_invoice_counters`);
  await db.execute(sql`DELETE FROM payout_items`);
  await db.execute(sql`DELETE FROM payout_batches`);
  await db.execute(sql`DELETE FROM payout_cycle_lines`);
  await db.execute(sql`DELETE FROM payout_cycles`);
  await db.execute(sql`DELETE FROM document_emails`);
  await db.execute(sql`DELETE FROM hsn_tax_rates`);
  await db.delete(platformSettings).where(inArray(platformSettings.key, [...WS_E_RULE_KEYS]));
  if (!statutorySnapshot) statutorySnapshot = await db.select().from(statutoryRates);
  await db.delete(statutoryRates);
  if (statutorySnapshot.length) await db.insert(statutoryRates).values(statutorySnapshot);
  clearRuleCache();
}

export async function rules(admin: { id: string; role: "ADMIN" }, values: Partial<Record<RuleKey, Record<string, unknown>>>): Promise<void> {
  for (const [key, value] of Object.entries(values)) await setRule(key as RuleKey, value, admin);
  clearRuleCache();
}

export const IST_TODAY = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface GstShop {
  owner: Awaited<ReturnType<typeof createUser>>;
  shop: typeof shops.$inferSelect;
  milkSp: { id: string };
  gheeSp: { id: string };
}

/** A shop in Maharashtra selling milk (5%, HSN 0401) and ghee (12%, HSN 0405). */
export async function gstShop(options: { gstin?: string | null; name?: string; gstStatus?: "REGISTERED" | "NOT_REGISTERED" | "COMPOSITION"; panLast4?: string | null; pan?: string | null; state?: string | null } = {}): Promise<GstShop> {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Cow Milk", unit: "L" });
  await db.update(products).set({ gstRateBp: 500, hsnCode: "0401" }).where(eq(products.id, milk.id));
  const ghee = await createProduct(cat.id, { name: "Ghee 500ml", unit: "pc" });
  await db.update(products).set({ gstRateBp: 1200, hsnCode: "0405" }).where(eq(products.id, ghee.id));
  const shop = await createShop(owner.id, { name: options.name ?? "Dairy GST" });
  const g = options.gstin === undefined ? gstin("27", "ABCDE1234F") : options.gstin;
  const [updated] = await db
    .update(shops)
    .set({
      gstin: g,
      gstStatus: options.gstStatus ?? (g ? "REGISTERED" : "NOT_REGISTERED"),
      legalBusinessName: `${options.name ?? "Dairy GST"} Pvt Ltd`,
      panLast4: options.panLast4 === undefined ? "234F" : options.panLast4,
      panNumberEncrypted: options.pan ? encryptSecret(options.pan) : null,
      state: options.state === undefined ? "MH" : options.state,
      // Delivers to a Karnataka PIN and an ambiguous (Bihar/Jharkhand) PIN for place-of-supply tests.
      deliveryPincodes: ["411001", "560001", "800001"],
    })
    .where(eq(shops.id, shop.id))
    .returning();
  const milkSp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 10_500, onlineStock: 5000 });
  const gheeSp = await createShopProduct(shop.id, ghee.id, { onlinePricePaise: 33_600, onlineStock: 5000 });
  return { owner, shop: updated, milkSp, gheeSp };
}

export async function verifiedBank(ownerId: string, shopId: string, status: "VERIFIED" | "PENDING" = "VERIFIED", method: "BANK_ACCOUNT" | "UPI" = "BANK_ACCOUNT") {
  const [row] = await db
    .insert(bankAccounts)
    .values({
      userId: ownerId,
      shopId,
      holderType: "SHOP",
      method,
      accountHolderName: "Dairy GST Pvt Ltd",
      accountNumberEncrypted: method === "BANK_ACCOUNT" ? encryptSecret("123456789012") : null,
      accountNumberLast4: method === "BANK_ACCOUNT" ? "9012" : null,
      ifsc: method === "BANK_ACCOUNT" ? "HDFC0001234" : null,
      upiIdEncrypted: method === "UPI" ? encryptSecret("dairy@okhdfc") : null,
      upiIdMasked: method === "UPI" ? "da***@okhdfc" : null,
      status,
      verifiedAt: status === "VERIFIED" ? new Date() : null,
    })
    .returning();
  return row;
}

let reqCounter = 0;

/** Checks out and delivers one order; returns it with its invoice (when invoicing is on). */
export async function deliveredOrder(
  admin: { id: string; role: "ADMIN" },
  lines: [string, number][],
  options: { address?: { state?: string | null; pincode?: string } ; deliveredDaysAgo?: number } = {},
) {
  const { user } = await createUserWithWallet({ balancePaise: 50_000_000 });
  const [address] = await db
    .insert(addresses)
    .values({ userId: user.id, line1: "5 Customer Street", city: "City", pincode: options.address?.pincode ?? "411001", state: options.address?.state ?? null, isDefault: true, addressType: "HOME" })
    .returning();
  for (const [sp, qty] of lines) await addToCart(user.id, sp, qty);
  reqCounter += 1;
  const { orders } = await checkout({ userId: user.id, addressId: address.id, requestId: `ws-e-${Date.now()}-${reqCounter}` });
  const order = orders[0];
  for (const s of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) await updateOrderStatus(order.id, s, admin);
  if (options.deliveredDaysAgo != null) {
    await db
      .update(orderFinancials)
      .set({ deliveredAt: new Date(Date.now() - options.deliveredDaysAgo * 86_400_000) })
      .where(eq(orderFinancials.orderId, order.id));
  }
  const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, order.id));
  return { customer: user, order, invoice: invoice ?? null };
}
