/**
 * docs/shop-welcome-kit-2026-11: when a shop goes live the owner gets the welcome e-mail with two
 * printable banners (English + local language), each as a PDF plus an inline image, once per shop.
 * The owner and operations download them again (another owner 403, signed out 401); an admin sends
 * the kit to shops that were already live (feature flag, off by default; once per shop).
 */
import jsQR from "jsqr";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

const sent = vi.hoisted(() => ({
  emails: [] as { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; contentType: string; content: Buffer; cid?: string }[] }[],
}));
vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return {
    ...actual,
    emailMode: () => "smtp" as const,
    sendEmail: vi.fn(async (message: (typeof sent.emails)[number]) => {
      sent.emails.push(message);
    }),
  };
});

import { GET as adminKitGet, POST as adminKitPost } from "@/app/api/admin/shops/welcome-kit/route";
import { GET as bannerGet } from "@/app/api/shops/[id]/banner/route";
import { db } from "@/server/db";
import { auditLogs, documentEmails, shops } from "@/server/db/schema";
import { deliverDocumentEmails } from "@/server/documents/email";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import { approveShop, setShopStatus } from "@/server/services/shops";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
  clearFeatureFlagCache();
  sent.emails.length = 0;
  state.session = null;
});

const signInAs = (u: { id: string; email: string; name: string | null; role: UserRole } | null) => {
  state.session = u ? { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } } : null;
};

async function banner(shopId: string, query = "") {
  const response = await bannerGet(new NextRequest(`http://localhost/api/shops/${shopId}/banner${query}`), { params: Promise.resolve({ id: shopId }) });
  return { status: response.status, type: response.headers.get("content-type"), disposition: response.headers.get("content-disposition"), body: Buffer.from(await response.arrayBuffer()) };
}

