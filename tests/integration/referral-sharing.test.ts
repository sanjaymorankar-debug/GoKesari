/**
 * Referral sharing (docs/referral-sharing-2026-11; rule referralSharing; table referral_link_events).
 *
 * Covers: /r/<code> for customer, shop-owner (dealer GKD- / team lead GKT- / agent) and GoKesari codes —
 * landing, cookies and the click log with its channel; hyphenated dealer codes; expired, closed and
 * unknown codes (the /invite page with the reason); self-referral; first valid link wins; the share log
 * (owner only, a dealer for his employees' codes); the deferred link after an app install (/app-open,
 * claimed once); "My referrals" numbers from the existing tables; the admin report's filters; the
 * franchise message before the generic "inactive" in registration; and the rule switched off (the
 * original route, nothing logged).
 */
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | { user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" } },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { GET as appOpen } from "@/app/app-open/route";
import { POST as sharePost } from "@/app/api/referral-links/share/route";
import { GET as rLink } from "@/app/r/[code]/route";
import { RULES } from "@/server/config/rules";
import { db } from "@/server/db";
import {
  customerReferrals,
  dealers,
  dealerSalespeople,
  platformSettings,
  referralCodes,
  referralLinkEvents,
  referralRedemptions,
  users,
} from "@/server/db/schema";
import { issueCode } from "@/server/dealers/codes";
import { prefixedCode } from "@/server/franchise/prefixed-code";
import { resetRateLimits } from "@/server/api/rate-limit";
import { getOrCreateReferralCode } from "@/server/services/customer-referrals";
import { claimDeferredReferral, findDeferredReferral, logShare, myReferralStats, referralReport, resolveReferralLink } from "@/server/services/referral-links";
import { createReferralCode } from "@/server/services/referrals";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { createShop, createUser, resetDatabase, uniqueMobile } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
const APP_UA = "Mozilla/5.0 (Linux; Android 14) GoKesariApp/1.15.0 (android)";
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) Chrome/130";

