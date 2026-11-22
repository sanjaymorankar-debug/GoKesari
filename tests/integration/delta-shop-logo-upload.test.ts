/**
 * docs/delta CF-011 (D-144): shop logo upload, against real PostgreSQL.
 *   - flag off (no row) → POST and DELETE refused with 404 FEATURE_NOT_AVAILABLE, logo unchanged
 *   - flag on → the owner uploads a JPEG; it is stored and set as the shop's logo (/api/images/<id>)
 *   - not an image → refused, logo unchanged
 *   - another shop owner → refused
 *   - DELETE clears the logo
 *   - the existing PATCH /api/shops/[id] still sets logoUrl as before
 */
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { DELETE as logoDelete, POST as logoPost } from "@/app/api/shops/[id]/logo/route";
import { PATCH as shopPatch } from "@/app/api/shops/[id]/route";
import { SHOP_LOGO_FLAG } from "@/lib/delta/shop-logo";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { shops, storedImages } from "@/server/db/schema";
import { getFeatureFlag, setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import { createShop, createUser, resetDatabase } from "../helpers/fixtures";

let admin: { id: string; role: UserRole };
let owner: { id: string; email: string; name: string | null };
let shopId: string;
let jpeg: Buffer;

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

const ctx = () => ({ params: Promise.resolve({ id: shopId }) });

function upload(body: Buffer, type = "image/jpeg") {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(body)], { type }), "logo.jpg");
  return logoPost(new Request(`http://x/api/shops/${shopId}/logo`, { method: "POST", body: form }) as unknown as NextRequest, ctx());
}

const logoOf = async () => (await db.select({ logoUrl: shops.logoUrl }).from(shops).where(eq(shops.id, shopId)))[0]?.logoUrl ?? null;

async function flagOn() {
  await setFeatureFlag(SHOP_LOGO_FLAG, { enabled: true, districtCodes: null }, "CF-011 test", admin);
}

beforeEach(async () => {
  clearRuleCache();
  await resetDatabase();
  resetRateLimits();
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
  const u = await createUser({ role: "SHOP_OWNER" });
  owner = { id: u.id, email: u.email, name: u.name };
  shopId = (await createShop(owner.id)).id;
  jpeg = await sharp({ create: { width: 400, height: 400, channels: 3, background: { r: 240, g: 120, b: 20 } } }).jpeg().toBuffer();
  signIn(owner, "SHOP_OWNER");
});

describe("CF-011 shop logo upload", () => {
  it("is OFF by default: upload and remove are refused (404) and the logo is unchanged", async () => {
    expect((await getFeatureFlag(SHOP_LOGO_FLAG)).enabled).toBe(false);
    const res = await upload(jpeg);
    expect(res.status).toBe(404);
    expect((await res.json()).error.details).toMatchObject({ reason: "FEATURE_NOT_AVAILABLE", feature: SHOP_LOGO_FLAG });
    const del = await logoDelete(new Request(`http://x/api/shops/${shopId}/logo`, { method: "DELETE" }) as unknown as NextRequest, ctx());
    expect(del.status).toBe(404);
    expect(await logoOf()).toBeNull();
    expect(await db.select().from(storedImages)).toHaveLength(0);
  });

  it("with the flag on, the owner uploads a logo and it becomes the shop's logo", async () => {
    await flagOn();
    const res = await upload(jpeg);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.logoUrl).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);
    expect(await logoOf()).toBe(body.logoUrl);
    const [image] = await db.select().from(storedImages);
    expect(image).toMatchObject({ ownerId: owner.id, purpose: "PRODUCT", contentType: "image/jpeg", width: 400, height: 400 });
  });

  it("refuses a file that is not an image and keeps the old logo", async () => {
    await flagOn();
    await upload(jpeg);
    const before = await logoOf();
    const res = await upload(Buffer.from("not an image at all, just text"), "image/jpeg");
    expect(res.status).toBe(422);
    expect(await logoOf()).toBe(before);
  });

  it("refuses another shop owner", async () => {
    await flagOn();
    const other = await createUser({ role: "SHOP_OWNER" });
    signIn({ id: other.id, email: other.email, name: other.name }, "SHOP_OWNER");
    const res = await upload(jpeg);
    expect([403, 404]).toContain(res.status);
    expect(await logoOf()).toBeNull();
  });

  it("removes the logo", async () => {
    await flagOn();
    await upload(jpeg);
    const res = await logoDelete(new Request(`http://x/api/shops/${shopId}/logo`, { method: "DELETE" }) as unknown as NextRequest, ctx());
    expect(res.status).toBe(200);
    expect(await logoOf()).toBeNull();
  });

  it("leaves the existing settings API unchanged: PATCH still sets logoUrl with the flag off", async () => {
    const res = await shopPatch(
      new Request(`http://x/api/shops/${shopId}`, {
        method: "PATCH",
        body: JSON.stringify({ logoUrl: "https://example.com/logo.png" }),
        headers: { "content-type": "application/json" },
      }) as unknown as NextRequest,
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(await logoOf()).toBe("https://example.com/logo.png");
  });
});
