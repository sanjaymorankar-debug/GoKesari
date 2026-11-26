/**
 * docs/shop-welcome-kit-2026-11, owner brief 26-Nov-2026: the personalised welcome kit reaches every new shop,
 * whatever path made it live — once per shop, ever, never blocking the registration, retried on failure — and a
 * safety net catches any shop that went live without one. Also: the admin "Resend updated banner", the bulk send
 * to all live shops, and the owner's uploaded payment QR.
 *
 * Paths covered here: admin "mark as paid", admin payment link, dealer fee link, the automatic-approval rule.
 * The others carry the same check in their own suites: owner wizard + checkout (shop-registration-flow),
 * staff on the owner's behalf (batch-d-operator-limited TC-B26-D-010), instant GST/PAN approval
 * (dealer-step4-instant-approval), paid self-registration (shop-self-registration), admin approval
 * (shop-welcome-kit).
 */
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));
vi.mock("@/server/auth", () => ({ auth: async () => state.session, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

const sent = vi.hoisted(() => ({
  fail: 0,
  emails: [] as { to: string; subject: string; text: string; html?: string; attachments?: { filename: string; contentType: string; content: Buffer; cid?: string }[] }[],
}));
vi.mock("@/server/email/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/email/transport")>();
  return {
    ...actual,
    emailMode: () => "smtp" as const,
    sendEmail: vi.fn(async (message: (typeof sent.emails)[number]) => {
      if (sent.fail > 0) {
        sent.fail -= 1;
        throw new Error("SMTP 421 try again later");
      }
      sent.emails.push(message);
    }),
  };
});

import { POST as adminKitPost } from "@/app/api/admin/shops/welcome-kit/route";
import { DELETE as upiQrDelete, POST as upiQrPost } from "@/app/api/shops/[id]/banner/upi-qr/route";
import { db } from "@/server/db";
import { auditLogs, documentEmails, invSettings, platformSettings, shopRegistrationDrafts, shops } from "@/server/db/schema";
import { deliverDocumentEmails } from "@/server/documents/email";
import { listIntentsFor } from "@/server/payments/intents";
import { simulateSandboxCheckout } from "@/server/payments/sandbox-checkout";
import { qrSvg, upiBannerPayload } from "@/server/shop-banner/render";
import { runWelcomeKitSafetyNet, shopBannerFiles } from "@/server/shop-banner/welcome-kit";
import { ASSIST_FLAG, assistedFeeLink } from "@/server/services/assisted-onboarding";
import { clearFeatureFlagCache, setFeatureFlag } from "@/server/services/feature-flags";
import { createRegistrationLink, markRegistrationPaid } from "@/server/services/shop-registration-subscription";
import { recordPayment } from "@/server/services/shop-payments";
import { approveShop } from "@/server/services/shops";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createShop, createUser, resetDatabase, verifySellerDocuments } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
  clearFeatureFlagCache();
  sent.emails.length = 0;
  sent.fail = 0;
  state.session = null;
});

