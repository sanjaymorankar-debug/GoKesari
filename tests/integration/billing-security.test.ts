/**
 * Billing v2 (docs/billing §10; §13 scenario 17): role security on the new
 * billing endpoints. Only the shop's own owner (and an admin, for support)
 * opens a shop's billing — another shop's owner, a dealer, an operator and a
 * customer are refused — and a public-API token sees only the shop it was
 * issued for. Both layouts.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SessionUser = { id: string; email: string; name: string | null; image: null; role: string; status: string };
const session = vi.hoisted(() => ({ user: null as null | SessionUser }));
vi.mock("@/server/auth", () => ({ auth: async () => (session.user ? { user: session.user } : null), handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET } from "@/app/api/shops/[id]/accounts/[...path]/route";
import { GET as partiesGet } from "@/app/api/public/v1/parties/route";
import { POST as tokenPost } from "@/app/api/public/v1/oauth/token/route";
import { db } from "@/server/db";
import { eq } from "drizzle-orm";

import { featureFlags, shops, type UserRole } from "@/server/db/schema";
import { enabledFeatureKeysForShop, isFeatureEnabledForShop, setFeatureFlag } from "@/server/services/feature-flags";
import { createParty } from "@/server/accounts/parties";
import { createApiClient } from "@/server/public-api/auth";
import { gstin, gstShop, resetBatchE } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const signIn = (u: { id: string; email: string; name: string | null; role: string }) => (session.user = { id: u.id, email: u.email, name: u.name, image: null, role: u.role, status: "ACTIVE" });

async function get(shopId: string, endpoint: string) {
  const path = endpoint.split("?")[0].split("/");
  const res = await (GET as unknown as (r: NextRequest, c: { params: Promise<{ id: string; path: string[] }> }) => Promise<Response>)(new NextRequest(`http://localhost/api/shops/${shopId}/accounts/${endpoint}`), { params: Promise.resolve({ id: shopId, path }) });
  return res.status;
}

const ENDPOINTS = ["pos/items", "documents", "sync", "api-clients", "statements/wallet?period=2026-10", "statements/settlement?period=2026-10"];

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.insert(featureFlags).values({ key: "billing_v2", enabled: true }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled: true } });
  session.user = null;
});

describe("billing role security (scenario 17)", () => {
  it("only the shop's owner and an admin open its billing; another owner, a dealer, an operator and a customer are refused", async () => {
    const a = await gstShop({ name: "Shop A" });
    const b = await gstShop({ name: "Shop B" });

    for (const path of ENDPOINTS) {
      session.user = null;
      expect(await get(a.shop.id, path), `signed out ${path}`).toBe(401);

      signIn(a.owner);
      expect(await get(a.shop.id, path), `own owner ${path}`).not.toBeGreaterThanOrEqual(400);

      signIn(b.owner);
      expect(await get(a.shop.id, path), `other owner ${path}`).toBe(403);
    }
    for (const role of ["DEALER", "OPERATOR", "OPERATOR_LIMITED", "CUSTOMER", "DELIVERY_PARTNER"] as UserRole[]) {
      signIn(await createUser({ role }));
      for (const path of ENDPOINTS) expect(await get(a.shop.id, path), `${role} ${path}`).toBe(403);
    }
    signIn(await createUser({ role: "ADMIN" }));
    expect(await get(a.shop.id, "pos/items")).toBe(200);
  });

  it("a flag limited to districts opens billing only for the shops there (QA D-110)", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await setFeatureFlag("billing_v2", { enabled: true, districtCodes: ["MH-PUN"] }, "Pune pilot (test)", { id: admin.id, role: "ADMIN" });
    const pune = await gstShop({ name: "Pune shop" });
    const mumbai = await gstShop({ name: "Mumbai shop" });
    await db.update(shops).set({ pincode: "411001" }).where(eq(shops.id, pune.shop.id));
    await db.update(shops).set({ pincode: "400001" }).where(eq(shops.id, mumbai.shop.id));

    signIn(pune.owner);
    expect(await get(pune.shop.id, "pos/items")).toBe(200);
    signIn(mumbai.owner);
    expect(await get(mumbai.shop.id, "pos/items")).toBe(404);
    expect(await isFeatureEnabledForShop("billing_v2", pune.shop.id)).toBe(true);
    expect(await isFeatureEnabledForShop("billing_v2", mumbai.shop.id)).toBe(false);
    expect(await enabledFeatureKeysForShop(pune.shop.id)).toContain("billing_v2");
    expect(await enabledFeatureKeysForShop(mumbai.shop.id)).not.toContain("billing_v2");

    // The public API: a client of the Mumbai shop gets no token.
    const { client, clientSecret } = await createApiClient(mumbai.shop.id, { name: "ERP", scopes: ["parties:read"] }, mumbai.owner);
    const t = await tokenPost(
      new NextRequest("http://localhost/api/public/v1/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: clientSecret }).toString() }) as never,
    );
    expect(t.status).toBe(404);

    // Every district again: both shops.
    await setFeatureFlag("billing_v2", { enabled: true, districtCodes: null }, "All of India (test)", { id: admin.id, role: "ADMIN" });
    expect(await get(mumbai.shop.id, "pos/items")).toBe(200);
  });

  it("a public-API token reads only the shop it was issued for", async () => {
    const a = await gstShop({ name: "Shop A" });
    const b = await gstShop({ name: "Shop B" });
    await createParty(a.shop.id, { kind: "CUSTOMER", name: "A's customer", gstin: gstin("27", "AAACA1234K") }, a.owner.id);
    await createParty(b.shop.id, { kind: "CUSTOMER", name: "B's customer", gstin: gstin("27", "AAACB1234K") }, b.owner.id);
    const { client, clientSecret } = await createApiClient(a.shop.id, { name: "ERP", scopes: ["parties:read"] }, a.owner);
    const t = await tokenPost(
      new NextRequest("http://localhost/api/public/v1/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: client.clientId, client_secret: clientSecret }).toString() }) as never,
    );
    const token = ((await t.json()) as { access_token: string }).access_token;
    const res = await partiesGet(new NextRequest("http://localhost/api/public/v1/parties", { headers: { authorization: `Bearer ${token}` } }) as never);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("A's customer");
    expect(text).not.toContain("B's customer");
  });
});
