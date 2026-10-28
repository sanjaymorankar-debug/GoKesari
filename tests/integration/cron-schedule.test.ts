/**
 * The whole cron schedule in three entry points (owner, 19 Oct 2026):
 * every-minute, hourly and daily run each job at its own cadence, answer only
 * the scheduler, and run every job even when one fails.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The jobs never sign anyone in; next-auth itself does not load under Vitest.
vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as dailyGet, POST as dailyPost } from "@/app/api/cron/daily/route";
import { POST as everyMinutePost } from "@/app/api/cron/every-minute/route";
import { POST as hourlyPost } from "@/app/api/cron/hourly/route";
import { DAILY, EVERY_MINUTE, HOURLY, dueDaily, dueEveryMinute } from "@/server/cron/schedule";
import { clearRuleCache } from "@/server/services/settings";
import { resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  clearRuleCache();
});

const cron = (path: string, method: "GET" | "POST", secret = process.env.CRON_SECRET!) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${secret}` } });

const names = (jobs: readonly { name: string }[]) => jobs.map((j) => j.name);
const at = (minute: number) => new Date(Date.UTC(2026, 9, 19, 10, minute, 5));

describe("schedule", () => {
  it("covers every job that had its own crontab line", () => {
    expect([...names(EVERY_MINUTE), ...names(HOURLY), ...names(DAILY)].sort()).toEqual(
      [
        "aftercare", "auth-housekeeping", "bill-captures", "broadcast-dispatch", "daily-orders", "dealer-monthly-payout", "dispute-escalation",
        "document-emails", "finance-weekly", "gst-reminders", "integration-sync", "notification-retry", "operator-onboarding",
        "payments-reconcile", "payout-cycle", "payout-retries", "pmd-ingest", "purchase-list-reminders", "push-receipts",
        "risk-rules", "seller-verification", "timeout-sweep",
      ].sort(),
    );
  });

  it("keeps each every-minute job at its own cadence", () => {
    const always = ["timeout-sweep", "notification-retry", "broadcast-dispatch", "integration-sync", "pmd-ingest"];
    expect(names(dueEveryMinute(at(7)))).toEqual(always);
    expect(names(dueEveryMinute(at(5)))).toEqual([...always.slice(0, 4), "payments-reconcile", "operator-onboarding", "document-emails", "pmd-ingest"]);
    expect(names(dueEveryMinute(at(10)))).toContain("bill-captures");
    expect(names(dueEveryMinute(at(5)))).not.toContain("bill-captures");
    expect(names(dueEveryMinute(at(45)))).toContain("push-receipts");
    expect(names(dueEveryMinute(at(20)))).not.toContain("push-receipts");
    expect(names(dueEveryMinute(at(0)))).toEqual(names(EVERY_MINUTE));
  });

  it("runs the finance week on Mondays only; the payout cycle every day (it acts on Saturdays)", () => {
    expect(names(dueDaily("2026-10-19"))).toEqual(["daily-orders", "seller-verification", "gst-reminders", "payout-cycle", "finance-weekly", "dealer-monthly-payout", "purchase-list-reminders"]); // Monday
    expect(names(dueDaily("2026-10-24"))).toEqual(["daily-orders", "seller-verification", "gst-reminders", "payout-cycle", "dealer-monthly-payout", "purchase-list-reminders"]); // Saturday
  });
});

describe("entry points", () => {
  it("refuse a caller without the cron secret and answer the probe without acting", async () => {
    for (const [post, path] of [[everyMinutePost, "every-minute"], [hourlyPost, "hourly"], [dailyPost, "daily"]] as const) {
      expect((await post(cron(`/api/cron/${path}`, "POST", "wrong-secret"))).status).toBe(403);
    }
    expect(await (await dailyGet(cron("/api/cron/daily", "GET"))).json()).toEqual({ status: "ready" });
  });

  it("every-minute and hourly run each of their jobs and report each", async () => {
    const minute = await (await everyMinutePost(cron("/api/cron/every-minute", "POST"))).json();
    expect(minute.errors).toEqual([]);
    expect(Object.keys(minute.results).sort()).toEqual([...minute.ran].sort());
    expect(minute.ran).toEqual(expect.arrayContaining(["timeout-sweep", "notification-retry", "pmd-ingest"]));

    const hourly = await (await hourlyPost(cron("/api/cron/hourly", "POST"))).json();
    expect(hourly.errors).toEqual([]);
    expect(hourly.ran).toEqual(names(HOURLY));
    expect(hourly.results["payout-retries"]).toEqual({ skipped: "Automated payouts are off (rule payouts)." });
  });

  it("daily runs today's jobs; payouts stay off until switched on", async () => {
    const daily = await (await dailyPost(cron("/api/cron/daily", "POST"))).json();
    expect(daily.errors).toEqual([]);
    expect(daily.ran.slice(0, 4)).toEqual(["daily-orders", "seller-verification", "gst-reminders", "payout-cycle"]);
    expect(daily.results["payout-cycle"].skipped).toBe("Automated payouts are off (rule payouts).");
  });
});
