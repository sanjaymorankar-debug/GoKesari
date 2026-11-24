/**
 * Many GSTINs per shop (owner, 25-Nov-2026): a live shop adds GSTINs of other states (any PAN,
 * each checked with the KYC vendor — the mock vendor here, as on test.gokesari.com). An order
 * delivered in such a state is invoiced under that GSTIN and outlet; every other order keeps the
 * main GSTIN. Real PostgreSQL.
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { gstinCheckChar } from "@/lib/kyc/doc-formats";
import { db } from "@/server/db";
import { auditLogs, shopGstRegistrations, shops } from "@/server/db/schema";
import { setKycAdapterForTests } from "@/server/kyc";
import { createMockAdapter } from "@/server/kyc/adapters/mock";
import type { InvoiceSnapshot } from "@/server/services/invoices";
import { addShopGstRegistration, invoiceGstinFor, listShopGstRegistrations, removeShopGstRegistration } from "@/server/services/shop-gst-registrations";
import { gstinHeldByOtherOwner } from "@/server/services/shop-duplicates";
import { deliveredOrder, gstShop, resetBatchE, rules } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

/** A GSTIN with a valid check character. */
const gstinOf = (stateCode: string, pan: string) => {
  const first14 = `${stateCode}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  setKycAdapterForTests(createMockAdapter());
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await rules(admin, { invoicing: { enabled: true }, invoiceDelivery: { enabled: true } });
});
afterEach(() => setKycAdapterForTests(null));
afterAll(async () => {
  await resetBatchE();
});

async function liveShop(options: Parameters<typeof gstShop>[0] = {}) {
  const made = await gstShop(options);
  await db.update(shops).set({ status: "APPROVED" }).where(eq(shops.id, made.shop.id));
  const actor = { id: made.owner.id, role: made.owner.role as UserRole };
  return { ...made, actor };
}

describe("adding GSTINs of other states", () => {
  it("verifies a GSTIN of another state on another PAN, keeps the outlet address, and lists it beside the main GSTIN", async () => {
    const { shop, actor } = await liveShop();
    const ka = gstinOf("29", "AABCK4321Q");
    const view = await addShopGstRegistration({ shopId: shop.id, gstin: ka, consentGiven: true, actor });
    expect(view.main).toMatchObject({ gstin: shop.gstin, stateCode: "27" });
    expect(view.registrations).toHaveLength(1);
    expect(view.registrations[0]).toMatchObject({ stateCode: "29", stateName: "Karnataka", status: "VERIFIED", message: null });
    expect(view.registrations[0].outletAddress).toBeTruthy();
    // Stored encrypted and masked only.
    const [row] = await db.select().from(shopGstRegistrations).where(eq(shopGstRegistrations.shopId, shop.id));
    expect(row.gstinEncrypted).not.toContain(ka);
    expect(row.gstinMasked).not.toBe(ka);
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.action, "shop.gst_registration_added"));
    expect(JSON.stringify(audit.newValue)).not.toContain(ka);
  });

  it("refuses: not live yet, no consent, the main GSTIN or its state, a second GSTIN for one state, the same GSTIN twice", async () => {
    // A shop not live yet (still awaiting approval) cannot add one.
    const pending = await gstShop({ gstin: gstinOf("24", "AAGCS1234Z") });
    await db.update(shops).set({ status: "PENDING_APPROVAL" }).where(eq(shops.id, pending.shop.id));
    const pendingActor = { id: pending.owner.id, role: pending.owner.role as UserRole };
    await expect(addShopGstRegistration({ shopId: pending.shop.id, gstin: gstinOf("29", "AABCK4321Q"), consentGiven: true, actor: pendingActor })).rejects.toMatchObject({ code: "CONFLICT" });

    const { shop, actor } = await liveShop();

    await expect(addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("29", "AABCK4321Q"), consentGiven: false, actor })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(addShopGstRegistration({ shopId: shop.id, gstin: shop.gstin!, consentGiven: true, actor })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("27", "AABCK4321Q"), consentGiven: true, actor })).rejects.toMatchObject({ code: "CONFLICT" });

    await addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("29", "AABCK4321Q"), consentGiven: true, actor });
    await expect(addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("29", "AABCK4321Q"), consentGiven: true, actor })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("29", "AAFCM9876R"), consentGiven: true, actor })).rejects.toMatchObject({ code: "CONFLICT" });

    // Only the owner adds one.
    const stranger = await createUser({ role: "SHOP_OWNER" });
    await expect(addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("24", "AABCK4321Q"), consentGiven: true, actor: { id: stranger.id, role: "SHOP_OWNER" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("a GSTIN another account holds is refused, both ways: as an extra GSTIN, and at signup once it is someone's extra GSTIN", async () => {
    const first = await liveShop();
    const second = await liveShop({ gstin: gstinOf("24", "AAGCS1234Z") });
    // The second shop's main GSTIN (Gujarat) belongs to another account.
    await expect(addShopGstRegistration({ shopId: first.shop.id, gstin: second.shop.gstin!, consentGiven: true, actor: first.actor })).rejects.toMatchObject({ code: "CONFLICT" });
    // The first shop's own Karnataka GSTIN is then held against every other account.
    const ka = gstinOf("29", "AABCK4321Q");
    await addShopGstRegistration({ shopId: first.shop.id, gstin: ka, consentGiven: true, actor: first.actor });
    expect(await gstinHeldByOtherOwner(ka, second.owner.id)).toMatchObject({ shopId: first.shop.id });
    expect(await gstinHeldByOtherOwner(ka, first.owner.id)).toBeNull();
  });

  it("a GSTIN the government does not know stays unverified and is never used on an invoice", async () => {
    const { shop, actor } = await liveShop();
    const view = await addShopGstRegistration({ shopId: shop.id, gstin: gstinOf("29", "AABCK0000Q"), consentGiven: true, actor });
    expect(view.registrations[0].status).toBe("FAILED");
    expect(view.registrations[0].message).toBeTruthy();
    expect(await invoiceGstinFor(shop.id, "KA")).toBeNull();
  });
});

describe("the invoice uses the delivery state's GSTIN", () => {
  it("Karnataka delivery → the Karnataka GSTIN, outlet and PAN, intra-state tax; Maharashtra and Gujarat → the main GSTIN", async () => {
    const { shop, actor, milkSp } = await liveShop();
    const ka = gstinOf("29", "AABCK4321Q");
    await addShopGstRegistration({ shopId: shop.id, gstin: ka, consentGiven: true, actor });

    const toKa = await deliveredOrder(admin, [[milkSp.id, 2]], { address: { state: "Karnataka", pincode: "560001" } });
    const s = toKa.invoice!.snapshot as unknown as InvoiceSnapshot;
    expect(s.seller.gstin).toBe(ka);
    expect(s.seller.stateCode).toBe("KA");
    expect(s.seller.panMasked).toBe("XXXXXX321Q");
    expect(s.seller.address).toBe("Shop No 4, Main Market, Shivajinagar, Pune, Maharashtra, 411001");
    expect(toKa.invoice!.supplyType).toBe("INTRA");
    expect(toKa.invoice!.igstPaise).toBe(0);
    expect(toKa.invoice!.cgstPaise).toBeGreaterThan(0);

    const toMh = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: "MH", pincode: "411001" } });
    expect((toMh.invoice!.snapshot as unknown as InvoiceSnapshot).seller.gstin).toBe(shop.gstin);
    expect(toMh.invoice!.supplyType).toBe("INTRA");

    const toGj = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: "Gujarat", pincode: "411001" } });
    expect((toGj.invoice!.snapshot as unknown as InvoiceSnapshot).seller.gstin).toBe(shop.gstin);
    expect(toGj.invoice!.supplyType).toBe("INTER");

    // Removed: later Karnataka orders go back to the main GSTIN (inter-state).
    const { registrations } = await listShopGstRegistrations(shop.id);
    await removeShopGstRegistration({ shopId: shop.id, registrationId: registrations[0].id, actor, privileged: false });
    expect((await listShopGstRegistrations(shop.id)).registrations).toHaveLength(0);
    const again = await deliveredOrder(admin, [[milkSp.id, 1]], { address: { state: "Karnataka", pincode: "560001" } });
    expect((again.invoice!.snapshot as unknown as InvoiceSnapshot).seller.gstin).toBe(shop.gstin);
    expect(again.invoice!.supplyType).toBe("INTER");
  });
});
