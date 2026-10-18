/**
 * batch-2026-10 WS-F (F13.1.2): push notifications through the one
 * notification service — the PUSH channel, the mock and Expo adapters, the
 * delivery log's retries, receipts, device tokens and their route.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { DELETE, POST } from "@/app/api/push-tokens/route";
import { db } from "@/server/db";
import { auditLogs, notificationDeliveries, pushTickets, pushTokens } from "@/server/db/schema";
import { renderEmail } from "@/server/notifications/templates";
import { pushContent } from "@/server/notifications/push/channel";
import { createExpoPushProvider, EXPO_PUSH_RECEIPTS_URL, EXPO_PUSH_SEND_URL, type FetchLike } from "@/server/notifications/push/expo";
import { pushConfigProblem } from "@/server/notifications/push/provider";
import { checkPushReceipts } from "@/server/notifications/push/receipts";
import { registerPushToken } from "@/server/notifications/push/tokens";
import { PushTransientError } from "@/server/notifications/push/types";
import { NotificationService } from "@/server/notifications/service";
import { AUDIT_ACTIONS } from "@/server/services/audit";
import { deliverPending, getPreferenceMatrix, NOTIFICATION_TYPES, notify, setPreference } from "@/server/services/notifications";
import { clearRuleCache } from "@/server/services/settings";
import type { ServerEnv } from "@/lib/env";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

let tokenCounter = 0;
const newToken = (tag = "") => `ExponentPushToken[t${Date.now().toString(36)}${(tokenCounter += 1)}${tag}]`;

async function setRules(key: string, value: Record<string, unknown>) {
  await db.execute(sql`
    INSERT INTO platform_settings (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  clearRuleCache();
}

const pushOn = (provider: "mock" | "expo" = "mock") => setRules("push", { enabled: true, provider });

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

async function pushDeliveries(userId: string) {
  return db
    .select()
    .from(notificationDeliveries)
    .where(and(eq(notificationDeliveries.userId, userId), eq(notificationDeliveries.channel, "PUSH")));
}

/** Queue only (deferDelivery) and then run the outbox ourselves, so nothing races in the background. */
async function notifyDelivered(userId: string, extra: Partial<Parameters<typeof notify>[0]> = {}) {
  await notify({
    userId,
    type: NOTIFICATION_TYPES.ORDER_DELIVERED,
    vars: { orderNumber: "GK-1" },
    actionUrl: "/orders/1",
    deferDelivery: true,
    ...extra,
  });
}

function expoFetch(handler: (url: string, body: unknown) => { status?: number; json: unknown }) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fn: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const answer = handler(url, body);
    const status = answer.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => answer.json };
  };
  return { fn, calls };
}