const signInAs = (u: { id: string; email: string; name: string | null; role: UserRole } | null) => {
  state.session = u ? { user: { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" } } : null;
};

const kitRows = (shopId: string, docType = "SHOP_WELCOME_KIT") =>
  db.select().from(documentEmails).where(and(eq(documentEmails.docType, docType), eq(documentEmails.docId, shopId)));

async function statusOf(shopId: string) {
  const [row] = await db.select({ status: shops.status }).from(shops).where(eq(shops.id, shopId));
  return row.status;
}

/** A new shop, documents verified, fee unpaid, waiting to go live; the automatic-approval rule on. */
async function pendingShop(name = "Samarth Tea Center", ownerName = "SUNITA PATIL") {
  const admin = await createUser({ role: "ADMIN" });
  await setRule("sellerVerification", { autoApproveShop: true }, { id: admin.id, role: "ADMIN" });
  const owner = await createUser({ role: "SHOP_OWNER", email: `owner-${Math.random().toString(36).slice(2)}@example.com` });
  const shop = await createShop(owner.id, { name, status: "PENDING_APPROVAL", shopType: "HARDWARE_STORE", registrationFeePaise: 500_000 });
  await verifySellerDocuments(shop.id, ["PAN", "GSTIN", "SHOP_ACT"]);
  await db.update(shops).set({ ownerName, state: "Maharashtra", pincode: "411007" }).where(eq(shops.id, shop.id));
  return { admin: { id: admin.id, role: "ADMIN" as const, email: admin.email, name: admin.name }, owner, shop };
}

/** The one welcome e-mail, delivered: personalised, both banners, the contact line and the footer. */
async function expectOneWelcome(shopId: string, ownerEmail: string) {
  expect(await statusOf(shopId)).toBe("APPROVED");
  expect(await kitRows(shopId)).toHaveLength(1);
  await deliverDocumentEmails();
  const mails = sent.emails.filter((e) => e.subject.includes("is now live on GoKesari.com"));
  expect(mails).toHaveLength(1);
  expect(mails[0].to).toBe(ownerEmail);
  expect(mails[0].text).toContain("Dear Sunita Patil, congratulations! Samarth Tea Center is now live on GoKesari.com");
  expect(mails[0].text).toContain("support@gokesari.com");
  expect(mails[0].text).toContain("+91 91751 93009");
  expect(mails[0].text).toContain("gokesari.com is a unit of ASMY GLOBAL TRADING & CONSULTANCY INDIA PRIVATE LIMITED");
  expect(mails[0].attachments!.filter((a) => a.contentType === "application/pdf")).toHaveLength(2);
}

describe("TC-WKIT-025 … 028: every payment path sends one personalised welcome kit", () => {
  it("TC-WKIT-025 admin 'mark as paid' (cash) → live → one welcome kit", async () => {
    const { admin, owner, shop } = await pendingShop();
    await markRegistrationPaid(shop.id, { reference: "CASH-WK-1", note: "cash at the office", method: "CASH" }, admin);
    await expectOneWelcome(shop.id, owner.email);
  });

  it("TC-WKIT-026 admin payment link, paid (sandbox success) → live → one welcome kit; a replayed capture sends nothing more", async () => {
    const { admin, owner, shop } = await pendingShop();
    const { link } = await createRegistrationLink(shop.id, {}, admin);
    await simulateSandboxCheckout({ ref: link.paymentIntentId, viewerId: null, outcome: "SUCCESS" });
    await expectOneWelcome(shop.id, owner.email);
    await simulateSandboxCheckout({ ref: link.paymentIntentId, viewerId: null, outcome: "SUCCESS" }).catch(() => undefined);
    expect(await kitRows(shop.id)).toHaveLength(1);
  });

  it("TC-WKIT-027 dealer fee link (assisted registration), paid → live → one welcome kit", async () => {
    const { admin, owner, shop } = await pendingShop();
    await setFeatureFlag(ASSIST_FLAG, { enabled: true, districtCodes: null }, "QA: assisted onboarding", admin);
    const dealer = await createUser({ role: "DEALER" as UserRole });
    await db.insert(shopRegistrationDrafts).values({ ownerId: owner.id, assistedByUserId: dealer.id, status: "SUBMITTED", shopId: shop.id } as typeof shopRegistrationDrafts.$inferInsert);
    const fee = await assistedFeeLink({ id: dealer.id, role: "DEALER" as UserRole }, owner.id);
    expect(fee.linkUrl).toBeTruthy();
    const [intent] = await listIntentsFor("SHOP_REGISTRATION_FEE", shop.id);
    await simulateSandboxCheckout({ ref: intent.id, viewerId: null, outcome: "SUCCESS" });
    await expectOneWelcome(shop.id, owner.email);
  });

  it("TC-WKIT-028 automatic approval when the fee is recorded (rule autoApproveShop) → one welcome kit", async () => {
    const { admin, owner, shop } = await pendingShop();
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 }, admin);
    await expectOneWelcome(shop.id, owner.email);
  });
});