async function liveShop(state: string | null) {
  const owner = await createUser({ role: "SHOP_OWNER", email: `owner-${Date.now()}@example.com` });
  const admin = await createUser({ role: "ADMIN" });
  const shop = await createShop(owner.id, { name: "Samarth Tea Center", status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE" });
  await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
  await db.update(shops).set({ feePaymentStatus: "PAID", state, pincode: state ? "411007" : "110001" }).where(eq(shops.id, shop.id));
  const approved = await approveShop(shop.id, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" });
  return { owner, admin, shop: approved };
}

const kitRows = (shopId: string) =>
  db.select().from(documentEmails).where(and(eq(documentEmails.docType, "SHOP_WELCOME_KIT"), eq(documentEmails.docId, shopId)));

describe("shop welcome kit", () => {
  it("queues the welcome e-mail with the approval and sends both banners (English + Marathi)", async () => {
    const { owner, shop } = await liveShop("Maharashtra");
    const rows = await kitRows(shop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(owner.id);
    expect(rows[0].subject).toContain("Samarth Tea Center is now live on GoKesari");
    expect(rows[0].body).toMatch(/Print in COLOUR/);

    expect((await deliverDocumentEmails()).sent).toBe(1);
    const email = sent.emails.find((e) => e.subject.includes("is now live on GoKesari"))!;
    expect(email.to).toBe(owner.email);
    expect(email.html).toContain("cid:gk-shop-banner-en");
    expect(email.html).toContain("cid:gk-shop-banner-mr");
    const files = email.attachments!.map((a) => a.filename).sort();
    expect(files).toEqual([
      `GoKesari-banner-en-${shop.slug}.jpg`,
      `GoKesari-banner-en-${shop.slug}.pdf`,
      `GoKesari-banner-mr-${shop.slug}.jpg`,
      `GoKesari-banner-mr-${shop.slug}.pdf`,
    ].sort());
    for (const pdf of email.attachments!.filter((a) => a.contentType === "application/pdf")) {
      expect(pdf.content.subarray(0, 5).toString()).toBe("%PDF-");
    }
    // The QR code on the banner opens the shop's own page.
    const jpeg = email.attachments!.find((a) => a.cid === "gk-shop-banner-en")!.content;
    const { data, info } = await sharp(jpeg).extract({ left: 1120, top: 590, width: 260, height: 240 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toMatch(new RegExp(`/shops/${shop.slug}$`));
  });

  it("uses Hindi as the local language outside Maharashtra", async () => {
    const { shop } = await liveShop(null);
    await deliverDocumentEmails();
    const email = sent.emails.find((e) => e.subject.includes("is now live on GoKesari"))!;
    expect(email.html).toContain("cid:gk-shop-banner-hi");
    expect(email.attachments!.some((a) => a.filename === `GoKesari-banner-hi-${shop.slug}.pdf`)).toBe(true);
  });

  it("welcomes a shop once, even when it is suspended and approved again", async () => {
    const { shop, admin } = await liveShop("Maharashtra");
    await deliverDocumentEmails();
    await setShopStatus(shop.id, "SUSPENDED", { id: admin.id, role: "ADMIN" }).catch(() => undefined);
    await db.update(shops).set({ status: "PENDING_APPROVAL" }).where(eq(shops.id, shop.id));
    await approveShop(shop.id, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" }).catch(() => undefined);
    expect(await kitRows(shop.id)).toHaveLength(1);
  });
});

describe("banner download (Seller Central → Marketing)", () => {
  it("serves the owner and operations both languages as PDF and PNG; another owner 403, signed out 401", async () => {
    const { owner, shop } = await liveShop("Maharashtra");

    signInAs(null);
    expect((await banner(shop.id)).status).toBe(401);

    const other = await createUser({ role: "SHOP_OWNER" });
    await createShop(other.id, { name: "Other Shop" });
    signInAs(other);
    expect((await banner(shop.id)).status).toBe(403);
    signInAs(await createUser({ role: "CUSTOMER" }));
    expect((await banner(shop.id)).status).toBe(403);

    signInAs(owner);
    const pdf = await banner(shop.id);
    expect(pdf).toMatchObject({ status: 200, type: "application/pdf" });
    expect(pdf.disposition).toContain(`GoKesari-banner-en-${shop.slug}.pdf`);
    expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    const png = await banner(shop.id, "?lang=local&format=png");
    expect(png).toMatchObject({ status: 200, type: "image/png" });
    expect(png.disposition).toContain(`GoKesari-banner-mr-${shop.slug}.png`);
    const { data, info } = await sharp(png.body).extract({ left: 1120, top: 590, width: 260, height: 240 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toMatch(new RegExp(`/shops/${shop.slug}$`));

    signInAs(await createUser({ role: "OPERATOR" }));
    expect((await banner(shop.id, "?lang=local")).status).toBe(200);
  });

  it("refuses a shop that is not live yet (its QR page would not open)", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const pending = await createShop(owner.id, { status: "PENDING_APPROVAL" });
    signInAs(owner);
    expect((await banner(pending.id)).status).toBe(409);
  });
});

describe("once per shop, ever", () => {
  it("does not welcome a shop again after it changes hands", async () => {
    const { shop, admin } = await liveShop("Maharashtra");
    const newOwner = await createUser({ role: "SHOP_OWNER" });
    await db.update(shops).set({ ownerId: newOwner.id, status: "PENDING_APPROVAL" }).where(eq(shops.id, shop.id));
    await approveShop(shop.id, { classification: "GREEN" }, { id: admin.id, role: "ADMIN" }).catch(() => undefined);
    const rows = await kitRows(shop.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).not.toBe(newOwner.id);
  });
});

describe("admin: send welcome kit to shops that were already live", () => {
  async function existingShops() {
    const admin = await createUser({ role: "ADMIN" });
    const make = async (name: string, city: string) => {
      const owner = await createUser({ role: "SHOP_OWNER", email: `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}@example.com` });
      const shop = await createShop(owner.id, { name });
      await db.update(shops).set({ city, state: "Maharashtra" }).where(eq(shops.id, shop.id));
      return shop;
    };
    return {
      admin,
      a: await make("Kirana A", "Pune"),
      b: await make("Kirana B", "Pune"),
      c: await make("Kirana C", "pune "),
      d: await make("Kirana D", "Nashik"),
    };
  }

  it("is off by default, admin only, and sends each shop the kit once", async () => {
    const { admin, a } = await existingShops();
    // Existing live shops are never e-mailed by themselves.
    expect(await db.select().from(documentEmails).where(eq(documentEmails.docType, "SHOP_WELCOME_KIT"))).toHaveLength(0);

    signInAs(admin);
    const off = await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { shopId: a.id } });
    expect(off.status).toBe(404);
    expect(off.body.error.details).toMatchObject({ reason: "FEATURE_NOT_AVAILABLE" });
    expect((await call(adminKitGet, "/api/admin/shops/welcome-kit?q=Kirana")).body).toMatchObject({ enabled: false, total: 4 });

    await setFeatureFlag("shop_welcome_kit_admin_send_enabled", { enabled: true, districtCodes: null }, "QA: welcome kit admin send", admin);
    signInAs(await createUser({ role: "OPERATOR" }));
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { shopId: a.id } })).status).toBe(403);
    signInAs(await createUser({ role: "SHOP_OWNER" }));
    expect((await call(adminKitGet, "/api/admin/shops/welcome-kit")).status).toBe(403);

    signInAs(admin);
    const first = await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { shopId: a.id } });
    expect(first.body).toMatchObject({ shopId: a.id, result: "QUEUED", welcomeKit: { status: "PENDING" } });
    const again = await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { shopId: a.id } });
    expect(again.body).toMatchObject({ result: "ALREADY_SENT" });
    expect(await kitRows(a.id)).toHaveLength(1);
    expect((await deliverDocumentEmails()).sent).toBe(1);
    expect(sent.emails).toHaveLength(1);
    expect(sent.emails[0].subject).toContain("Kirana A is now live on GoKesari");
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "shop.welcome_kit_sent"), eq(auditLogs.entityId, a.id)));
    expect(audit).toMatchObject({ actorId: admin.id });

    const pendingOwner = await createUser({ role: "SHOP_OWNER" });
    const pending = await createShop(pendingOwner.id, { status: "PENDING_APPROVAL" });
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { shopId: pending.id } })).status).toBe(409);
  });

  it("bulk by city: previews, then queues only the live shops there that never had it (for the outbox sweep)", async () => {
    const { admin, a, b, c, d } = await existingShops();
    await setFeatureFlag("shop_welcome_kit_admin_send_enabled", { enabled: true, districtCodes: null }, "QA: welcome kit admin send", admin);
    signInAs(admin);
    await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { shopId: a.id } });

    const preview = await call(adminKitGet, "/api/admin/shops/welcome-kit?city=PUNE&notWelcomed=1");
    expect(preview.body.total).toBe(2);
    expect(preview.body.shops.map((s: { id: string }) => s.id).sort()).toEqual([b.id, c.id].sort());

    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { bulk: {} } })).status).toBe(422);
    const bulk = await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { bulk: { city: "Pune" } } });
    expect(bulk.body).toEqual({ matched: 2, queued: 2, notQueued: 0, remaining: 0 });
    const rows = await db.select().from(documentEmails).where(and(eq(documentEmails.docType, "SHOP_WELCOME_KIT"), inArray(documentEmails.docId, [a.id, b.id, c.id, d.id])));
    expect(rows.map((r) => r.docId).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "shop.welcome_kit_bulk_sent"))).toHaveLength(1);

    // A second run finds nothing left in Pune.
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { bulk: { city: "Pune" } } })).body).toMatchObject({ matched: 0, queued: 0 });
  });
});
