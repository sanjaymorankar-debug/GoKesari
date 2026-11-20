/**
 * docs/shop-welcome-kit-2026-11: when a shop goes live the owner gets the welcome e-mail with two
 * printable banners (English + local language), each as a PDF plus an inline image, once per shop.
 */
import jsQR from "jsqr";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { db } from "@/server/db";
import { documentEmails, shops } from "@/server/db/schema";
import { deliverDocumentEmails } from "@/server/documents/email";
import { clearRuleCache } from "@/server/services/settings";
import { approveShop, setShopStatus } from "@/server/services/shops";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
  sent.emails.length = 0;
});

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