describe("TC-WKIT-029 … 031: once, never blocking, retried", () => {
  it("TC-WKIT-029 a failure to queue never blocks the approval (the shop still goes live)", async () => {
    const { admin, shop } = await pendingShop();
    await setRule("shopWelcomeKit", { safetyNetEnabled: true, safetyNetFrom: new Date(Date.now() - 60_000).toISOString() }, admin);
    await db.update(shops).set({ feePaymentStatus: "PAID" }).where(eq(shops.id, shop.id));
    await db.execute(sql`ALTER TABLE document_emails RENAME TO document_emails_away`);
    try {
      await approveShop(shop.id, { classification: "GREEN" }, admin);
    } finally {
      await db.execute(sql`ALTER TABLE document_emails_away RENAME TO document_emails`);
    }
    expect(await statusOf(shop.id)).toBe("APPROVED");
    expect(await kitRows(shop.id)).toHaveLength(0);
    // …and the safety net picks it up.
    expect((await runWelcomeKitSafetyNet()).queued).toBe(1);
    expect(await kitRows(shop.id)).toHaveLength(1);
  });

  it("TC-WKIT-030 a failed send is retried with backoff and then sent; still one e-mail", async () => {
    const { admin, owner, shop } = await pendingShop();
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 }, admin);
    sent.fail = 1;
    expect((await deliverDocumentEmails()).failed).toBe(1);
    const [failed] = await kitRows(shop.id);
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    await db.update(documentEmails).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(documentEmails.id, failed.id));
    expect((await deliverDocumentEmails()).sent).toBe(1);
    expect((await kitRows(shop.id))[0].status).toBe("SENT");
    expect(sent.emails.filter((e) => e.to === owner.email && e.subject.includes("is now live on GoKesari.com"))).toHaveLength(1);
  });

  it("TC-WKIT-031 safety net: only shops live since the release without a kit; shops live before are never e-mailed", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const before = await createShop(owner.id, { name: "Old Shop" });
    const after = await createShop(owner.id, { name: "New Shop" });
    const from = new Date(Date.now() - 60 * 60_000);
    await db.update(shops).set({ approvedAt: new Date(from.getTime() - 24 * 60 * 60_000) }).where(eq(shops.id, before.id));
    await db.update(shops).set({ approvedAt: new Date() }).where(eq(shops.id, after.id));
    await db
      .insert(platformSettings)
      .values({ key: "shopWelcomeKit", value: { safetyNetEnabled: true, safetyNetFrom: from.toISOString() } })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: { safetyNetEnabled: true, safetyNetFrom: from.toISOString() } } });
    clearRuleCache();
    expect(await runWelcomeKitSafetyNet()).toEqual({ queued: 1, checked: 1 });
    expect(await kitRows(after.id)).toHaveLength(1);
    expect(await kitRows(before.id)).toHaveLength(0);
    expect(await runWelcomeKitSafetyNet()).toEqual({ queued: 0, checked: 0 });
    // Switched off: nothing.
    await db.update(platformSettings).set({ value: { safetyNetEnabled: false, safetyNetFrom: from.toISOString() } }).where(eq(platformSettings.key, "shopWelcomeKit"));
    clearRuleCache();
    await db.update(shops).set({ approvedAt: new Date() }).where(eq(shops.id, before.id));
    expect((await runWelcomeKitSafetyNet()).queued).toBe(0);
  });
});

