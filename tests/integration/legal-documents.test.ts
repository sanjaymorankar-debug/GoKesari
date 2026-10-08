/**
 * Mandatory legal documents by shop category (docs/four-features-2026-10, feature 2).
 *
 * FSSAI for food shops, drug licence for pharmacies, medical registration for
 * doctors / clinics: format checks (FSSAI 14 digits), no approval without the
 * document, grace period for shops already live (configurable), orders
 * blocked after it, expiry reminders 30 days ahead, operations' approve /
 * reject with a reason, access to the uploaded copies.
 */
import { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async () => {},
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as statusRoute, POST as uploadRoute } from "@/app/api/shops/[id]/legal-documents/route";
import { GET as fileRoute } from "@/app/api/legal-documents/files/[fileId]/route";
import { GET as adminListRoute } from "@/app/api/admin/legal-documents/route";
import { POST as decisionRoute } from "@/app/api/admin/legal-documents/[id]/decision/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import {
  auditLogs,
  notifications,
  platformSettings,
  shopCategories,
  shopCategoryMapping,
  shopLegalDocuments,
  shops,
} from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { acceptOrder } from "@/server/services/fulfilment";
import { getShopLegalStatus, runLegalDocumentSweep } from "@/server/services/legal-documents";
import { checkout } from "@/server/services/orders";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { approveShop } from "@/server/services/shops";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
  verifySellerDocuments,
} from "../helpers/fixtures";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
let admin = { id: "", role: "ADMIN" as const, email: "", name: "Admin" as string | null };

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["legalDocuments"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN", email: a.email, name: a.name };
});

const enable = (overrides: Record<string, unknown> = {}) => setRule("legalDocuments", { enabled: true, ...overrides }, admin);

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

function inDays(days: number): string {
  return new Date(Date.now() + 330 * 60_000 + days * 86_400_000).toISOString().slice(0, 10);
}

async function upload(shopId: string, fields: Record<string, string>, file: Buffer | null = PDF) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("file", new Blob([new Uint8Array(file)]), "licence.pdf");
  const request = new NextRequest(`http://localhost/api/shops/${shopId}/legal-documents`, { method: "POST", body: form });
  const response = await (uploadRoute as unknown as (r: NextRequest, c: { params: Promise<{ id: string }> }) => Promise<Response>)(request, {
    params: Promise.resolve({ id: shopId }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function sellableShop(opts: { shopType?: "DAIRY" | "PHARMACY" | "HARDWARE_STORE"; status?: "APPROVED" | "PENDING_APPROVAL"; category?: string } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { shopType: opts.shopType ?? "DAIRY", status: opts.status ?? "APPROVED", registrationFeePaise: 0 });
  await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
  if (opts.category) {
    const [cat] = await db.select().from(shopCategories).where(eq(shopCategories.slug, opts.category));
    await db.insert(shopCategoryMapping).values({ shopId: shop.id, categoryId: cat.id });
  }
  // A product from the shop's own aisle: only food aisles make a shop need FSSAI.
  const type = opts.shopType ?? "DAIRY";
  const cat = await createCategory({ department: type, name: type === "DAIRY" ? "Milk" : `Aisle ${type}` });
  const milk = await createProduct(cat.id, { name: type === "DAIRY" ? "Cow Milk" : "Item", unit: "pc" });
  const sp = await createShopProduct(shop.id, milk.id);
  return { owner, shop, sp };
}

async function tryCheckout(spId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, spId, 1);
  return checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: `r-${Math.random()}` });
}

/* ---------------------------------------------------------------- rule off */

describe("rule off (default)", () => {
  it("requires nothing: approval and checkout work exactly as before", async () => {
    const { shop, sp } = await sellableShop({ status: "PENDING_APPROVAL" });
    await verifySellerDocuments(shop.id);
    await approveShop(shop.id, { classification: "KESARI" }, admin);
    expect((await tryCheckout(sp.id)).orders).toHaveLength(1);
    expect(await db.select().from(shopLegalDocuments)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ new shops */

describe("a new food shop", () => {
  it("cannot go live without its FSSAI licence; can once it is submitted", async () => {
    await enable();
    const { owner, shop } = await sellableShop({ status: "PENDING_APPROVAL" });
    await verifySellerDocuments(shop.id);
    await expect(approveShop(shop.id, { classification: "KESARI" }, admin)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("FSSAI licence"),
    });

    signIn(owner, "SHOP_OWNER");
    // Format: FSSAI is exactly 14 digits.
    const short = await upload(shop.id, { docType: "FSSAI", number: "1234567890123", expiryDate: inDays(200) });
    expect(short.status).toBe(422);
    expect(short.body.error.details.fields.number).toContain("14 digits");
    // An expired licence is refused; so is a missing file or a non-document file.
    expect((await upload(shop.id, { docType: "FSSAI", number: "12345678901234", expiryDate: inDays(-1) })).status).toBe(422);
    expect((await upload(shop.id, { docType: "FSSAI", number: "12345678901234", expiryDate: inDays(200) }, null)).status).toBe(422);
    expect((await upload(shop.id, { docType: "FSSAI", number: "12345678901234", expiryDate: inDays(200) }, Buffer.from("hello"))).status).toBe(422);

    const ok = await upload(shop.id, { docType: "FSSAI", number: "1234 5678 9012 34", expiryDate: inDays(200) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ state: "SUBMITTED", numberMasked: "••••1234" });
    const [row] = await db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shop.id));
    expect(row.numberEncrypted).not.toContain("12345678901234");
    expect(row.graceUntil).toBeNull(); // a new shop has no grace period

    // Support is told there is something to review.
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, "support.legal_document_submitted")))).toHaveLength(1);

    const approved = await approveShop(shop.id, { classification: "KESARI" }, admin);
    expect(approved.status).toBe("APPROVED");
  });
});