beforeEach(async () => {
  await resetDatabase();
  await db.execute(sql`DELETE FROM platform_settings WHERE key IN ('push', 'notifications', 'broadcasts')`);
  clearRuleCache();
  state.session = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PUSH channel switch (rule push)", () => {
  it("TC-B26-F-001 with rule push off (default) a PUSH delivery is SKIPPED exactly as before", async () => {
    const user = await createUser();
    await registerPushToken(user.id, { token: newToken(), platform: "android" });
    await notifyDelivered(user.id, { channels: ["PUSH"] });
    await deliverPending();
    const [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("SKIPPED");
    expect(delivery.attempts).toBe(0);
    expect(delivery.lastError).toBe("No provider is configured for this channel.");
    expect(await db.select().from(pushTickets)).toHaveLength(0);
  });

  it("TC-B26-F-002 with rule push off no PUSH delivery is queued by default, even for app users", async () => {
    const user = await createUser();
    await registerPushToken(user.id, { token: newToken(), platform: "android" });
    await notifyDelivered(user.id);
    expect(await pushDeliveries(user.id)).toHaveLength(0);
  });
});

describe("mock push provider", () => {
  it("TC-B26-F-003 sends to the app user's device, writes the test outbox and keeps a ticket", async () => {
    await pushOn("mock");
    const user = await createUser();
    const token = newToken();
    await registerPushToken(user.id, { token, platform: "android" });
    await notifyDelivered(user.id);
    await deliverPending();

    const [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("SENT");
    expect(delivery.attempts).toBe(1);
    expect(delivery.providerRef).toBe("mock:1/1");
    const outbox = await db.execute<{ channel: string; body: string }>(
      sql`select channel, body from outbound_test_messages where to_address = ${token}`,
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0].channel).toBe("PUSH");
    expect(outbox[0].body).toContain("Order delivered");
    expect(outbox[0].body).toContain("/orders/1");
    const [ticket] = await db.select().from(pushTickets).where(eq(pushTickets.deliveryId, delivery.id));
    expect(ticket).toMatchObject({ provider: "mock", status: "PENDING_RECEIPT" });
  });

  it("TC-B26-F-004 push is on by default only with a device, only in the rule's categories, and the person's opt-out wins", async () => {
    await pushOn("mock");
    const noApp = await createUser();
    await notifyDelivered(noApp.id);
    expect(await pushDeliveries(noApp.id)).toHaveLength(0);

    const appUser = await createUser();
    await registerPushToken(appUser.id, { token: newToken(), platform: "ios" });
    // GENERAL (support news) is not in push.defaultOnCategories.
    await notify({ userId: appUser.id, type: NOTIFICATION_TYPES.SUPPORT_ACCEPT_OVERDUE, title: "x", body: "y", deferDelivery: true });
    expect(await pushDeliveries(appUser.id)).toHaveLength(0);

    await setPreference({ id: appUser.id, role: "CUSTOMER" }, "ORDERS", "PUSH", false);
    await notifyDelivered(appUser.id);
    expect(await pushDeliveries(appUser.id)).toHaveLength(0);

    await setPreference({ id: appUser.id, role: "CUSTOMER" }, "ORDERS", "PUSH", true);
    await notifyDelivered(appUser.id, { dedupeKey: "second" });
    expect(await pushDeliveries(appUser.id)).toHaveLength(1);
  });

  it("TC-B26-F-005 a simulated DeviceNotRegistered retires the token and the delivery is SKIPPED", async () => {
    await pushOn("mock");
    const user = await createUser();
    const token = newToken("DeviceNotRegistered");
    await registerPushToken(user.id, { token, platform: "android" });
    await notifyDelivered(user.id);
    await deliverPending();
    const [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("SKIPPED");
    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row).toMatchObject({ active: false, deactivatedReason: "DeviceNotRegistered" });
  });

  it("TC-B26-F-006 the mock is refused on the production site; Expo is allowed there", () => {
    const prod = { AUTH_URL: "https://gokesari.com", KYC_PRODUCTION_HOST: "gokesari.com" } as ServerEnv;
    const test = { AUTH_URL: "https://test.gokesari.com", KYC_PRODUCTION_HOST: "gokesari.com" } as ServerEnv;
    expect(pushConfigProblem({ provider: "mock" }, prod)).toMatch(/not allowed on the production site/);
    expect(pushConfigProblem({ provider: "expo" }, prod)).toBeNull();
    expect(pushConfigProblem({ provider: "mock" }, test)).toBeNull();
  });
});

describe("Expo push adapter", () => {
  it("TC-B26-F-007 posts the messages to Expo with the access token and maps tickets in order", async () => {
    const { fn, calls } = expoFetch(() => ({
      json: { data: [{ status: "ok", id: "ticket-1" }, { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }] },
    }));
    const provider = createExpoPushProvider({ accessToken: "secret-token", fetch: fn });
    const results = await provider.send([
      { to: "ExponentPushToken[a]", title: "T", body: "B", data: { url: "/orders/1" }, channelId: "default" },
      { to: "ExponentPushToken[b]", title: "T", body: "B" },
    ]);
    expect(calls[0].url).toBe(EXPO_PUSH_SEND_URL);
    expect(calls[0].headers.authorization).toBe("Bearer secret-token");
    expect(calls[0].body).toEqual([
      expect.objectContaining({ to: "ExponentPushToken[a]", title: "T", body: "B", data: { url: "/orders/1" }, channelId: "default", sound: "default" }),
      expect.objectContaining({ to: "ExponentPushToken[b]" }),
    ]);
    expect(results).toEqual([
      { token: "ExponentPushToken[a]", ok: true, ticketId: "ticket-1" },
      { token: "ExponentPushToken[b]", ok: false, errorCode: "DeviceNotRegistered", errorMessage: "gone" },
    ]);
  });

  it("TC-B26-F-008 HTTP 5xx / 429 and network errors are transient; receipts are read by ticket id", async () => {
    const busy = createExpoPushProvider({ fetch: expoFetch(() => ({ status: 503, json: { errors: [{ code: "INTERNAL" }] } })).fn });
    await expect(busy.send([{ to: "ExponentPushToken[a]", title: "T", body: "B" }])).rejects.toBeInstanceOf(PushTransientError);
    const offline = createExpoPushProvider({
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(offline.send([{ to: "ExponentPushToken[a]", title: "T", body: "B" }])).rejects.toBeInstanceOf(PushTransientError);

    const { fn, calls } = expoFetch(() => ({
      json: { data: { r1: { status: "ok" }, r2: { status: "error", message: "x", details: { error: "DeviceNotRegistered" } } } },
    }));
    const receipts = await createExpoPushProvider({ fetch: fn }).getReceipts(["r1", "r2"]);
    expect(calls[0]).toMatchObject({ url: EXPO_PUSH_RECEIPTS_URL, body: { ids: ["r1", "r2"] } });
    expect(receipts).toEqual({ r1: { ok: true }, r2: { ok: false, errorCode: "DeviceNotRegistered", errorMessage: "x" } });
  });

  it("TC-B26-F-009 through the outbox: Expo busy → FAILED with the attempt recorded, retried → SENT", async () => {
    await pushOn("expo");
    const user = await createUser();
    await registerPushToken(user.id, { token: newToken(), platform: "android" });
    let busy = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: !busy,
        status: busy ? 503 : 200,
        json: async () => (busy ? { errors: [{ code: "INTERNAL_SERVER_ERROR" }] } : { data: [{ status: "ok", id: "tk-1" }] }),
      })),
    );
    await notifyDelivered(user.id);
    await deliverPending();
    let [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("FAILED");
    expect(delivery.attempts).toBe(1);
    expect(delivery.lastError).toMatch(/busy/);
    expect(delivery.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    busy = false;
    await db.update(notificationDeliveries).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(notificationDeliveries.id, delivery.id));
    await deliverPending();
    [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("SENT");
    expect(delivery.attempts).toBe(2);
    expect(delivery.providerRef).toBe("expo:1/1");
  });

  it("TC-B26-F-010 through the outbox: DeviceNotRegistered deactivates the token (audited) and skips the delivery", async () => {
    await pushOn("expo");
    const user = await createUser();
    const token = newToken();
    await registerPushToken(user.id, { token, platform: "android" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }] }),
      })),
    );
    await notifyDelivered(user.id);
    await deliverPending();
    const [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("SKIPPED");
    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(row.active).toBe(false);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_ACTIONS.PUSH_TOKEN_DEACTIVATED));
    expect(audits).toHaveLength(1);
    const [ticket] = await db.select().from(pushTickets).where(eq(pushTickets.deliveryId, delivery.id));
    expect(ticket).toMatchObject({ status: "ERROR", errorCode: "DeviceNotRegistered" });
  });

  it("TC-B26-F-011 after maxAttempts failures the delivery is DEAD and audited", async () => {
    await pushOn("expo");
    await setRules("notifications", { maxAttempts: 1, alertSupportOnDead: false });
    const user = await createUser();
    await registerPushToken(user.id, { token: newToken(), platform: "ios" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await notifyDelivered(user.id);
    await deliverPending();
    const [delivery] = await pushDeliveries(user.id);
    expect(delivery.status).toBe("DEAD");
    expect(delivery.attempts).toBe(1);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, AUDIT_ACTIONS.NOTIFICATION_DELIVERY_DEAD));
    expect(audits.some((a) => a.entityId === delivery.id)).toBe(true);
  });

  it("TC-B26-F-012 receipts: OK → DELIVERED, DeviceNotRegistered → ERROR and the device retired", async () => {
    await pushOn("expo");
    const user = await createUser();
    const good = await registerPushToken(user.id, { token: newToken(), platform: "android" });
    const gone = await registerPushToken(user.id, { token: newToken(), platform: "ios" });
    const old = new Date(Date.now() - 20 * 60_000);
    await db.insert(pushTickets).values([
      { userId: user.id, pushTokenId: good.id, provider: "expo", ticketId: "r-ok", status: "PENDING_RECEIPT", createdAt: old },
      { userId: user.id, pushTokenId: gone.id, provider: "expo", ticketId: "r-gone", status: "PENDING_RECEIPT", createdAt: old },
      { userId: user.id, pushTokenId: good.id, provider: "expo", ticketId: "r-new", status: "PENDING_RECEIPT" },
    ]);
    const { fn } = expoFetch(() => ({
      json: { data: { "r-ok": { status: "ok" }, "r-gone": { status: "error", message: "x", details: { error: "DeviceNotRegistered" } } } },
    }));
    const tally = await checkPushReceipts({ provider: createExpoPushProvider({ fetch: fn }) });
    expect(tally).toMatchObject({ checked: 2, delivered: 1, errors: 1, deactivated: 1 });
    const tickets = await db.select().from(pushTickets);
    expect(tickets.find((t) => t.ticketId === "r-ok")?.status).toBe("DELIVERED");
    expect(tickets.find((t) => t.ticketId === "r-gone")?.status).toBe("ERROR");
    // Too young for a receipt (rule push.receiptDelayMinutes).
    expect(tickets.find((t) => t.ticketId === "r-new")?.status).toBe("PENDING_RECEIPT");
    const [goneRow] = await db.select().from(pushTokens).where(eq(pushTokens.id, gone.id));
    expect(goneRow.active).toBe(false);
  });

  it("TC-B26-F-013 the push text is the notification's title and body, not the email wrapper", () => {
    const email = renderEmail({ title: "Order delivered", body: "Your order GK-1 has been delivered. Enjoy!", actionUrl: "/orders/1", baseUrl: "https://test.gokesari.com" });
    expect(pushContent({ subject: email.subject, text: email.text })).toEqual({
      title: "Order delivered",
      body: "Your order GK-1 has been delivered. Enjoy!",
    });
  });
});

