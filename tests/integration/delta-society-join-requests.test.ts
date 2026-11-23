/**
 * docs/delta CF-006: riders ask to join a society's rider list; the society admin approves.
 *   - flag off (no row) → the rider's request and the society's list answer 404; nothing stored
 *   - flag on → an approved rider asks; a repeat returns the same pending request; staff are told
 *   - approve → the rider is on society_riders (ACTIVE, not preferred), via addSocietyRider; rider told
 *   - decline → nothing listed; withdraw by the rider; a decided request can't be decided again
 *   - refused: unapproved rider, unverified society, rider GoKesari blocked for the society,
 *     rider already listed, an OPERATOR deciding, another rider withdrawing
 *   - existing: the society admin still adds a rider by mobile number as before
 */
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as listGet, POST as askPost } from "@/app/api/societies/[id]/join-requests/route";
import { PATCH as decidePatch } from "@/app/api/societies/join-requests/[requestId]/route";
import { GET as mineGet } from "@/app/api/societies/join-requests/mine/route";
import { db } from "@/server/db";
import { notifications, societyJoinRequests, societyMembers, societyPartnerAccess, societyRiders } from "@/server/db/schema";
import { SOCIETY_JOIN_FLAG } from "@/server/services/delta/society-join-requests";
import { setFeatureFlag } from "@/server/services/feature-flags";
import { clearRuleCache } from "@/server/services/settings";
import { addSocietyRider, decideSociety, registerSociety } from "@/server/services/societies";
import { call } from "../helpers/http";
import { createDeliveryPartner, createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

type U = { id: string; email: string; name: string | null; role: UserRole };
function signIn(user: U, role: UserRole = user.role) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

let admin: U;
let founder: U;
let societyId: string;

async function society(verified = true, name = "Green Meadows") {
  const s = await registerSociety(
    verified
      ? { name, addressLine1: "Plot 7, Baner Road", area: "Baner", city: "Pune", pincode: "411045", latitude: 18.559, longitude: 73.786 }
      : { name, addressLine1: "Plot 22, Aundh Road", area: "Aundh", city: "Pune", pincode: "411007" },
    { id: founder.id, role: founder.role },
  );
  if (verified) await decideSociety(s.id, "verify", { id: admin.id, role: "ADMIN" });
  return s.id;
}

async function rider(status: "APPROVED" | "UNDER_REVIEW" = "APPROVED") {
  const u = await createUser({ role: "DELIVERY_PARTNER" });
  const mobile = uniqueMobile();
  const p = await createDeliveryPartner(u.id, { status });
  const { deliveryPartners } = await import("@/server/db/schema");
  await db.update(deliveryPartners).set({ mobile, fullName: "Ravi Rider" }).where(eq(deliveryPartners.id, p.id));
  return { user: { id: u.id, email: u.email, name: u.name, role: "DELIVERY_PARTNER" as UserRole }, partnerId: p.id, mobile };
}

const ask = (id = societyId, body: unknown = { message: "I deliver in Baner every evening" }) =>
  call(askPost as never, `/api/societies/${id}/join-requests`, { method: "POST", body, params: { id } });
const decide = (requestId: string, action: string) =>
  call(decidePatch as never, `/api/societies/join-requests/${requestId}`, { method: "PATCH", body: { action }, params: { requestId } });

async function flagOn() {
  await setFeatureFlag(SOCIETY_JOIN_FLAG, { enabled: true, districtCodes: null }, "CF-006 test", { id: admin.id, role: "ADMIN" });
}

beforeEach(async () => {
  clearRuleCache();
  await resetDatabase();
  state.session = null;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, email: a.email, name: a.name, role: "ADMIN" };
  const f = await createUser({ role: "CUSTOMER" });
  founder = { id: f.id, email: f.email, name: f.name, role: "SOCIETY_ADMIN" };
  societyId = await society();
});

