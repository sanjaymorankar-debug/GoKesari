/**
 * D-165 (25-Nov-2026): a document upload over the proxy's 10 MB body buffer reached the route cut short and was
 * answered "Attach the document — upload a file or take a photo.". The route now answers the size message for a
 * body declared over the limit, before reading the form.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/authz/guards", () => ({ requireShopAccess: vi.fn(async () => ({ user: { id: "u1", role: "SHOP_OWNER" } })) }));
vi.mock("@/server/api/rate-limit", () => ({ RATE_LIMITS: { SELLER_DOCUMENT_READ: {} }, enforceRateLimit: vi.fn() }));
const read = vi.hoisted(() => vi.fn(async () => ({ id: "upload-1" })));
vi.mock("@/server/services/document-uploads", () => ({ readUploadedDocument: read }));

import { NextRequest } from "next/server";

import { POST } from "@/app/api/shops/[id]/documents/read/route";
import { UPLOAD_REQUEST_LIMIT_BYTES, fileTooLargeMessage } from "@/lib/document-upload-limits";

const SHOP = "976135a1-ef87-4059-8ca7-2989db8724af";
const context = { params: Promise.resolve({ id: SHOP }) };

function upload(body: BodyInit, headers: Record<string, string> = {}) {
  return new NextRequest(`https://0.0.0.0:3000/api/shops/${SHOP}/documents/read`, { method: "POST", body, headers });
}

describe("document upload size (D-165)", () => {
  it("answers the size message for a body declared over 10 MB, without reading the form", async () => {
    read.mockClear();
    const res = await POST(upload("cut short", { "content-length": String(UPLOAD_REQUEST_LIMIT_BYTES + 500_000), "content-type": "multipart/form-data; boundary=x" }), context);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.message).toBe("The file can be at most 10 MB. Take the photo again at a lower size or upload a smaller PDF.");
    expect(read).not.toHaveBeenCalled();
  });

  it("still reads an upload under the limit", async () => {
    read.mockClear();
    const form = new FormData();
    form.set("file", new File([Buffer.from("%PDF-1.4\n%%EOF\n")], "doc.pdf", { type: "application/pdf" }));
    form.set("docType", "SHOP_ACT");
    const res = await POST(upload(form), context);
    expect(res.status).toBe(201);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("still asks for the document when the form has no file", async () => {
    const form = new FormData();
    form.set("docType", "SHOP_ACT");
    const res = await POST(upload(form), context);
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toBe("Attach the document — upload a file or take a photo.");
  });

  it("uses the same words as the rule documentUpload.maxUploadBytes", () => {
    expect(fileTooLargeMessage(5_000_000)).toBe("The file can be at most 5 MB. Take the photo again at a lower size or upload a smaller PDF.");
  });
});
