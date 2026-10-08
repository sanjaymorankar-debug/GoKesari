/**
 * Event layer — the safety-net cron jobs: timeout-sweep and notification-retry
 * answer only the scheduler, run every part even if one fails, and a message
 * given up on after N attempts alerts support in the app (once per run).
 */
import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every outbound send fails, so the retry path can be driven to DEAD.
vi.mock("@/server/notifications/channels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/notifications/channels")>();
  const failing = {
    channel: "EMAIL" as const,
    isAvailable: () => true,
    addressFor: (r: { email: string | null }) => r.email,
    send: async () => {
      throw new Error("SMTP connection refused");
    },
  };
  return { ...actual, getChannelProvider: () => failing };
});

import { GET as retryGet, POST as retryPost } from "@/app/api/cron/notification-retry/route";
import { GET as sweepGet, POST as sweepPost } from "@/app/api/cron/timeout-sweep/route";
import { db } from "@/server/db";
import { notificationDeliveries, notifications } from "@/server/db/schema";
import { NOTIFICATION_TYPES, deliverPending } from "@/server/services/notifications";
import { clearRuleCache } from "@/server/services/settings";
import { createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(notificationDeliveries);
  clearRuleCache();
});

const cron = (path: string, method: "GET" | "POST", secret = process.env.CRON_SECRET!) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${secret}` } });

describe("timeout-sweep", () => {
  it("refuses a caller without the cron secret and answers the probe without acting", async () => {
    expect((await sweepPost(cron("/api/cron/timeout-sweep", "POST", "wrong-secret"))).status).toBe(403);
    const probe = await sweepGet(cron("/api/cron/timeout-sweep", "GET"));
    expect(await probe.json()).toEqual({ status: "ready" });
  });

  it("runs every part and reports each", async () => {
    const res = await sweepPost(cron("/api/cron/timeout-sweep", "POST"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["dispatch", "errors", "returnPickups", "riderSearchAlerts", "shopAcceptance", "shopOpening"]);
    expect(body.errors).toEqual([]);
  });
});

describe("notification-retry", () => {
  it("a message failing N times is marked dead and support is alerted once", async () => {
    const operator = await createUser({ role: "OPERATOR" });
    const customer = await createUser({ role: "CUSTOMER" });
    // One attempt left before the default N = 4.
    await db.insert(notificationDeliveries).values({
      userId: customer.id,
      type: NOTIFICATION_TYPES.ORDER_CONFIRMED,
      category: "ORDERS",
      channel: "EMAIL",
      attempts: 3,
      maxAttempts: 4,
      status: "FAILED",
      subject: "Order placed",
      body: "Your order is confirmed.",
      nextAttemptAt: new Date(Date.now() - 1000),
    });

    const res = await retryPost(cron("/api/cron/notification-retry", "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dead: 1 });

    const alerts = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, operator.id), eq(notifications.type, NOTIFICATION_TYPES.SUPPORT_NOTIFICATION_DEAD)));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain("SMTP connection refused");
    // Nothing left to retry: a second run sends nothing and alerts nobody.
    expect(await deliverPending()).toMatchObject({ dead: 0 });
    expect((await retryGet(cron("/api/cron/notification-retry", "GET"))).status).toBe(200);
  });
});