describe("device tokens (POST / DELETE /api/push-tokens)", () => {
  it("TC-B26-F-014 needs a signed-in person and a real Expo token", async () => {
    const anonymous = await call(POST, "/api/push-tokens", { method: "POST", body: { token: newToken(), platform: "android" } });
    expect(anonymous.status).toBe(401);
    signIn(await createUser());
    const bad = await call(POST, "/api/push-tokens", { method: "POST", body: { token: "not-a-push-token", platform: "android" } });
    expect(bad.status).toBe(422);
    const badPlatform = await call(POST, "/api/push-tokens", { method: "POST", body: { token: newToken(), platform: "windows" } });
    expect(badPlatform.status).toBe(422);
  });

  it("TC-B26-F-015 registers idempotently, moves a token to whoever signs in, and only the owner can unregister it", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const token = newToken();
    signIn(alice);
    const first = await call(POST, "/api/push-tokens", { method: "POST", body: { token, platform: "android", appVariant: "preview", deviceName: "Pixel" } });
    expect(first.status).toBe(200);
    const again = await call(POST, "/api/push-tokens", { method: "POST", body: { token, platform: "android", appVariant: "preview" } });
    expect(again.body.id).toBe(first.body.id);
    let rows = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: alice.id, appVariant: "preview", active: true });

    signIn(bob);
    await call(POST, "/api/push-tokens", { method: "POST", body: { token, platform: "android" } });
    rows = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(bob.id);

    signIn(alice);
    const notMine = await call(DELETE, "/api/push-tokens", { method: "DELETE", body: { token } });
    expect(notMine.body.unregistered).toBe(false);
    signIn(bob);
    const mine = await call(DELETE, "/api/push-tokens", { method: "DELETE", body: { token } });
    expect(mine.body.unregistered).toBe(true);
    [rows[0]] = await db.select().from(pushTokens).where(eq(pushTokens.token, token));
    expect(rows[0].active).toBe(false);
  });

  it("TC-B26-F-016 keeps at most push.maxDevicesPerUser active devices", async () => {
    await setRules("push", { maxDevicesPerUser: 2 });
    const user = await createUser();
    for (let i = 0; i < 3; i += 1) await registerPushToken(user.id, { token: newToken(), platform: "android" });
    const active = await db.select().from(pushTokens).where(and(eq(pushTokens.userId, user.id), eq(pushTokens.active, true)));
    expect(active).toHaveLength(2);
  });

  it("TC-B26-F-017 settings: push is offered only while rule push is on, and on by default for app users in its categories", async () => {
    const user = await createUser();
    const channel = (matrix: Awaited<ReturnType<typeof getPreferenceMatrix>>, category: string) =>
      matrix.find((r) => r.category === category)!.channels.find((c) => c.channel === "PUSH")!;
    let matrix = await NotificationService.preferences(user.id);
    expect(channel(matrix, "ORDERS")).toMatchObject({ available: false, enabled: false });

    await pushOn("mock");
    matrix = await getPreferenceMatrix(user.id);
    expect(channel(matrix, "ORDERS")).toMatchObject({ available: true, enabled: false });
    await registerPushToken(user.id, { token: newToken(), platform: "android" });
    matrix = await getPreferenceMatrix(user.id);
    expect(channel(matrix, "ORDERS").enabled).toBe(true);
    expect(channel(matrix, "ANNOUNCEMENTS").enabled).toBe(true);
    expect(channel(matrix, "GENERAL").enabled).toBe(false);
    expect(matrix.map((r) => r.category)).toContain("ANNOUNCEMENTS");
  });
});
