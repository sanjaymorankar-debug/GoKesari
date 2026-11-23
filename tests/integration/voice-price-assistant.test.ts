/**
 * Voice price & offer assistant (docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md), against real
 * PostgreSQL, with the AI provider MOCKED (no AI call is ever made):
 *   - flag off → service and routes refused (404); a guest gets 401 before anything is read
 *   - Marathi / Hindi / English commands → the right listing of THIS shop, price and offer, nothing changed yet
 *   - apply → price through the normal price path (history kept), offer through shop offers; customers see it
 *   - above MRP / offer too big / unsure product / not in the shop → refused or asked, never published
 *   - price changed since it was shown → refused; only the owner; AI only when the reader finds nothing
 */
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
  structured: null as unknown as import("vitest").Mock<(...args: unknown[]) => Promise<unknown>>,
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("@/server/ai/providers/claude", async () => {
  const { vi: v } = await import("vitest");
  state.structured = v.fn();
  return {
    claudeProvider: {
      name: "claude",
      available: () => true,
      defaultModel: () => "test-model",
      pricePerMTok: () => ({ input: 1, output: 5 }),
      structured: (...args: unknown[]) => state.structured(...args),
    },
  };
});

import { POST as applyPost } from "@/app/api/shops/[id]/voice-price/apply/route";
import { POST as interpretPost } from "@/app/api/shops/[id]/voice-price/interpret/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { aiUsageLog, productLocalNames, productPriceHistory, products, shopOffers, shopProducts } from "@/server/db/schema";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import { applyVoiceCommand, interpretVoiceCommand, type VoiceActor } from "@/server/services/voice-price-assistant";
import { createCategory, createProduct, createShop, createShopProduct, createUser, resetDatabase } from "../helpers/fixtures";

let owner: { id: string; role: UserRole; email: string; name: string | null };
let admin: { id: string; role: UserRole };
let shopId: string;
let milk: { listingId: string; productId: string };
let sugar: { listingId: string; productId: string };
let butter: { listingId: string };

const actor = (): VoiceActor => ({ id: owner.id, role: owner.role });
// Monday 23-Nov-2026, 10.00 IST.
const NOW = new Date("2026-11-23T04:30:00Z");

async function flagOn() {
  await setFeatureFlag("voice_price_assistant_enabled", { enabled: true, districtCodes: null }, "Feature 4 test", admin);
}

beforeEach(async () => {
  clearRuleCache();
  await resetDatabase();
  resetRateLimits();
  state.structured.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key-never-used";
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  const u = await createUser({ role: "SHOP_OWNER" });
  owner = { id: u.id, role: "SHOP_OWNER", email: u.email, name: u.name };
  shopId = (await createShop(owner.id)).id;
  const cat = await createCategory({ name: "Grocery" });

  const m = await createProduct(cat.id, { name: "Amul Taaza Toned Milk", unit: "L", unitSizeMilli: 1000 });
  await db.update(products).set({ mrpPaise: 6000, gtin: "8901262150125" }).where(eq(products.id, m.id));
  milk = { productId: m.id, listingId: (await createShopProduct(shopId, m.id, { onlinePricePaise: 5600, offlinePricePaise: 5600 })).id };

  const s = await createProduct(cat.id, { name: "Sugar", unit: "kg", unitSizeMilli: 1000, kind: "LOOSE" });
  await db.insert(productLocalNames).values({ productId: s.id, nameMr: "साखर", nameHi: "चीनी", searchText: "साखर sugar चीनी shakkar" });
  sugar = { productId: s.id, listingId: (await createShopProduct(shopId, s.id, { onlinePricePaise: 4500, offlinePricePaise: 4500 })).id };

  const b = await createProduct(cat.id, { name: "Amul Butter", unit: "g", unitSizeMilli: 500 });
  butter = { listingId: (await createShopProduct(shopId, b.id, { onlinePricePaise: 27000, offlinePricePaise: 27000 })).id };
});
afterEach(() => {
  state.session = null;
});

function req(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) as unknown as NextRequest;
}

