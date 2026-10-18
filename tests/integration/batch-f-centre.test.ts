/**
 * batch-2026-10 WS-F (F3.3.2): the Notification Centre API — the bell's panel
 * and /notifications — with read / unread per person and the open-one link.
 */
import { eq, sql } from "drizzle-orm";
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

import { GET as centreRoute } from "@/app/api/notifications/centre/route";
import { GET as inboxRoute, PATCH as inboxPatch } from "@/app/api/notifications/route";
import { GET as openRoute } from "@/app/notifications/[id]/route";
import { db } from "@/server/db";
import { notifications } from "@/server/db/schema";
import { safeActionUrl } from "@/server/notifications/centre";
import { listNotifications, NOTIFICATION_TYPES, notify } from "@/server/services/notifications";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function seed(userId: string, n: number, actionUrl = "/orders") {
  for (let i = 0; i < n; i += 1) {
    await notify({ userId, type: NOTIFICATION_TYPES.ORDER_ACCEPTED, title: `Note ${i}`, body: "Body", actionUrl, deferDelivery: true });
  }
}

async function open(id: string) {
  const res = await openRoute(new NextRequest(`http://localhost/notifications/${id}`), { params: Promise.resolve({ id }) });
  return { status: res.status, location: res.headers.get("location") };
}

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

describe("notification centre API", () => {
  it("TC-B26-F-050 needs a signed-in person", async () => {
    expect((await call(centreRoute, "/api/notifications/centre")).status).toBe(401);
  });

  it("TC-B26-F-051 lists only the person's own notifications, newest first, with unread / all filters and paging", async () => {
    const me = await createUser();
    const other = await createUser();
    await seed(me.id, 5);
    await seed(other.id, 2);
    signIn(me);
    const all = await call(centreRoute, "/api/notifications/centre?pageSize=2");
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 5, unread: 5, page: 1, pageCount: 3 });
    expect(all.body.items.map((i: { title: string }) => i.title)).toEqual(["Note 4", "Note 3"]);
    expect(all.body.items[0]).toMatchObject({ read: false, actionUrl: "/orders" });

    const page3 = await call(centreRoute, "/api/notifications/centre?pageSize=2&page=3");
    expect(page3.body.items).toHaveLength(1);

    const [first] = await db.select().from(notifications).where(eq(notifications.userId, me.id)).limit(1);
    await call(inboxPatch, "/api/notifications", { method: "PATCH", body: { id: first.id } });
    const unread = await call(centreRoute, "/api/notifications/centre?filter=unread&pageSize=50");
    expect(unread.body).toMatchObject({ total: 4, unread: 4 });
    expect(unread.body.items.every((i: { read: boolean }) => !i.read)).toBe(true);
  });

  it("TC-B26-F-052 mark all read sets the bell to zero for this person only", async () => {
    const me = await createUser();
    const other = await createUser();
    await seed(me.id, 3);
    await seed(other.id, 2);
    signIn(me);
    const res = await call(inboxPatch, "/api/notifications", { method: "PATCH", body: { all: true } });
    expect(res.body.unreadCount).toBe(0);
    signIn(other);
    expect((await call(inboxRoute, "/api/notifications")).body.unreadCount).toBe(2);
  });

  it("TC-B26-F-053 opening a notification marks it read and goes to its page; someone else's lands on the centre", async () => {
    const me = await createUser();
    const other = await createUser();
    await seed(me.id, 1, "/orders/abc");
    await seed(other.id, 1);
    const [mine] = await db.select().from(notifications).where(eq(notifications.userId, me.id));
    const [theirs] = await db.select().from(notifications).where(eq(notifications.userId, other.id));

    expect((await open(mine.id)).location).toMatch(/\/signin$/);
    signIn(me);
    const opened = await open(mine.id);
    expect(opened.status).toBe(303);
    expect(opened.location).toMatch(/\/orders\/abc$/);
    const [after] = await db.select().from(notifications).where(eq(notifications.id, mine.id));
    expect(after.readAt).not.toBeNull();

    expect((await open(theirs.id)).location).toMatch(/\/notifications$/);
    const [untouched] = await db.select().from(notifications).where(eq(notifications.id, theirs.id));
    expect(untouched.readAt).toBeNull();
    expect((await open("not-a-uuid")).location).toMatch(/\/notifications$/);
  });

  it("TC-B26-F-054 only in-site paths and https links are followed; expired notifications leave every list", async () => {
    expect(safeActionUrl("/wallet")).toBe("/wallet");
    expect(safeActionUrl("https://gokesari.com/x")).toBe("https://gokesari.com/x");
    expect(safeActionUrl("//evil.example")).toBeNull();
    expect(safeActionUrl("/\\evil.example")).toBeNull();
    expect(safeActionUrl("javascript:alert(1)")).toBeNull();
    expect(safeActionUrl("http://plain.example")).toBeNull();

    const me = await createUser();
    await notify({ userId: me.id, type: NOTIFICATION_TYPES.BROADCAST, title: "Old news", body: "x", metadata: { expiresAt: new Date(Date.now() - 1000).toISOString() }, deferDelivery: true });
    await notify({ userId: me.id, type: NOTIFICATION_TYPES.BROADCAST, title: "Fresh news", body: "y", metadata: { expiresAt: new Date(Date.now() + 60_000).toISOString() }, deferDelivery: true });
    await seed(me.id, 1);
    expect((await listNotifications(me.id)).map((n) => n.title).sort()).toEqual(["Fresh news", "Note 0"]);
    signIn(me);
    const centre = await call(centreRoute, "/api/notifications/centre");
    expect(centre.body).toMatchObject({ total: 2, unread: 2 });
    const [{ n }] = await db.execute<{ n: number }>(sql`select count(*)::int as n from notifications where user_id = ${me.id}`);
    expect(n).toBe(3); // nothing deleted — just hidden
  });
});
