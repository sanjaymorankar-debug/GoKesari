/**
 * C1 — shop contact numbers shown to customers (rule shopContact).
 * Customers see only the contact phone / WhatsApp number the shopkeeper
 * entered for the shop; never the registration phone or the owner's login
 * number. REGISTERED_PHONE restores the original behaviour.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/server/db";
import { platformSettings, shops, users } from "@/server/db/schema";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { getPublicShopById, getPublicShopBySlug, shopCustomerContact, updateShop } from "@/server/services/shops";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

async function clearRule() {
  await db.delete(platformSettings).where(eq(platformSettings.key, "shopContact"));
  clearRuleCache();
}
beforeEach(async () => {
  await resetDatabase();
  await clearRule();
});
afterEach(clearRule);

const REGISTRATION_PHONE = "9876500001";
const LOGIN_PHONE = "+919876500002";

async function setup() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  await db.update(users).set({ phone: "9876500002", phoneE164: LOGIN_PHONE }).where(eq(users.id, owner.id));
  const created = await createShop(owner.id);
  const [shop] = await db.update(shops).set({ phone: REGISTRATION_PHONE }).where(eq(shops.id, created.id)).returning();
  return { owner: { id: owner.id, role: "SHOP_OWNER" as const }, shop };
}

describe("C1 — shop customer contact", () => {
  it("default: no contact entered → neither the registration nor the login number; platform care instead", async () => {
    const { shop } = await setup();
    const contact = await shopCustomerContact((await getPublicShopBySlug(shop.slug))!);
    expect(contact).toEqual({ phone: null, whatsapp: null, usePlatformCare: true });
    expect(JSON.stringify(contact)).not.toContain(REGISTRATION_PHONE);
    expect(JSON.stringify(contact)).not.toContain("9876500002");
  });

  it("the shopkeeper's entered contact phone and WhatsApp are what customers see", async () => {
    const { shop, owner } = await setup();
    await updateShop(shop.id, { contactPhone: "9123456780", whatsappNumber: "9123456781" }, owner);
    const contact = await shopCustomerContact((await getPublicShopBySlug(shop.slug))!);
    expect(contact).toEqual({ phone: "9123456780", whatsapp: "9123456781", usePlatformCare: false });
  });

  it("WhatsApp only is enough (no platform fallback)", async () => {
    const { shop, owner } = await setup();
    await updateShop(shop.id, { whatsappNumber: "9123456781" }, owner);
    const contact = await shopCustomerContact((await getPublicShopBySlug(shop.slug))!);
    expect(contact).toEqual({ phone: null, whatsapp: "9123456781", usePlatformCare: false });
  });

  it("clearing the numbers falls back to platform care again", async () => {
    const { shop, owner } = await setup();
    await updateShop(shop.id, { contactPhone: "9123456780" }, owner);
    await updateShop(shop.id, { contactPhone: null }, owner);
    expect((await shopCustomerContact((await getPublicShopBySlug(shop.slug))!)).usePlatformCare).toBe(true);
  });

  it("rejects an invalid contact or WhatsApp number", async () => {
    const { shop, owner } = await setup();
    await expect(updateShop(shop.id, { contactPhone: "12345" }, owner)).rejects.toThrow(/contact phone/);
    await expect(updateShop(shop.id, { whatsappNumber: "0000000000" }, owner)).rejects.toThrow(/WhatsApp/);
  });

  it("REGISTERED_PHONE restores the original behaviour (registration phone shown)", async () => {
    const { shop } = await setup();
    const admin = await createUser({ role: "ADMIN" });
    await setRule("shopContact", { customerVisible: "REGISTERED_PHONE" }, { id: admin.id, role: "ADMIN" });
    const contact = await shopCustomerContact((await getPublicShopBySlug(shop.slug))!);
    expect(contact).toEqual({ phone: REGISTRATION_PHONE, whatsapp: null, usePlatformCare: false });
  });

  it("the public shop API card never carries any phone number", async () => {
    const { shop, owner } = await setup();
    await updateShop(shop.id, { contactPhone: "9123456780", whatsappNumber: "9123456781" }, owner);
    const card = await getPublicShopById(shop.id);
    expect(card).toBeDefined();
    const json = JSON.stringify(card);
    expect(json).not.toContain(REGISTRATION_PHONE);
    expect(json).not.toContain("9876500002");
  });
});