/* ------------------------------------------------------- existing shops */

describe("a shop already live", () => {
  it("gets a grace period with a prompt; after it, orders stop until the licence is uploaded", async () => {
    await enable();
    const { owner, shop, sp } = await sellableShop({ shopType: "PHARMACY" });
    const status = await getShopLegalStatus(shop.id);
    const drug = status.documents.find((d) => d.docType === "DRUG_LICENCE")!;
    expect(drug).toMatchObject({ state: "MISSING", blocking: false });
    const days = (new Date(drug.deadline!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(14.9);
    expect(days).toBeLessThan(15.1);
    expect(status.restricted).toBe(false);
    // The owner is told once.
    await getShopLegalStatus(shop.id);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.legal_document_required")))).toHaveLength(1);

    // Still trading during the grace period.
    const placed = await tryCheckout(sp.id);
    expect(placed.orders).toHaveLength(1);

    // Grace over: checkout refuses the shop and it cannot accept the order it already has.
    await db.update(shopLegalDocuments).set({ graceUntil: new Date(Date.now() - 60_000) }).where(eq(shopLegalDocuments.shopId, shop.id));
    await expect(tryCheckout(sp.id)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Drug licence") });
    await expect(acceptOrder(placed.orders[0].id, { id: owner.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await getShopLegalStatus(shop.id)).restricted).toBe(true);

    signIn(owner, "SHOP_OWNER");
    const res = await upload(shop.id, { docType: "DRUG_LICENCE", number: "MH-PZ1-123456", expiryDate: inDays(400) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await tryCheckout(sp.id)).orders).toHaveLength(1);
    await acceptOrder(placed.orders[0].id, { id: owner.id, role: "SHOP_OWNER" });
  });

  it("the grace period is configurable", async () => {
    await enable({ graceDays: 5 });
    const { shop } = await sellableShop({ shopType: "PHARMACY" });
    const drug = (await getShopLegalStatus(shop.id)).documents.find((d) => d.docType === "DRUG_LICENCE")!;
    const days = (new Date(drug.deadline!).getTime() - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(5);
  });

  it("a doctor / clinic needs a medical registration with its issuing council", async () => {
    await enable();
    const { owner, shop } = await sellableShop({ shopType: "HARDWARE_STORE", category: "doctor-clinic" });
    const status = await getShopLegalStatus(shop.id);
    expect(status.documents.map((d) => d.docType)).toEqual(["MEDICAL_REGISTRATION"]);
    signIn(owner, "SHOP_OWNER");
    const noCouncil = await upload(shop.id, { docType: "MEDICAL_REGISTRATION", number: "MMC 2010/05/1234" });
    expect(noCouncil.status).toBe(422);
    expect(noCouncil.body.error.details.fields.issuingCouncil).toBeDefined();
    const ok = await upload(shop.id, { docType: "MEDICAL_REGISTRATION", number: "MMC 2010/05/1234", issuingCouncil: "Maharashtra Medical Council" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ issuingCouncil: "Maharashtra Medical Council", expiryDate: null, state: "SUBMITTED" });
  });

  it("a non-food, non-medical shop needs nothing", async () => {
    await enable();
    const { shop } = await sellableShop({ shopType: "HARDWARE_STORE" });
    expect((await getShopLegalStatus(shop.id)).documents).toHaveLength(0);
  });
});

/* --------------------------------------------------------- review & files */

describe("operations review", () => {
  it("approve and reject with a reason; only reviewers; the owner is told; files are access-checked", async () => {
    await enable();
    const { owner, shop } = await sellableShop({ shopType: "PHARMACY" });
    signIn(owner, "SHOP_OWNER");
    const up = await upload(shop.id, { docType: "DRUG_LICENCE", number: "20B/12345", expiryDate: inDays(300) });
    expect(up.status).toBe(201);
    const docId = up.body.id;
    const fileId = up.body.files[0].id;

    // The shop owner cannot use the operations screens.
    expect((await call(adminListRoute, "/api/admin/legal-documents")).status).toBe(403);
    expect((await call(decisionRoute, `/api/admin/legal-documents/${docId}/decision`, { method: "POST", body: { decision: "approve" }, params: { id: docId } })).status).toBe(403);
    // The owner sees their own file; another owner gets a 404.
    expect((await call(fileRoute, `/api/legal-documents/files/${fileId}`, { params: { fileId } })).status).toBe(200);
    const stranger = await createUser({ role: "SHOP_OWNER" });
    signIn(stranger, "SHOP_OWNER");
    expect((await call(fileRoute, `/api/legal-documents/files/${fileId}`, { params: { fileId } })).status).toBe(404);
    expect((await call(statusRoute, `/api/shops/${shop.id}/legal-documents`, { params: { id: shop.id } })).status).toBe(403);

    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const list = await call(adminListRoute, "/api/admin/legal-documents?filter=to_review");
    expect(list.status).toBe(200);
    expect(list.body.documents.map((d: { shopId: string }) => d.shopId)).toContain(shop.id);
    const viewed = await call(fileRoute, `/api/legal-documents/files/${fileId}`, { params: { fileId } });
    expect(viewed.status).toBe(200);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "shop.legal_document_file_viewed"))).toHaveLength(1);

    // A rejection needs a reason the shop can act on.
    const noReason = await call(decisionRoute, `/api/admin/legal-documents/${docId}/decision`, { method: "POST", body: { decision: "reject" }, params: { id: docId } });
    expect(noReason.status).toBe(422);
    const approved = await call(decisionRoute, `/api/admin/legal-documents/${docId}/decision`, { method: "POST", body: { decision: "approve" }, params: { id: docId } });
    expect(approved.status).toBe(200);
    expect(approved.body.state).toBe("APPROVED");

    // Rejected later (a live shop that had no grace gets one, once).
    await db.update(shopLegalDocuments).set({ graceUntil: null }).where(eq(shopLegalDocuments.id, docId));
    const rejected = await call(decisionRoute, `/api/admin/legal-documents/${docId}/decision`, {
      method: "POST",
      body: { decision: "reject", reason: "Licence number does not match the copy" },
      params: { id: docId },
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ state: "REJECTED", rejectionReason: "Licence number does not match the copy", blocking: false });
    expect(rejected.body.deadline).not.toBeNull();
    const told = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.legal_document_decided")));
    expect(told.map((n) => n.title).sort()).toEqual(["Drug licence approved", "Drug licence rejected"]);
    expect(told.find((n) => n.title.endsWith("rejected"))!.body).toContain("does not match the copy");
  });
});

/* ------------------------------------------------------------ expiry */

describe("expiry", () => {
  it("reminds 30 days ahead, once per expiry date; an expired licence blocks after the grace period", async () => {
    await enable();
    const { owner, shop } = await sellableShop({ shopType: "PHARMACY" });
    signIn(owner, "SHOP_OWNER");
    expect((await upload(shop.id, { docType: "DRUG_LICENCE", number: "20B/12345", expiryDate: inDays(20) })).status).toBe(201);
    expect((await getShopLegalStatus(shop.id)).documents[0].expiringSoon).toBe(true);

    const first = await runLegalDocumentSweep();
    expect(first.remindersSent).toBe(1);
    expect((await runLegalDocumentSweep()).remindersSent).toBe(0);
    const [reminder] = await db.select().from(notifications).where(and(eq(notifications.userId, owner.id), eq(notifications.type, "shop.legal_document_expiring")));
    expect(reminder.body).toContain("expires on");

    // Expired 3 days ago: still within the 15-day grace; 20 days ago: blocking.
    await db.update(shopLegalDocuments).set({ expiryDate: inDays(-3) }).where(eq(shopLegalDocuments.shopId, shop.id));
    let doc = (await getShopLegalStatus(shop.id)).documents[0];
    expect(doc).toMatchObject({ state: "EXPIRED", blocking: false });
    await db.update(shopLegalDocuments).set({ expiryDate: inDays(-20) }).where(eq(shopLegalDocuments.shopId, shop.id));
    doc = (await getShopLegalStatus(shop.id)).documents[0];
    expect(doc).toMatchObject({ state: "EXPIRED", blocking: true });
  });

  it("the sweep starts the grace period for every live shop that needs a licence", async () => {
    await enable();
    const { shop } = await sellableShop({ shopType: "PHARMACY" });
    const result = await runLegalDocumentSweep();
    expect(result.requirementsStarted).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(shopLegalDocuments).where(eq(shopLegalDocuments.shopId, shop.id));
    expect(rows.map((r) => r.docType)).toEqual(["DRUG_LICENCE"]);
    expect(rows.every((r) => r.graceUntil != null)).toBe(true);
  });
});