describe("flag off / access", () => {
  it("refuses with 404 while off, 401 for a guest, and never calls AI", async () => {
    await expect(interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza price 58" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const guest = await interpretPost(req(`http://x/api/shops/${shopId}/voice-price/interpret`, { text: "x" }), { params: Promise.resolve({ id: shopId }) });
    expect(guest.status).toBe(401);
    const guestApply = await applyPost(req(`http://x/api/shops/${shopId}/voice-price/apply`, {}), { params: Promise.resolve({ id: shopId }) });
    expect(guestApply.status).toBe(401);
    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: owner.role, status: "ACTIVE" } };
    const off = await interpretPost(req(`http://x/api/shops/${shopId}/voice-price/interpret`, { text: "Amul Taaza price 58" }), { params: Promise.resolve({ id: shopId }) });
    expect(off.status).toBe(404);
    expect(state.structured).not.toHaveBeenCalled();
  });

  it("only the shop's owner", async () => {
    await flagOn();
    const other = await createUser({ role: "SHOP_OWNER" });
    await expect(interpretVoiceCommand(shopId, { id: other.id, role: "SHOP_OWNER" }, { text: "Amul Taaza price 58" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(interpretVoiceCommand(shopId, admin, { text: "Amul Taaza price 58" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("with the flag on", () => {
  beforeEach(flagOn);

  it("English price change: understood, read back, nothing changed until applied; then price history kept", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza 1 litre price 58 rupees" }, NOW);
    expect(p.chosen?.shopProductId).toBe(milk.listingId);
    expect(p.newPricePaise).toBe(5800);
    expect(p.canPublish).toBe(true);
    expect(p.readBack.en).toContain("₹56 → ₹58");
    expect(p.aiUsed).toBe(false);
    expect(state.structured).not.toHaveBeenCalled();
    const [still] = await db.select().from(shopProducts).where(eq(shopProducts.id, milk.listingId));
    expect(Number(still.onlinePricePaise)).toBe(5600);

    const r = await applyVoiceCommand(shopId, actor(), { shopProductId: milk.listingId, newPricePaise: 5800, offer: null, expectedPricePaise: 5600 }, NOW);
    expect(r.pricePaise).toBe(5800);
    expect(r.summary.en).toContain("₹56 → ₹58");
    const [after] = await db.select().from(shopProducts).where(eq(shopProducts.id, milk.listingId));
    expect(Number(after.onlinePricePaise)).toBe(5800);
    expect(Number(after.offlinePricePaise)).toBe(5800);
    const history = await db.select().from(productPriceHistory).where(eq(productPriceHistory.shopProductId, milk.listingId));
    expect(history.some((h) => Number(h.newPricePaise) === 5800 && Number(h.previousPricePaise) === 5600)).toBe(true);
  });

  it("Marathi offer by local name: 10% off until Sunday (end of day IST), customers pay less", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "साखर 10 टक्के सूट रविवार पर्यंत" }, NOW);
    expect(p.chosen?.shopProductId).toBe(sugar.listingId);
    expect(p.offer).toMatchObject({ discountType: "PERCENT", percent: 10, endsAt: "2026-11-29T18:29:59.999Z" });
    expect(p.finalPricePaise).toBe(4050);
    expect(p.canPublish).toBe(true);

    const r = await applyVoiceCommand(
      shopId,
      actor(),
      { shopProductId: sugar.listingId, newPricePaise: null, offer: { discountType: "PERCENT", percent: 10, flatPaise: null, endsAt: new Date(p.offer!.endsAt) }, expectedPricePaise: 4500 },
      NOW,
    );
    expect(r.offerId).toBeTruthy();
    const [offer] = await db.select().from(shopOffers).where(eq(shopOffers.id, r.offerId!));
    expect(offer).toMatchObject({ shopId, targetType: "PRODUCT", shopProductId: sugar.listingId, discountType: "PERCENT", percent: 10, active: true });
    expect(offer.endsAt.toISOString()).toBe("2026-11-29T18:29:59.999Z");
  });

  it("Hindi price + flat offer together, default length 7 days", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "अमूल बटर 260 रुपये और 10 रुपये छूट" }, NOW);
    expect(p.chosen?.shopProductId).toBe(butter.listingId);
    expect(p.newPricePaise).toBe(26000);
    expect(p.offer).toMatchObject({ discountType: "FLAT", flatPaise: 1000, endsAt: "2026-11-29T18:29:59.999Z" });
    expect(p.finalPricePaise).toBe(25000);
  });

  it("price above MRP is refused (interpret blocks, apply throws)", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza price 65" }, NOW);
    expect(p.issues.map((i) => i.code)).toContain("ABOVE_MRP");
    expect(p.canPublish).toBe(false);
    await expect(
      applyVoiceCommand(shopId, actor(), { shopProductId: milk.listingId, newPricePaise: 6500, offer: null, expectedPricePaise: 5600 }, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("a big drop warns but can still be published; 95% off is refused", async () => {
    const drop = await interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza price 20" }, NOW);
    expect(drop.issues.find((i) => i.code === "BIG_DROP")?.blocking).toBe(false);
    expect(drop.canPublish).toBe(true);
    const big = await interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza 95 percent off" }, NOW);
    expect(big.issues.map((i) => i.code)).toContain("PERCENT_RANGE");
    expect(big.canPublish).toBe(false);
  });

  it("unsure which product → candidates, then picked by id", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "Amul price 100" }, NOW);
    expect(p.chosen).toBeNull();
    expect(p.issues.map((i) => i.code)).toContain("CHOOSE_PRODUCT");
    expect(p.candidates.map((c) => c.shopProductId)).toEqual(expect.arrayContaining([milk.listingId, butter.listingId]));
    const picked = await interpretVoiceCommand(shopId, actor(), { text: "Amul price 100", shopProductId: butter.listingId }, NOW);
    expect(picked.chosen?.shopProductId).toBe(butter.listingId);
    expect(picked.canPublish).toBe(true);
  });

  it("by barcode: the shop's listing; a product the shop does not list is refused", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "price 57", barcode: "8901262150125" }, NOW);
    expect(p.chosen?.shopProductId).toBe(milk.listingId);
    expect(p.newPricePaise).toBe(5700);
    const cat = await createCategory({ name: "Other" });
    const other = await createProduct(cat.id, { name: "Not Listed Juice" });
    await db.update(products).set({ gtin: "8901234567897" }).where(eq(products.id, other.id));
    const q = await interpretVoiceCommand(shopId, actor(), { text: "price 50", barcode: "8901234567897" }, NOW);
    expect(q.issues.map((i) => i.code)).toContain("NOT_LISTED");
    expect(q.canPublish).toBe(false);
  });

  it("a price changed since it was shown is refused", async () => {
    await db.update(shopProducts).set({ onlinePricePaise: 5500 }).where(eq(shopProducts.id, milk.listingId));
    await expect(
      applyVoiceCommand(shopId, actor(), { shopProductId: milk.listingId, newPricePaise: 5800, offer: null, expectedPricePaise: 5600 }, NOW),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("AI only when the reader finds no change; its answer fills the gaps and is logged", async () => {
    state.structured.mockResolvedValueOnce({
      output: { productName: "Amul Taaza", newPriceRupees: 59, discountPercent: null, discountRupees: null, offerDays: null, untilWeekday: null, buyGetFree: false },
      usage: { inputTokens: 300, outputTokens: 60 },
      model: "test-model",
    });
    const p = await interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza ka rate ab unsath kar do" }, NOW);
    expect(state.structured).toHaveBeenCalledTimes(1);
    expect(p.aiUsed).toBe(true);
    expect(p.newPricePaise).toBe(5900);
    expect(p.chosen?.shopProductId).toBe(milk.listingId);
    const logs = await db.select().from(aiUsageLog).where(and(eq(aiUsageLog.feature, "VOICE_COMMAND"), eq(aiUsageLog.shopId, shopId)));
    expect(logs).toHaveLength(1);
  });

  it("AI off: the owner is asked to say it again, nothing breaks", async () => {
    state.structured.mockRejectedValueOnce(new Error("provider down"));
    const p = await interpretVoiceCommand(shopId, actor(), { text: "Amul Taaza" }, NOW);
    expect(p.issues.map((i) => i.code)).toContain("NO_CHANGE");
    expect(p.canPublish).toBe(false);
  });

  it("buy one get one is explained, not published", async () => {
    const p = await interpretVoiceCommand(shopId, actor(), { text: "Amul Butter buy 1 get 1 free" }, NOW);
    expect(p.issues.map((i) => i.code)).toContain("BUY_GET_FREE");
    expect(p.canPublish).toBe(false);
  });

  it("the API: owner interprets then applies", async () => {
    state.session = { user: { id: owner.id, email: owner.email, name: owner.name, image: null, role: owner.role, status: "ACTIVE" } };
    const res = await interpretPost(req(`http://x/api/shops/${shopId}/voice-price/interpret`, { text: "साखर ४८ रुपये किलो" }), { params: Promise.resolve({ id: shopId }) });
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p).toMatchObject({ newPricePaise: 4800, canPublish: true, chosen: { shopProductId: sugar.listingId } });
    const ap = await applyPost(
      req(`http://x/api/shops/${shopId}/voice-price/apply`, { shopProductId: sugar.listingId, newPricePaise: 4800, offer: null, expectedPricePaise: 4500 }),
      { params: Promise.resolve({ id: shopId }) },
    );
    expect(ap.status).toBe(200);
    expect((await ap.json()).pricePaise).toBe(4800);
  });
});
