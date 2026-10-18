/**
 * batch-2026-10 WS-F (F3.3.2): broadcast announcements — who may send them,
 * audience resolution, channels by preference, chunked idempotent sending,
 * schedule, expiry, cancel and read counts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
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

import { GET as listRoute, POST as createRoute } from "@/app/api/admin/broadcasts/route";
import { POST as actionRoute } from "@/app/api/admin/broadcasts/[id]/route";
import { POST as estimateRoute } from "@/app/api/admin/broadcasts/estimate/route";
import { POST as cronDispatch } from "@/app/api/cron/broadcast-dispatch/route";
import { db } from "@/server/db";
import {
  addresses,
  auditLogs,
  broadcastRecipients,
  broadcasts,
  notificationDeliveries,
  notifications,
  userRoleGrants,
  users,
} from "@/server/db/schema";
import { listNotificationCentre } from "@/server/notifications/centre";
import { registerPushToken } from "@/server/notifications/push/tokens";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import {
  cancelBroadcast,
  createBroadcast,
  dispatchBroadcasts,
  getBroadcast,
  listBroadcasts,
  updateBroadcast,
  workBroadcast,
} from "@/server/services/broadcasts";
import { markRead, NOTIFICATION_TYPES, setPreference, unreadCount } from "@/server/services/notifications";
import { clearRuleCache } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createDeliveryPartner, createShop, createUser, resetDatabase } from "../helpers/fixtures";

async function setRules(key: string, value: Record<string, unknown>) {
  await db.execute(sql`
    INSERT INTO platform_settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  clearRuleCache();
}

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

const actorOf = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });
const base = (roles: string[] = ["CUSTOMER"], extra: Record<string, unknown> = {}) => ({
  title: "Diwali sweets",
  message: "Fresh pedas at every shop this week.",
  linkUrl: "/shops",
  audience: { roles },
  ...extra,
});

async function addAddress(userId: string, city: string, pincode: string) {
  await db.insert(addresses).values({ userId, line1: "1 Lane", city, pincode, addressType: "HOME" });
}

const broadcastNotes = (broadcastId: string) =>
  db.select().from(notifications).where(sql`${notifications.metadata} ->> 'broadcastId' = ${broadcastId}`);

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`DELETE FROM platform_settings WHERE key IN ('push', 'notifications', 'broadcasts')`);
  clearRuleCache();
  state.session = null;
});

describe("who may broadcast", () => {
  it("TC-B26-F-020 a customer or shop owner is refused (403); an operator and an admin may compose", async () => {
    signIn(await createUser({ role: "CUSTOMER" }));
    expect((await call(createRoute, "/api/admin/broadcasts", { method: "POST", body: base() })).status).toBe(403);
    expect((await call(listRoute, "/api/admin/broadcasts")).status).toBe(403);
    signIn(await createUser({ role: "SHOP_OWNER" }));
    expect((await call(createRoute, "/api/admin/broadcasts", { method: "POST", body: base() })).status).toBe(403);

    signIn(await createUser({ role: "OPERATOR" }));
    const byOperator = await call(createRoute, "/api/admin/broadcasts", { method: "POST", body: base() });
    expect(byOperator.status).toBe(201);
    expect(byOperator.body.broadcast.status).toBe("DRAFT");
    signIn(await createUser({ role: "ADMIN" }));
    const list = await call(listRoute, "/api/admin/broadcasts");
    expect(list.status).toBe(200);
    expect(list.body.broadcasts).toHaveLength(1);
  });

  it("TC-B26-F-021 bad input is refused: no audience, a bad PIN, a foreign-scheme link, a past schedule, expiry before sending", async () => {
    signIn(await createUser({ role: "ADMIN" }));
    const post = (body: unknown) => call(createRoute, "/api/admin/broadcasts", { method: "POST", body });
    expect((await post(base([]))).status).toBe(422);
    expect((await post(base(["CUSTOMER"], { audience: { roles: ["CUSTOMER"], pincodes: ["12"] } }))).status).toBe(422);
    expect((await post(base(["CUSTOMER"], { linkUrl: "javascript:alert(1)" }))).status).toBe(422);
    expect((await post(base(["CUSTOMER"], { linkUrl: "//evil.example" }))).status).toBe(422);
    expect((await post({ ...base(), action: "schedule", scheduleAt: new Date(Date.now() - 60_000).toISOString() })).status).toBe(422);
    const at = Date.now() + 3_600_000;
    expect(
      (await post({ ...base(), action: "schedule", scheduleAt: new Date(at).toISOString(), expiresAt: new Date(at - 60_000).toISOString() })).status,
    ).toBe(422);
  });

  it("TC-B26-F-022 with rule broadcasts.enabled off nobody can compose", async () => {
    await setRules("broadcasts", { enabled: false });
    const admin = await createUser({ role: "ADMIN" });
    await expect(createBroadcast(actorOf(admin), base())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("audience", () => {
  it("TC-B26-F-023 by role: customers (and society admins, and CUSTOMER grants), shop owners, riders; never suspended or deleted accounts", async () => {
    const admin = await createUser({ role: "ADMIN" });
    signIn(admin);
    const customer = await createUser({ role: "CUSTOMER" });
    const societyAdmin = await createUser({ role: "SOCIETY_ADMIN" });
    const owner = await createUser({ role: "SHOP_OWNER" });
    const ownerWhoShops = await createUser({ role: "SHOP_OWNER" });
    await db.insert(userRoleGrants).values({ userId: ownerWhoShops.id, role: "CUSTOMER", source: "BACKFILL" });
    const rider = await createUser({ role: "DELIVERY_PARTNER" });
    const riderByProfile = await createUser({ role: "CUSTOMER" });
    await createDeliveryPartner(riderByProfile.id);
    const suspended = await createUser({ role: "CUSTOMER" });
    await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, suspended.id));
    const deleted = await createUser({ role: "CUSTOMER" });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted.id));

    const estimate = async (roles: string[]) =>
      (await call(estimateRoute, "/api/admin/broadcasts/estimate", { method: "POST", body: { audience: { roles } } })).body.count;
    // customers: customer, society admin, owner with a CUSTOMER grant, rider-by-profile (a CUSTOMER account)
    expect(await estimate(["CUSTOMER"])).toBe(4);
    expect(await estimate(["SHOP_OWNER"])).toBe(2);
    expect(await estimate(["DELIVERY_PARTNER"])).toBe(2);
    expect(await estimate(["SHOP_OWNER", "DELIVERY_PARTNER"])).toBe(4);

    const b = await createBroadcast(actorOf(admin), base(["DELIVERY_PARTNER"]), "send");
    expect(b.status).toBe("SENT");
    const reached = (await db.select().from(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, b.id))).map((r) => r.userId).sort();
    expect(reached).toEqual([rider.id, riderByProfile.id].sort());
    void customer;
    void societyAdmin;
    void owner;
  });

  it("TC-B26-F-024 by city (any case) or PIN: customers and riders by saved address, shop owners by their shop", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const puneCustomer = await createUser();
    await addAddress(puneCustomer.id, "Pune", "411001");
    const nashikCustomer = await createUser();
    await addAddress(nashikCustomer.id, "Nashik", "422001");
    const noAddress = await createUser();
    const puneOwner = await createUser({ role: "SHOP_OWNER" });
    await createShop(puneOwner.id); // fixture shop: Pune 411001
    const otherOwner = await createUser({ role: "SHOP_OWNER" });
    void noAddress;
    void otherOwner;
    const nashikRider = await createUser({ role: "DELIVERY_PARTNER" });
    await addAddress(nashikRider.id, "Nashik", "422001");

    const reached = async (audience: Record<string, unknown>) => {
      const b = await createBroadcast(actorOf(admin), { ...base(), audience }, "send");
      return (await db.select().from(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, b.id))).map((r) => r.userId).sort();
    };
    expect(await reached({ roles: ["CUSTOMER"], cities: ["  pUnE "] })).toEqual([puneCustomer.id]);
    expect(await reached({ roles: ["CUSTOMER"], pincodes: ["422001"] })).toEqual([nashikCustomer.id]);
    expect(await reached({ roles: ["CUSTOMER"], cities: ["Pune"], pincodes: ["422001"] })).toEqual([puneCustomer.id, nashikCustomer.id].sort());
    expect(await reached({ roles: ["SHOP_OWNER"], cities: ["pune"] })).toEqual([puneOwner.id]);
    expect(await reached({ roles: ["SHOP_OWNER"], pincodes: ["999999"] })).toEqual([]);
    expect(await reached({ roles: ["DELIVERY_PARTNER", "SHOP_OWNER"], cities: ["Nashik", "Pune"] })).toEqual([puneOwner.id, nashikRider.id].sort());
  });
});

describe("sending", () => {
  it("TC-B26-F-025 send now: an in-app notification for everyone (announcement, with link and image), counts, audit, and the sender is told", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const people = [await createUser(), await createUser(), await createUser()];
    const b = await createBroadcast(
      actorOf(operator),
      { ...base(), imageUrl: "/api/images/00000000-0000-4000-8000-000000000001" },
      "send",
    );
    expect(b).toMatchObject({ status: "SENT", recipientCount: 3, audienceEstimate: 3 });
    expect(b.expiresAt).not.toBeNull(); // rule broadcasts.defaultExpiryDays
    const notes = await broadcastNotes(b.id);
    expect(notes.map((n) => n.userId).sort()).toEqual(people.map((p) => p.id).sort());
    expect(notes[0]).toMatchObject({ type: NOTIFICATION_TYPES.BROADCAST, title: "Diwali sweets", actionUrl: "/shops" });
    expect(notes[0].metadata).toMatchObject({ imageUrl: "/api/images/00000000-0000-4000-8000-000000000001" });
    const recipients = await db.select().from(broadcastRecipients).where(eq(broadcastRecipients.broadcastId, b.id));
    expect(recipients.every((r) => r.notificationId)).toBe(true);

    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, b.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining([AUDIT_ACTIONS.BROADCAST_SAVED, AUDIT_ACTIONS.BROADCAST_SEND_STARTED, AUDIT_ACTIONS.BROADCAST_SENT]));
    const [told] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, operator.id), eq(notifications.type, NOTIFICATION_TYPES.SUPPORT_BROADCAST_FINISHED)));
    expect(told.body).toContain("reached 3 people");
  });

  it("TC-B26-F-026 push and email follow each person's Announcements settings (opt-outs respected per channel)", async () => {
    await setRules("push", { enabled: true, provider: "mock" });
    const admin = await createUser({ role: "ADMIN" });
    const appUser = await createUser();
    await registerPushToken(appUser.id, { token: "ExponentPushToken[bc-app]", platform: "android" });
    const pushOptOut = await createUser();
    await registerPushToken(pushOptOut.id, { token: "ExponentPushToken[bc-optout]", platform: "ios" });
    await setPreference(actorOf(pushOptOut), "ANNOUNCEMENTS", "PUSH", false);
    const emailOptIn = await createUser();
    await setPreference(actorOf(emailOptIn), "ANNOUNCEMENTS", "EMAIL", true);
    const inAppOff = await createUser();
    await setPreference(actorOf(inAppOff), "ANNOUNCEMENTS", "IN_APP", false);

    const b = await createBroadcast(actorOf(admin), base(), "send");
    const deliveries = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.type, NOTIFICATION_TYPES.BROADCAST));
    const by = (userId: string) => deliveries.filter((d) => d.userId === userId).map((d) => d.channel).sort();
    expect(by(appUser.id)).toEqual(["PUSH"]);
    expect(by(pushOptOut.id)).toEqual([]);
    expect(by(emailOptIn.id)).toEqual(["EMAIL"]);
    expect(by(inAppOff.id)).toEqual([]);

    const notes = await broadcastNotes(b.id);
    expect(notes.map((n) => n.userId)).not.toContain(inAppOff.id);
    const [offRow] = await db
      .select()
      .from(broadcastRecipients)
      .where(and(eq(broadcastRecipients.broadcastId, b.id), eq(broadcastRecipients.userId, inAppOff.id)));
    expect(offRow.notificationId).toBeNull();
    expect(b.recipientCount).toBe(4); // the four customers above; the admin is not in the audience
  });

  it("TC-B26-F-027 large audiences are written in chunks: Send now writes the first, the dispatcher the rest", async () => {
    await setRules("broadcasts", { chunkSize: 10, immediateChunks: 1 });
    const admin = await createUser({ role: "ADMIN" });
    for (let i = 0; i < 24; i += 1) await createUser();
    const b = await createBroadcast(actorOf(admin), base(), "send");
    expect(b.status).toBe("SENDING");
    expect(b.recipientCount).toBe(10);
    const run = await dispatchBroadcasts({ deliverNow: false });
    expect(run).toMatchObject({ written: 14, finished: 1 });
    const after = await getBroadcast(b.id);
    expect(after).toMatchObject({ status: "SENT", recipientCount: 24 });
    expect(await broadcastNotes(b.id)).toHaveLength(24);
  });

  it("TC-B26-F-028 idempotent: re-running after a crash or overlapping runs never sends twice", async () => {
    await setRules("broadcasts", { chunkSize: 10, immediateChunks: 0 });
    const admin = await createUser({ role: "ADMIN" });
    for (let i = 0; i < 15; i += 1) await createUser();
    const b = await createBroadcast(actorOf(admin), base(), "send");
    expect(b).toMatchObject({ status: "SENDING", recipientCount: 0 });

    // Two dispatchers at once: the lease lets one work it.
    const [one, two] = await Promise.all([workBroadcast(b.id, 5, { deliverNow: false }), workBroadcast(b.id, 5, { deliverNow: false })]);
    expect(one.written + two.written).toBe(15);
    expect(await broadcastNotes(b.id)).toHaveLength(15);

    // A crash that lost the cursor: back to SENDING from the start.
    await db.update(broadcasts).set({ status: "SENDING", cursorUserId: null, leaseUntil: null }).where(eq(broadcasts.id, b.id));
    const again = await workBroadcast(b.id, 5, { deliverNow: false });
    expect(again.written).toBe(0);
    expect(await broadcastNotes(b.id)).toHaveLength(15);
    expect((await getBroadcast(b.id)).recipientCount).toBe(15);
    // Sending a sent broadcast again is refused.
    signIn(admin);
    expect((await call(actionRoute, `/api/admin/broadcasts/${b.id}`, { method: "POST", body: { action: "send" }, params: { id: b.id } })).status).toBe(409);
  });

  it("TC-B26-F-029 scheduled: nothing before its time; the dispatch job (cron route) sends it when due", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await createUser();
    const at = new Date(Date.now() + 60 * 60_000);
    const b = await createBroadcast(actorOf(admin), { ...base(), scheduleAt: at.toISOString() }, "schedule");
    expect(b.status).toBe("SCHEDULED");

    const cron = (auth: string | null) =>
      cronDispatch(
        new NextRequest("http://localhost/api/cron/broadcast-dispatch", {
          method: "POST",
          headers: auth ? { authorization: auth } : {},
        }),
      );
    expect((await cron(null)).status).toBe(403);
    const early = await cron(`Bearer ${process.env.CRON_SECRET}`);
    expect(early.status).toBe(200);
    expect((await getBroadcast(b.id)).status).toBe("SCHEDULED");

    const due = await dispatchBroadcasts({ now: new Date(at.getTime() + 1000), deliverNow: false });
    expect(due).toMatchObject({ started: 1, finished: 1 });
    const sent = await getBroadcast(b.id);
    expect(sent).toMatchObject({ status: "SENT", recipientCount: 1, sentBy: admin.id });
  });

  it("TC-B26-F-030 expiry: an expired broadcast leaves the notification centre and the unread count, and is marked EXPIRED", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const person = await createUser();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000);
    const b = await createBroadcast(actorOf(admin), { ...base(), expiresAt: expiresAt.toISOString() }, "send");
    expect((await listNotificationCentre(person.id)).items.map((i) => i.title)).toContain("Diwali sweets");
    expect(await unreadCount(person.id)).toBe(1);

    // Time passes: the notification's expiry (copied from the broadcast) is now behind us.
    await db.execute(
      sql`UPDATE notifications SET metadata = jsonb_set(metadata, '{expiresAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text)) WHERE metadata ->> 'broadcastId' = ${b.id}`,
    );
    expect((await listNotificationCentre(person.id)).items).toHaveLength(0);
    expect(await unreadCount(person.id)).toBe(0);

    const run = await dispatchBroadcasts({ now: new Date(expiresAt.getTime() + 1000), deliverNow: false });
    expect(run.expired).toBe(1);
    expect((await getBroadcast(b.id)).status).toBe("EXPIRED");
    expect((await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_ACTIONS.BROADCAST_EXPIRED))).length).toBe(1);
  });

  it("TC-B26-F-031 cancel: a scheduled broadcast never goes out; a sending one stops; a sent one cannot be cancelled", async () => {
    await setRules("broadcasts", { chunkSize: 10, immediateChunks: 1 });
    const operator = await createUser({ role: "OPERATOR" });
    for (let i = 0; i < 12; i += 1) await createUser();
    const scheduled = await createBroadcast(actorOf(operator), { ...base(), scheduleAt: new Date(Date.now() + 60_000).toISOString() }, "schedule");
    signIn(operator);
    const cancelled = await call(actionRoute, `/api/admin/broadcasts/${scheduled.id}`, { method: "POST", body: { action: "cancel" }, params: { id: scheduled.id } });
    expect(cancelled.body.broadcast.status).toBe("CANCELLED");
    await dispatchBroadcasts({ now: new Date(Date.now() + 120_000), deliverNow: false });
    expect(await broadcastNotes(scheduled.id)).toHaveLength(0);

    const sending = await createBroadcast(actorOf(operator), base(), "send");
    expect(sending).toMatchObject({ status: "SENDING", recipientCount: 10 });
    await cancelBroadcast(actorOf(operator), sending.id);
    await dispatchBroadcasts({ deliverNow: false });
    expect((await getBroadcast(sending.id)).recipientCount).toBe(10);

    await setRules("broadcasts", { chunkSize: 50 });
    const sent = await createBroadcast(actorOf(operator), base(), "send");
    expect(sent.status).toBe("SENT");
    await expect(cancelBroadcast(actorOf(operator), sent.id)).rejects.toMatchObject({ code: "CONFLICT" });
    const actions = (await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_ACTIONS.BROADCAST_CANCELLED))).length;
    expect(actions).toBe(2);
  });

  it("TC-B26-F-032 read counts per broadcast follow each person's read state", async () => {
    const admin = await createUser({ role: "ADMIN" });
    const [a, b2, c] = [await createUser(), await createUser(), await createUser()];
    const b = await createBroadcast(actorOf(admin), base(), "send");
    const notes = await broadcastNotes(b.id);
    await markRead(a.id, notes.find((n) => n.userId === a.id)!.id);
    await markRead(b2.id, notes.find((n) => n.userId === b2.id)!.id);
    // Someone else's id does nothing.
    await markRead(c.id, notes.find((n) => n.userId === a.id)!.id);
    const [listed] = await listBroadcasts();
    expect(listed).toMatchObject({ id: b.id, recipientCount: 3, readCount: 2 });
    expect(await unreadCount(c.id)).toBe(1);
  });

  it("TC-B26-F-033 a draft can be edited; a sent broadcast cannot", async () => {
    const admin = await createUser({ role: "ADMIN" });
    await createUser();
    const draft = await createBroadcast(actorOf(admin), base());
    const edited = await updateBroadcast(actorOf(admin), draft.id, { ...base(), title: "New title", audience: { roles: ["SHOP_OWNER"] } });
    expect(edited).toMatchObject({ title: "New title", audience: { roles: ["SHOP_OWNER"] }, status: "DRAFT" });
    const sent = await createBroadcast(actorOf(admin), base(), "send");
    await expect(updateBroadcast(actorOf(admin), sent.id, base())).rejects.toMatchObject({ code: "CONFLICT" });
    const ids = (await db.select().from(broadcasts).where(inArray(broadcasts.id, [draft.id, sent.id]))).length;
    expect(ids).toBe(2);
  });
});