beforeEach(async () => {
  await resetDatabase();
  await db.delete(referralLinkEvents);
  for (const key of ["referralSharing", "customerReferrals"]) await db.delete(platformSettings).where(eq(platformSettings.key, key));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  await setRule("customerReferrals", { ...RULES.customerReferrals.defaults, enabled: true }, admin);
});

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole = "CUSTOMER") {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

function open(code: string, opts: { channel?: string; ip?: string; ua?: string; cookie?: string } = {}) {
  const url = `https://test.gokesari.com/r/${encodeURIComponent(code)}${opts.channel ? `?c=${opts.channel}` : ""}`;
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.7", "user-agent": opts.ua ?? BROWSER_UA };
  if (opts.cookie) headers.cookie = opts.cookie;
  return rLink(new NextRequest(url, { headers }), { params: Promise.resolve({ code }) });
}

const events = () => db.select().from(referralLinkEvents);

async function customerWithCode(name = "Asha Patil") {
  const user = await createUser({ name });
  await db.update(users).set({ createdAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(users.id, user.id));
  return { user, code: await getOrCreateReferralCode(user.id) };
}

async function dealerWithCodes() {
  const user = await createUser({ role: "DEALER", name: "Shree Traders" });
  const [dealer] = await db
    .insert(dealers)
    .values({ userId: user.id, legalName: "Shree Traders", contactName: "Shree", dealerType: "PROPRIETORSHIP", status: "APPROVED", mobileE164: `+91${uniqueMobile()}`, decidedAt: new Date() })
    .returning();
  const main = await db.transaction((tx) => issueCode(tx, { dealerId: dealer.id, kind: "DEALER", makeCode: () => prefixedCode("GKD"), label: "Shree Traders", referrerName: "Shree Traders", referrerUserId: user.id }, admin));
  const leadUser = await createUser({ name: "Ravi Jadhav" });
  const [lead] = await db.insert(dealerSalespeople).values({ dealerId: dealer.id, employeeId: "TL-1", name: "Ravi Jadhav", userId: leadUser.id, teamRole: "TEAM_LEAD", depth: 2 }).returning();
  const leadCode = await db.transaction((tx) => issueCode(tx, { dealerId: dealer.id, salespersonId: lead.id, kind: "SALESPERSON", makeCode: () => prefixedCode("GKT"), label: "Ravi" }, admin));
  const agentUser = await createUser({ name: "Meera Shinde" });
  const [agent] = await db.insert(dealerSalespeople).values({ dealerId: dealer.id, employeeId: "AG-1", name: "Meera Shinde", userId: agentUser.id, teamRole: "AGENT", depth: 3, parentId: lead.id }).returning();
  const agentCode = await db.transaction((tx) => issueCode(tx, { dealerId: dealer.id, salespersonId: agent.id, kind: "SALESPERSON", makeCode: () => prefixedCode("GKA"), label: "Meera" }, admin));
  return { user, dealer, main: main.code, lead: { user: leadUser, code: leadCode.code }, agent: { user: agentUser, code: agentCode.code } };
}

describe("/r/<code> with referral sharing on (default)", () => {
  it("a customer code: sign-in, both cookies, the click logged with its channel", async () => {
    const { user, code } = await customerWithCode();
    const res = await open(code, { channel: "wa" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.cookies.get("gk_ref")?.value).toBe(code);
    expect(res.cookies.get("gk_ref_link")?.value).toBe(code);
    const [e] = await events();
    expect(e).toMatchObject({ code, kind: "CUSTOMER", event: "CLICK", channel: "whatsapp", outcome: "OK", referrerUserId: user.id, inApp: false });
    expect(e.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.ipHash).not.toContain("203.0.113.7");
    const target = await resolveReferralLink(code);
    expect(target.referrerName).toBe("Asha");
  });

  it("dealer, team lead and agent codes keep their hyphen and open Add my shop with the code filled in", async () => {
    const d = await dealerWithCodes();
    expect(d.main).toMatch(/^GKD-/);
    for (const [code, level] of [
      [d.main, "Dealer"],
      [d.lead.code, "Team lead"],
      [d.agent.code, "Agent"],
    ] as const) {
      const res = await open(code, { channel: "sms" });
      expect(res.headers.get("location")).toBe(`/shop/register?ref=${encodeURIComponent(code)}`);
      expect(res.cookies.get("gk_ref")).toBeUndefined(); // customer setup never sees a dealer code
      expect(res.cookies.get("gk_ref_link")?.value).toBe(code);
      const t = await resolveReferralLink(code.toLowerCase());
      expect(t).toMatchObject({ kind: "DEALER", level, audience: "shop-owner", usable: true });
    }
    expect((await resolveReferralLink(d.lead.code)).referrerName).toBe("Ravi Jadhav (Shree Traders)");
    expect((await resolveReferralLink(d.lead.code)).referrerUserId).toBe(d.lead.user.id);
  });

  it("expired, closed and unknown codes go to /invite with the reason, logged as such", async () => {
    const expired = await createReferralCode({ code: "OLDCODE1" }, admin);
    await db.update(referralCodes).set({ expiresAt: "2026-01-31" }).where(eq(referralCodes.id, expired.id));
    const closed = await createReferralCode({ code: "SHUTCODE" }, admin);
    await db.update(referralCodes).set({ status: "INACTIVE" }).where(eq(referralCodes.id, closed.id));

    const r1 = await open("OLDCODE1");
    expect(r1.headers.get("location")).toBe("/invite/OLDCODE1");
    expect(r1.cookies.get("gk_ref")).toBeUndefined();
    expect((await resolveReferralLink("OLDCODE1")).message).toMatch(/expired on 2026-01-31/);
    const r2 = await open("SHUTCODE");
    expect(r2.headers.get("location")).toBe("/invite/SHUTCODE");
    expect((await resolveReferralLink("SHUTCODE")).message).toMatch(/inactive/);
    const r3 = await open("NOSUCH99");
    expect(r3.headers.get("location")).toBe("/invite/NOSUCH99");
    const outcomes = (await events()).map((e) => `${e.code}:${e.outcome}`).sort();
    expect(outcomes).toEqual(["NOSUCH99:INVALID", "OLDCODE1:EXPIRED", "SHUTCODE:CLOSED"]);
  });

  it("self-referral: your own link changes nothing and is logged as SELF", async () => {
    const { user, code } = await customerWithCode();
    signIn(user);
    const res = await open(code);
    expect(res.headers.get("location")).toBe("/refer");
    expect(res.cookies.get("gk_ref")).toBeUndefined();
    expect((await events())[0].outcome).toBe("SELF");
    const d = await dealerWithCodes();
    signIn(d.user, "DEALER");
    const own = await open(d.main);
    expect(own.headers.get("location")).toBe("/referrals");
  });

  it("first valid link wins: a later link does not replace the earlier code", async () => {
    const first = await customerWithCode("First Friend");
    const second = await customerWithCode("Second Friend");
    const res = await open(second.code, { cookie: `gk_ref_link=${first.code}; gk_ref=${first.code}` });
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.cookies.get("gk_ref")).toBeUndefined();
    expect(res.cookies.get("gk_ref_link")).toBeUndefined();
    expect((await events())[0]).toMatchObject({ code: second.code, outcome: "KEPT_FIRST" });

    // …but an earlier code that no longer works does not block the new one.
    const shut = await createReferralCode({ code: "GONECODE" }, admin);
    await db.update(referralCodes).set({ status: "INACTIVE" }).where(eq(referralCodes.id, shut.id));
    const res2 = await open(second.code, { cookie: "gk_ref_link=GONECODE" });
    expect(res2.cookies.get("gk_ref_link")?.value).toBe(second.code);

    // Shop links: the first dealer's code stays on Add my shop.
    const d = await dealerWithCodes();
    const res3 = await open(d.agent.code, { cookie: `gk_ref_link=${d.main}` });
    expect(res3.headers.get("location")).toBe(`/shop/register?ref=${encodeURIComponent(d.main)}`);
  });

  it("one referrer per account stays enforced by the existing apply step", async () => {
    const a = await customerWithCode("Alpha");
    const b = await customerWithCode("Beta");
    const friend = await createUser({ name: "New Friend" });
    const { applyReferralCode } = await import("@/server/services/customer-referrals");
    await applyReferralCode(friend.id, a.code);
    await expect(applyReferralCode(friend.id, b.code)).rejects.toThrow(/already used a referral code/);
    await expect(applyReferralCode(a.user.id, a.code)).rejects.toThrow(/your own referral code/);
    expect(await db.select().from(customerReferrals)).toHaveLength(1);
  });
});

describe("share log", () => {
  it("logs a share for the code's owner only, and a dealer for his employees' codes", async () => {
    const { user, code } = await customerWithCode();
    const stranger = await createUser();
    expect(await logShare(user.id, code, "whatsapp")).toBe(true);
    expect(await logShare(stranger.id, code, "sms")).toBe(false);
    const d = await dealerWithCodes();
    expect(await logShare(d.user.id, d.agent.code, "email")).toBe(true);
    expect(await logShare(d.agent.user.id, d.agent.code, "native")).toBe(true);
    expect(await logShare(d.agent.user.id, d.main, "copy")).toBe(false);
    const shares = (await events()).filter((e) => e.event === "SHARE");
    expect(shares.map((e) => e.channel).sort()).toEqual(["email", "native", "whatsapp"]);
  });

  it("POST /api/referral-links/share needs a signed-in user and a known channel", async () => {
    const { user, code } = await customerWithCode();
    const post = (body: unknown) => sharePost(new NextRequest("https://test.gokesari.com/api/referral-links/share", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    expect((await post({ code, channel: "whatsapp" })).status).toBe(401);
    signIn(user);
    const ok = await post({ code, channel: "sms" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).logged).toBe(true);
    expect((await post({ code, channel: "fax" })).status).toBe(422);
  });
});

describe("deferred link after an app install", () => {
  it("the app's first open picks up the browser click from the same network, once", async () => {
    const d = await dealerWithCodes();
    await open(d.lead.code, { channel: "wa", ip: "198.51.100.20" });
    const first = (ip: string, ua = APP_UA, cookie?: string) =>
      appOpen(new NextRequest("https://test.gokesari.com/app-open", { headers: { "x-forwarded-for": ip, "user-agent": ua, ...(cookie ? { cookie } : {}) } }));

    // A browser, or another network: home, nothing set.
    expect((await first("198.51.100.20", BROWSER_UA)).headers.get("location")).toBe("/");
    expect((await first("192.0.2.1")).headers.get("location")).toBe("/");

    const res = await first("198.51.100.20");
    expect(res.headers.get("location")).toBe(`/shop/register?ref=${encodeURIComponent(d.lead.code)}`);
    expect(res.cookies.get("gk_ref_link")?.value).toBe(d.lead.code);
    const claimId = res.cookies.get("gk_ref_claim")?.value;
    expect(claimId).toBeTruthy();
    expect((await events()).filter((e) => e.event === "APP_OPEN")).toHaveLength(1);

    // Signed in later: claimed once for the new account; the click is not offered again.
    const owner = await createUser({ name: "New Shop Owner" });
    const match = await findDeferredReferral("198.51.100.20", owner.id);
    expect(match?.target.code).toBe(d.lead.code);
    await claimDeferredReferral(claimId!, owner.id, match!.target, "198.51.100.20", true);
    await claimDeferredReferral(claimId!, owner.id, match!.target, "198.51.100.20", true);
    expect((await events()).filter((e) => e.event === "CLAIM")).toHaveLength(1);
    expect(await findDeferredReferral("198.51.100.20", owner.id)).toBeNull();
  });

  it("never offers an account its own code, and not after the match window", async () => {
    const { user, code } = await customerWithCode();
    await open(code, { ip: "198.51.100.30" });
    expect(await findDeferredReferral("198.51.100.30", user.id)).toBeNull();
    await db.update(referralLinkEvents).set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(referralLinkEvents.code, code));
    expect(await findDeferredReferral("198.51.100.30", null)).toBeNull();
  });
});

describe("My referrals and the admin report", () => {
  it("counts shares, opens and sign-ups from the existing tables", async () => {
    const { user, code } = await customerWithCode();
    await logShare(user.id, code, "whatsapp");
    await logShare(user.id, code, "whatsapp");
    await logShare(user.id, code, "sms");
    await open(code);
    await open(code);
    const friend = await createUser({ name: "Friend" });
    const { applyReferralCode } = await import("@/server/services/customer-referrals");
    await applyReferralCode(friend.id, code);
    const [mine] = await myReferralStats(user.id);
    expect(mine).toMatchObject({ code, kind: "CUSTOMER", shares: 3, clicks: 2, signups: 1, pending: 1, earnedPaise: 0 });
    expect(mine.sharesByChannel).toEqual({ whatsapp: 2, sms: 1 });

    const d = await dealerWithCodes();
    const shopOwner = await createUser({ role: "SHOP_OWNER" });
    const shop = await createShop(shopOwner.id);
    const [rc] = await db.select().from(referralCodes).where(eq(referralCodes.code, d.agent.code));
    await db.insert(referralRedemptions).values({ referralCodeId: rc.id, shopId: shop.id });
    const agentStats = await myReferralStats(d.agent.user.id);
    expect(agentStats).toHaveLength(1);
    expect(agentStats[0]).toMatchObject({ code: d.agent.code, level: "Agent", signups: 1 });
    expect((await myReferralStats(d.user.id)).map((s) => s.code)).toEqual([d.main]);
  });

  it("filters by referrer, role, channel and IST date", async () => {
    const { user, code } = await customerWithCode("Report Person");
    await logShare(user.id, code, "whatsapp");
    await open(code, { channel: "wa" });
    const d = await dealerWithCodes();
    await logShare(d.user.id, d.main, "email");

    expect((await referralReport({})).rows).toHaveLength(2);
    expect((await referralReport({ kind: "DEALER" })).rows.map((r) => r.code)).toEqual([d.main]);
    expect((await referralReport({ channel: "whatsapp" })).rows[0]).toMatchObject({ code, shares: 1, clicks: 1 });
    expect((await referralReport({ referrer: "report person" })).rows.map((r) => r.code)).toEqual([code]);
    expect((await referralReport({ referrer: d.main.slice(0, 6) })).rows.map((r) => r.code)).toEqual([d.main]);
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    expect((await referralReport({ from: today, to: today })).rows).toHaveLength(2);
    expect((await referralReport({ from: "2026-01-01", to: "2026-01-02" })).rows).toHaveLength(0);
  });
});

describe("rule referralSharing off", () => {
  it("keeps the original /r/ behaviour and logs nothing", async () => {
    await setRule("referralSharing", { enabled: false, deferredMatchHours: 24 }, admin);
    clearRuleCache();
    const { code } = await customerWithCode();
    const res = await open(code, { channel: "wa" });
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.cookies.get("gk_ref")?.value).toBe(code);
    expect(res.cookies.get("gk_ref_link")).toBeUndefined();
    expect(await events()).toHaveLength(0);
    expect(await logShare((await db.select().from(users).where(eq(users.name, "Asha Patil")))[0].id, code, "sms")).toBe(true); // the service itself still works…
    const { user } = await customerWithCode("Other");
    signIn(user);
    const res2 = await sharePost(new NextRequest("https://test.gokesari.com/api/referral-links/share", { method: "POST", body: JSON.stringify({ code, channel: "sms" }), headers: { "content-type": "application/json" } }));
    expect((await res2.json()).logged).toBe(false); // …but the API ignores shares while the rule is off
  });
});

describe("registration code check after gap fix G-4", () => {
  it("an ordinary open code still passes, and a closed one keeps its message with the hint", async () => {
    const { assertRegistrationReferralCode } = await import("@/server/services/referral-requests");
    await createReferralCode({ code: "OPENCODE" }, admin);
    await expect(assertRegistrationReferralCode("OPENCODE")).resolves.toBe("OPENCODE");
    const shut = await createReferralCode({ code: "SHUTTWO1" }, admin);
    await db.update(referralCodes).set({ status: "INACTIVE" }).where(eq(referralCodes.id, shut.id));
    await expect(assertRegistrationReferralCode("SHUTTWO1")).rejects.toThrow(/inactive\. Check the code/);
  });
});