describe("CF-006 riders ask to join a society", () => {
  it("is OFF by default: asking and listing answer 404 and nothing is stored", async () => {
    const r = await rider();
    signIn(r.user);
    const res = await ask();
    expect(res.status).toBe(404);
    expect(res.body.error.details).toMatchObject({ reason: "FEATURE_NOT_AVAILABLE", feature: SOCIETY_JOIN_FLAG });
    signIn(founder);
    expect((await call(listGet as never, `/api/societies/${societyId}/join-requests`, { params: { id: societyId } })).status).toBe(404);
    expect(await db.select().from(societyJoinRequests)).toHaveLength(0);
  });

  it("with the flag on, an approved rider asks; a repeat returns the same request; society staff are told", async () => {
    await flagOn();
    const r = await rider();
    signIn(r.user);
    const first = await ask();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "PENDING", societyId, deliveryPartnerId: r.partnerId, message: "I deliver in Baner every evening" });
    const again = await ask();
    expect(again.body.id).toBe(first.body.id);
    expect(await db.select().from(societyJoinRequests)).toHaveLength(1);
    const told = await db.select().from(notifications).where(eq(notifications.userId, founder.id));
    expect(told.some((n) => n.title === "A rider asked to join")).toBe(true);

    const mine = await call(mineGet as never, "/api/societies/join-requests/mine");
    expect(mine.body).toEqual([expect.objectContaining({ id: first.body.id, societyName: "Green Meadows", status: "PENDING" })]);

    signIn(founder);
    const list = await call(listGet as never, `/api/societies/${societyId}/join-requests`, { params: { id: societyId } });
    expect(list.status).toBe(200);
    expect(list.body).toEqual([expect.objectContaining({ id: first.body.id, riderName: "Ravi Rider" })]);
    expect(JSON.stringify(list.body)).not.toContain(r.mobile);
  });

  it("approval lists the rider through the existing rider list and tells the rider", async () => {
    await flagOn();
    const r = await rider();
    signIn(r.user);
    const req = (await ask()).body;
    signIn(founder);
    const res = await decide(req.id, "approve");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "APPROVED", decidedBy: founder.id });
    const [link] = await db
      .select()
      .from(societyRiders)
      .where(and(eq(societyRiders.societyId, societyId), eq(societyRiders.deliveryPartnerId, r.partnerId)));
    expect(link).toMatchObject({ status: "ACTIVE", preferred: false, addedBy: founder.id });
    const told = await db.select().from(notifications).where(eq(notifications.userId, r.user.id));
    expect(told.some((n) => n.title === "Society request approved")).toBe(true);
    expect((await decide(req.id, "decline")).status).toBe(409);
    signIn(r.user);
    expect((await ask()).status).toBe(409); // already listed
  });

  it("decline lists nobody; the rider can withdraw their own pending request, not someone else's", async () => {
    await flagOn();
    const r = await rider();
    signIn(r.user);
    const req = (await ask()).body;
    signIn(founder);
    expect((await decide(req.id, "decline")).body.status).toBe("DECLINED");
    expect(await db.select().from(societyRiders)).toHaveLength(0);

    signIn(r.user);
    const second = (await ask()).body;
    expect(second.id).not.toBe(req.id);
    const other = await rider();
    signIn(other.user);
    expect((await decide(second.id, "withdraw")).status).toBe(404);
    signIn(r.user);
    expect((await decide(second.id, "withdraw")).body.status).toBe("WITHDRAWN");
  });

  it("refuses an unapproved rider, an unverified society and a rider GoKesari blocked for the society", async () => {
    await flagOn();
    const pending = await rider("UNDER_REVIEW");
    signIn(pending.user);
    expect((await ask()).status).toBe(403);

    const r = await rider();
    signIn(r.user);
    const unverified = await society(false, "Blue Hills");
    expect((await ask(unverified)).status).toBe(409);

    await db.insert(societyPartnerAccess).values({ societyId, deliveryPartnerId: r.partnerId, access: "BLOCKED", decidedBy: admin.id });
    expect((await ask()).status).toBe(409);
    expect(await db.select().from(societyJoinRequests)).toHaveLength(0);
  });

  it("a society OPERATOR sees the list but only the ADMIN decides", async () => {
    await flagOn();
    const r = await rider();
    signIn(r.user);
    const req = (await ask()).body;
    const op = await createUser({ role: "CUSTOMER" });
    await db.insert(societyMembers).values({ societyId, userId: op.id, role: "OPERATOR", status: "ACTIVE" });
    signIn({ id: op.id, email: op.email, name: op.name, role: "CUSTOMER" });
    expect((await call(listGet as never, `/api/societies/${societyId}/join-requests`, { params: { id: societyId } })).status).toBe(200);
    expect((await decide(req.id, "approve")).status).toBe(403);
    expect(await db.select().from(societyRiders)).toHaveLength(0);
  });

  it("leaves the existing flow unchanged: the admin still adds a rider by mobile number with the flag off", async () => {
    const r = await rider();
    const row = await addSocietyRider(societyId, r.mobile, true, { id: founder.id, role: founder.role });
    expect(row).toMatchObject({ status: "ACTIVE", preferred: true });
  });
});