describe("TC-WKIT-032 … 034: existing shops, resend, payment QR", () => {
  it("TC-WKIT-032 admin 'Resend updated banner': a shop that had the kit gets the new banner, no second welcome; 10-minute guard", async () => {
    const { admin, owner, shop } = await pendingShop();
    await recordPayment({ shopId: shop.id, paymentType: "REGISTRATION_FEE", amountPaise: 500_000 }, admin);
    await deliverDocumentEmails();
    signInAs(admin);
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { resendShopId: shop.id } })).status).toBe(404); // flag off
    await setFeatureFlag("shop_welcome_kit_admin_send_enabled", { enabled: true, districtCodes: null }, "QA: welcome kit admin send", admin);
    const first = await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { resendShopId: shop.id } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ shopId: shop.id, bannerUpdate: { status: "PENDING" } });
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { resendShopId: shop.id } })).status).toBe(409);
    await deliverDocumentEmails();
    const update = sent.emails.find((e) => e.subject.includes("updated GoKesari banners"))!;
    expect(update.to).toBe(owner.email);
    expect(update.text).toContain("Dear Sunita Patil, here are the updated GoKesari banners for Samarth Tea Center.");
    expect(update.text).not.toContain("congratulations");
    expect(update.attachments!.filter((a) => a.contentType === "application/pdf")).toHaveLength(2);
    expect(await kitRows(shop.id)).toHaveLength(1); // the welcome kit itself is untouched
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.action, "shop.banner_resent"), eq(auditLogs.entityId, shop.id)))).toHaveLength(1);
    // After the guard, it can be sent again (same row re-armed).
    await db.update(documentEmails).set({ updatedAt: new Date(Date.now() - 11 * 60_000) }).where(and(eq(documentEmails.docType, "SHOP_BANNER_UPDATE"), eq(documentEmails.docId, shop.id)));
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { resendShopId: shop.id } })).status).toBe(200);
    expect(await kitRows(shop.id, "SHOP_BANNER_UPDATE")).toHaveLength(1);
  });

  it("TC-WKIT-033 bulk send to all live shops that never had it (≤ 200 per run)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const a = await createShop(owner.id, { name: "Shop A" });
    const b = await createShop(owner.id, { name: "Shop B" });
    await db.update(shops).set({ city: "Nashik" }).where(eq(shops.id, b.id));
    await setFeatureFlag("shop_welcome_kit_admin_send_enabled", { enabled: true, districtCodes: null }, "QA: welcome kit admin send", admin);
    signInAs(admin);
    const run = await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { bulk: { all: true } } });
    expect(run.body).toEqual({ matched: 2, queued: 2, notQueued: 0, remaining: 0 });
    expect(await kitRows(a.id)).toHaveLength(1);
    expect(await kitRows(b.id)).toHaveLength(1);
    expect((await call(adminKitPost, "/api/admin/shops/welcome-kit", { method: "POST", body: { bulk: { all: true } } })).body).toMatchObject({ matched: 0, queued: 0 });
  });

  it("TC-WKIT-034 the owner uploads an existing UPI payment QR (checked); the banner prints it; a non-UPI or fixed-amount QR is refused", async () => {
    const owner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(owner.id, { name: "Samarth Tea Center" });
    const qrPng = async (text: string) => sharp(Buffer.from(qrSvg(text, 400))).png().toBuffer();
    const upload = async (png: Buffer) => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(png)], "qr.png", { type: "image/png" }));
      const response = await upiQrPost(new NextRequest(`http://localhost/api/shops/${shop.id}/banner/upi-qr`, { method: "POST", body: form }), { params: Promise.resolve({ id: shop.id }) });
      return { status: response.status, body: await response.json() };
    };
    signInAs(null);
    expect((await upload(await qrPng("upi://pay?pa=samarth@ybl&pn=Samarth"))).status).toBe(401);
    signInAs(await createUser({ role: "SHOP_OWNER" }));
    expect((await upload(await qrPng("upi://pay?pa=samarth@ybl&pn=Samarth"))).status).toBe(403);
    signInAs(owner);
    expect((await upload(await qrPng("https://example.com/not-upi"))).status).toBe(422);
    expect((await upload(await qrPng("upi://pay?pa=samarth@ybl&am=150.00"))).status).toBe(422);
    const merchant = "upi://pay?pa=Q8812345@ybl&pn=SAMARTH%20TEA&mc=5411&mode=02";
    const ok = await upload(await qrPng(merchant));
    expect(ok).toMatchObject({ status: 200, body: { vpa: "Q8812345@ybl", payeeName: "SAMARTH TEA" } });
    const [row] = await db.select().from(invSettings).where(eq(invSettings.shopId, shop.id));
    expect(row.bannerUpiQr).toBe(merchant);
    const files = await shopBannerFiles(shop.id);
    expect(files!.content.upi).toBe("uploaded");
    // Removed: back to the UPI ID from settings (none here → no panel).
    const del = await upiQrDelete(new NextRequest(`http://localhost/api/shops/${shop.id}/banner/upi-qr`, { method: "DELETE" }), { params: Promise.resolve({ id: shop.id }) });
    expect(del.status).toBe(200);
    expect((await shopBannerFiles(shop.id))!.content.upi).toBeNull();
    await db.update(invSettings).set({ upiVpa: "samarth.tea@okhdfcbank" }).where(eq(invSettings.shopId, shop.id));
    expect((await shopBannerFiles(shop.id))!.content.upi).toBe("samarth.tea@okhdfcbank");
    expect(upiBannerPayload({ vpa: "samarth.tea@okhdfcbank", shopName: shop.name })).toContain("pa=samarth.tea@okhdfcbank");
  });
});
