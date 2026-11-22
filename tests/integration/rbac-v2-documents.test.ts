/**
 * RBAC v2 documents (brief §9; docs/rbac/05-documents.md): type from the bytes, versions never overwritten,
 * signed short-lived links, scope by role, no deletion below admin, two-admin deletion.
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/server/db";
import { featureFlags, shops, staffDocumentVersions, staffDocuments } from "@/server/db/schema";
import { decideApproval } from "@/server/approvals";
import { issueDownloadLink, listShopDocuments, readByLink, requestDocumentDeletion, uploadStaffDocument, verifyStaffDocument } from "@/server/rbac-support/documents";
import { clearFeatureFlagCache } from "@/server/services/feature-flags";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

vi.mock("@/server/email/transport", () => ({ sendEmail: vi.fn(async () => undefined) }));
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

const PDF = Buffer.from("%PDF-1.4\n% test\n1 0 obj << >> endobj\n%%EOF\n");
const PDF2 = Buffer.from("%PDF-1.4\n% second\n%%EOF\n");
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);

beforeEach(async () => {
  await resetDatabase();
  await db.insert(featureFlags).values({ key: "rbac_v2_support", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  clearFeatureFlagCache();
});

async function world() {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const shop = await createShop(owner.id, { status: "APPROVED" });
  const ops = await createUser({ role: "OPERATIONS_USER" });
  await db.update(shops).set({ onboardedByUserId: ops.id }).where(eq(shops.id, shop.id));
  const stranger = await createUser({ role: "SUPPORT_USER" });
  const manager = await createUser({ role: "SUPPORT_MANAGER" });
  const a1 = await createUser({ role: "ADMIN" });
  const a2 = await createUser({ role: "ADMIN" });
  return {
    shop,
    owner: { id: owner.id, role: "SHOP_OWNER" as const },
    ops: { id: ops.id, role: "OPERATIONS_USER" as const },
    stranger: { id: stranger.id, role: "SUPPORT_USER" as const },
    manager: { id: manager.id, role: "SUPPORT_MANAGER" as const },
    a1: { id: a1.id, role: "ADMIN" as const, email: a1.email },
    a2: { id: a2.id, role: "ADMIN" as const, email: a2.email },
  };
}

describe("documents", () => {
  it("reads the type from the bytes, refuses others, and keeps every version", async () => {
    const w = await world();
    await expect(uploadStaffDocument({ shopId: w.shop.id, docType: "AGREEMENT", title: "Agreement", filename: "agreement.pdf", data: EXE }, w.ops)).rejects.toThrow(/PDF, JPEG/);
    const first = await uploadStaffDocument({ shopId: w.shop.id, docType: "FSSAI", title: "FSSAI licence", filename: "fssai.pdf", data: PDF }, w.ops);
    await verifyStaffDocument(first.document.id, "VERIFIED", w.manager);
    const second = await uploadStaffDocument({ shopId: w.shop.id, documentId: first.document.id, docType: "FSSAI", title: "", filename: "fssai-renewed.pdf", data: PDF2 }, w.ops);
    expect(second.version).toBe(2);
    expect(second.document.verificationStatus).toBe("UNVERIFIED");
    const versions = await db.select().from(staffDocumentVersions).where(eq(staffDocumentVersions.documentId, first.document.id));
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2]);
    await expect(db.update(staffDocumentVersions).set({ filename: "x" })).rejects.toThrow();
  });

  it("only people who work on the shop (and its owner) can see or add documents", async () => {
    const w = await world();
    await expect(uploadStaffDocument({ shopId: w.shop.id, docType: "OTHER", title: "Note", filename: "n.pdf", data: PDF }, w.stranger)).rejects.toThrow(/cannot add/);
    await uploadStaffDocument({ shopId: w.shop.id, docType: "OTHER", title: "Note", filename: "n.pdf", data: PDF }, w.ops);
    expect(await listShopDocuments(w.shop.id, w.owner)).toHaveLength(1);
    await expect(listShopDocuments(w.shop.id, w.stranger)).rejects.toThrow(/cannot see/);
    await expect(verifyStaffDocument((await listShopDocuments(w.shop.id, w.ops))[0].id, "VERIFIED", w.ops)).rejects.toThrow(/Support Manager or admin/);
  });

  it("downloads only through a valid, unexpired signed link", async () => {
    const w = await world();
    const { document } = await uploadStaffDocument({ shopId: w.shop.id, docType: "PRICE_LIST", title: "Price list", filename: "list.pdf", data: PDF }, w.ops);
    await expect(issueDownloadLink(document.id, null, w.stranger)).rejects.toThrow(/not found/i);
    const link = await issueDownloadLink(document.id, null, w.owner);
    const token = decodeURIComponent(link.url.split("t=")[1]);
    expect((await readByLink(token)).data.equals(PDF)).toBe(true);
    await expect(readByLink(token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).rejects.toThrow(/not found/i);
    const parts = token.split(".");
    parts[2] = String(Math.floor(Date.now() / 1000) - 60);
    await expect(readByLink(parts.join("."))).rejects.toThrow(/not found/i);
  });

  it("deletion: never below admin; an admin's request needs a second admin", async () => {
    const w = await world();
    const { document } = await uploadStaffDocument({ shopId: w.shop.id, docType: "OTHER", title: "Old", filename: "o.pdf", data: PDF }, w.ops);
    await expect(requestDocumentDeletion(document.id, "Uploaded by mistake", w.manager)).rejects.toThrow(/Only an admin/);
    const req = await requestDocumentDeletion(document.id, "Uploaded by mistake", w.a1);
    await expect(decideApproval({ requestId: req.id, actor: w.a1, decision: "APPROVE" })).rejects.toThrow(/different admin/);
    await decideApproval({ requestId: req.id, actor: w.a2, decision: "APPROVE" });
    const [doc] = await db.select().from(staffDocuments).where(eq(staffDocuments.id, document.id));
    expect(doc.status).toBe("DELETED");
    expect(await db.select().from(staffDocumentVersions).where(eq(staffDocumentVersions.documentId, document.id))).toHaveLength(0);
  });
});
