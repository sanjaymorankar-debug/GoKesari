/**
 * Mandatory referral code on shop registration, and "Request a referral code"
 * (docs/four-features-2026-10, feature 4): valid / invalid / missing code,
 * operators unaffected, the request with and without location, the email to
 * the referrals team, duplicate requests from one mobile, and the operations
 * screen (issue a code / reject) with its permission checks.
 */
import { generatedReferralCodePattern } from "@/lib/referral-codes";
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: null; role: UserRole; status: "ACTIVE" };
  },
  outbox: [] as { to: string; subject: string; text: string; html?: string }[],
  failEmail: false,
}));

vi.mock("@/server/email/transport", () => ({
  emailMode: () => "smtp",
  sendEmail: async (message: { to: string; subject: string; text: string; html?: string }) => {
    if (state.failEmail) throw new Error("SMTP connection refused");
    state.outbox.push(message);
  },
  EmailUnavailableError: class extends Error {},
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as registerRoute } from "@/app/api/shops/route";
import { GET as checkRoute } from "@/app/api/referral-codes/check/route";
import { POST as createCodeRoute } from "@/app/api/referral-codes/route";
import { PATCH as patchCodeRoute } from "@/app/api/referral-codes/[id]/route";
import { POST as requestRoute } from "@/app/api/referral-requests/route";
import { GET as adminListRoute } from "@/app/api/admin/referral-requests/route";
import { POST as adminActionRoute } from "@/app/api/admin/referral-requests/[id]/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { notifications, platformSettings, referralCodeRequests, referralCodes, referralRedemptions, shopCategories, shops } from "@/server/db/schema";
import { createReferralCode, listReferralCodes, updateReferralCode } from "@/server/services/referrals";
import { setReferralSetting } from "@/server/services/referral-settings";
import { clearRuleCache } from "@/server/services/settings";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };
let categoryIds: string[] = [];
let shopActCounter = 0;

beforeAll(async () => {
  const rows = await db.select({ id: shopCategories.id }).from(shopCategories).limit(1);
  categoryIds = rows.map((r) => r.id);
});

beforeEach(async () => {
  await resetDatabase();
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["shopReferral"]));
  clearRuleCache();
  resetRateLimits();
  state.session = null;
  state.outbox = [];
  state.failEmail = false;
  const a = await createUser({ role: "ADMIN" });
  admin = { id: a.id, role: "ADMIN" };
});

// docs/nearby-referral-2026-10: the admin's setting referral_required_shop replaced rule shopReferral.required.
const requireCodes = () => setReferralSetting("referral_required_shop", "MANDATORY", admin);

function signIn(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

function shopBody(extra: Record<string, unknown> = {}) {
  shopActCounter += 1;
  return {
    name: `Shree Dairy ${shopActCounter}`,
    ownerName: "Ramesh Patil",
    phone: "9876543210",
    addressLine1: "12 FC Road",
    city: "Pune",
    pincode: "411004",
    shopType: "DAIRY",
    annualTurnoverRupees: 1_500_000,
    categoryIds,
    shopActNumber: `PII/KOTHRUD/II/${10000 + shopActCounter}`,
    ...extra,
  };
}

const register = (body: Record<string, unknown>) => call(registerRoute, "/api/shops", { method: "POST", body });

/* ----------------------------------------------------------- registration */

describe("referral code on shop registration", () => {
  it("rule off (default): no code needed, exactly as before", async () => {
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    const res = await register(shopBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("missing or invalid code blocks the registration with a clear message; a valid one is attributed", async () => {
    await requireCodes();
    await createReferralCode({ code: "PUNEPRT1" }, admin);
    const owner = await createUser();
    signIn(owner, "CUSTOMER");

    const missing = await register(shopBody());
    expect(missing.status).toBe(422);
    expect(missing.body.error.details.fields.referralCode).toContain("required");
    const unknown = await register(shopBody({ referralCode: "NOPE123" }));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details.fields.referralCode).toContain("does not exist");
    expect(await db.select().from(shops)).toHaveLength(0); // nothing was saved

    const ok = await register(shopBody({ referralCode: "puneprt1" }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const [shop] = await db.select().from(shops).where(eq(shops.id, ok.body.id));
    expect(shop.referralCodeId).not.toBeNull();
    expect(await db.select().from(referralRedemptions).where(eq(referralRedemptions.shopId, shop.id))).toHaveLength(1);
  });

  it("Admin → Referral codes counts the shops attributed to each code (it used to show 0 for every code)", async () => {
    await requireCodes();
    await createReferralCode({ code: "TWOSHOPS" }, admin);
    await createReferralCode({ code: "NOSHOPS" }, admin);
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    expect((await register(shopBody({ referralCode: "twoshops" }))).status).toBe(201);
    signIn(await createUser(), "CUSTOMER"); // one registration under review per owner
    expect((await register(shopBody({ referralCode: "TWOSHOPS" }))).status).toBe(201);
    const counts = Object.fromEntries((await listReferralCodes()).map((c) => [c.code, c.shopCount]));
    expect(counts).toMatchObject({ "TWOSHOPS": 2, "NOSHOPS": 0 });
  });

  it("an inactive or expired code is refused", async () => {
    await requireCodes();
    const inactive = await createReferralCode({ code: "OLDCODE1" }, admin);
    await updateReferralCode(inactive.id, { status: "INACTIVE" }, admin);
    await createReferralCode({ code: "EXPIRED1", expiresAt: "2020-01-01" }, admin);
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    expect((await register(shopBody({ referralCode: "OLDCODE1" }))).body.error.details.fields.referralCode).toContain("inactive");
    expect((await register(shopBody({ referralCode: "EXPIRED1" }))).body.error.details.fields.referralCode).toContain("expired");
  });

  it("an operator registering a shop for someone does not need a code", async () => {
    await requireCodes();
    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const res = await register(shopBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("the form's check answers valid / not valid, signed in only", async () => {
    await createReferralCode({ code: "GOODCODE" }, admin);
    expect((await call(checkRoute, "/api/referral-codes/check?code=GOODCODE")).status).toBe(401);
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    expect((await call(checkRoute, "/api/referral-codes/check?code=goodcode")).body).toEqual({ valid: true, message: null });
    expect((await call(checkRoute, "/api/referral-codes/check?code=BADCODE")).body.valid).toBe(false);
  });
});

/* ------------------------------------------- admin: format, disable, expiry */

describe("referral codes on the admin page (30 Oct 2026)", () => {
  const create = (body: Record<string, unknown>) => call(createCodeRoute, "/api/referral-codes", { method: "POST", body });
  const patch = (id: string, body: Record<string, unknown>) =>
    call(patchCodeRoute, `/api/referral-codes/${id}`, { method: "PATCH", body, params: { id } });
  const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

  beforeEach(async () => {
    const a = await createUser({ role: "ADMIN" });
    signIn(a, "ADMIN");
  });

  it("no code typed: a unique 8-character code of letters and digits is generated", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const res = await create({ label: `Drive ${i}` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.code).toMatch(generatedReferralCodePattern());
      seen.add(res.body.code);
    }
    expect(seen.size).toBe(10);
  });

  it("a typed code is 4–8 letters and digits, and unique", async () => {
    expect((await create({ code: "partner9" })).body.code).toBe("PARTNER9");
    expect((await create({ code: "PARTNER10" })).status).toBe(422);
    expect((await create({ code: "PUNE-01" })).status).toBe(422);
    expect((await create({ code: "AB1" })).status).toBe(422);
    expect((await create({ code: "PARTNER9" })).status).toBe(409);
  });

  it("disable and enable a code; a disabled code is refused at registration", async () => {
    const { body: code } = await create({ code: "DRIVE01" });
    expect((await patch(code.id, { status: "INACTIVE" })).body.status).toBe("INACTIVE");
    await requireCodes();
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    expect((await register(shopBody({ referralCode: "DRIVE01" }))).body.error.details.fields.referralCode).toContain("inactive");
    signIn(await createUser({ role: "ADMIN" }), "ADMIN");
    expect((await patch(code.id, { status: "ACTIVE" })).body.status).toBe("ACTIVE");
  });

  it("set, extend and remove the expiry; a past date is refused; a lapsed code works again once extended", async () => {
    const { body: code } = await create({ code: "DRIVE02", expiresAt: isoDay(5) });
    expect((await patch(code.id, { expiresAt: isoDay(-1) })).status).toBe(422);
    expect((await create({ code: "DRIVE03", expiresAt: isoDay(-1) })).status).toBe(422);
    expect((await patch(code.id, { expiresAt: isoDay(60) })).body.expiresAt).toBe(isoDay(60));
    expect((await patch(code.id, { expiresAt: null })).body.expiresAt).toBeNull();

    const lapsed = await createReferralCode({ code: "LAPSED1", expiresAt: "2020-01-01" }, admin);
    await db.update(referralCodes).set({ status: "EXPIRED" }).where(eq(referralCodes.id, lapsed.id));
    expect((await patch(lapsed.id, { expiresAt: isoDay(30) })).body).toMatchObject({ status: "ACTIVE", expiresAt: isoDay(30) });
    expect((await call(checkRoute, "/api/referral-codes/check?code=LAPSED1")).body.valid).toBe(true);
  });
});

/* -------------------------------------------------------------- requests */

const REQUEST = { name: "Sunita Jadhav", mobile: "9822012345", shopType: "PHARMACY", area: "Kothrud", city: "Pune", pincode: "411038" };

describe("request a referral code", () => {
  it("with location: saved with coordinates and a Maps link, emailed to referrals@gokesari.com, support told", async () => {
    const owner = await createUser();
    signIn(owner, "CUSTOMER");
    const res = await call(requestRoute, "/api/referral-requests", {
      method: "POST",
      body: { ...REQUEST, latitude: 18.5074123, longitude: 73.8077456, accuracyM: 25.4 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ locationShared: true, mobileMasked: "+91 ******2345" });
    expect(res.body.reference).toMatch(/^RCR-[0-9A-F]{8}$/);

    const [row] = await db.select().from(referralCodeRequests);
    expect(row).toMatchObject({
      userId: owner.id,
      mobileE164: "+919822012345",
      locationStatus: "SHARED",
      latitude: "18.507412",
      longitude: "73.807746",
      locationAccuracyM: 25,
      mapsUrl: "https://www.google.com/maps?q=18.507412,73.807746",
      status: "NEW",
      emailStatus: "SENT",
    });
    const [mail] = state.outbox;
    expect(mail.to).toBe("referrals@gokesari.com");
    for (const part of ["Sunita Jadhav", "+919822012345", "Pharmacy / Medical Store", "Kothrud", "Pune", "411038", "18.507412, 73.807746", "https://www.google.com/maps?q=18.507412,73.807746", "IST"]) {
      expect(mail.text).toContain(part);
    }
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, admin.id), eq(notifications.type, "support.referral_request")))).toHaveLength(1);
  });

  it("without location (permission denied): still accepted, marked not shared; works signed out", async () => {
    const res = await call(requestRoute, "/api/referral-requests", { method: "POST", body: REQUEST });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.locationShared).toBe(false);
    const [row] = await db.select().from(referralCodeRequests);
    expect(row).toMatchObject({ userId: null, locationStatus: "NOT_SHARED", latitude: null, mapsUrl: null });
    expect(state.outbox[0].text).toContain("Coordinates: Not shared");
  });

  it("validates the PIN code (6 digits), the mobile number and the shop type", async () => {
    const short = await call(requestRoute, "/api/referral-requests", { method: "POST", body: { ...REQUEST, pincode: "41103" } });
    expect(short.status).toBe(422);
    expect(short.body.error.details.fields.pincode).toBeDefined();
    resetRateLimits();
    expect((await call(requestRoute, "/api/referral-requests", { method: "POST", body: { ...REQUEST, mobile: "12345" } })).status).toBe(422);
    resetRateLimits();
    expect((await call(requestRoute, "/api/referral-requests", { method: "POST", body: { ...REQUEST, shopType: "SPACESHIP" } })).status).toBe(422);
    expect(await db.select().from(referralCodeRequests)).toHaveLength(0);
  });

  it("a second request from the same mobile is refused with the first one's reference", async () => {
    const first = await call(requestRoute, "/api/referral-requests", { method: "POST", body: REQUEST });
    expect(first.status).toBe(201);
    resetRateLimits();
    const again = await call(requestRoute, "/api/referral-requests", { method: "POST", body: { ...REQUEST, name: "Sunita J" } });
    expect(again.status).toBe(429);
    expect(again.body.error.details.reference).toBe(first.body.reference);
    resetRateLimits();
    expect((await call(requestRoute, "/api/referral-requests", { method: "POST", body: { ...REQUEST, mobile: "9822012346" } })).status).toBe(201);
  });

  it("an email failure is recorded and can be retried from the operations screen", async () => {
    state.failEmail = true;
    const res = await call(requestRoute, "/api/referral-requests", { method: "POST", body: REQUEST });
    expect(res.status).toBe(201); // the request is saved regardless
    const [row] = await db.select().from(referralCodeRequests);
    expect(row.emailStatus).toBe("FAILED");
    expect(row.emailError).toContain("SMTP connection refused");

    state.failEmail = false;
    signIn({ id: admin.id, email: "admin@test.local", name: "Admin" }, "ADMIN");
    const resent = await call(adminActionRoute, `/api/admin/referral-requests/${row.id}`, { method: "POST", body: { action: "resend_email" }, params: { id: row.id } });
    expect(resent.status).toBe(200);
    expect(resent.body.emailStatus).toBe("SENT");
    expect(state.outbox).toHaveLength(1);
  });
});

/* ------------------------------------------------------------ operations */

describe("operations screen", () => {
  it("lists requests by status; issues a working code; rejects with a reason; only once; staff only", async () => {
    await requireCodes();
    const requester = await createUser();
    signIn(requester, "CUSTOMER");
    await call(requestRoute, "/api/referral-requests", { method: "POST", body: REQUEST });
    resetRateLimits();
    await call(requestRoute, "/api/referral-requests", { method: "POST", body: { ...REQUEST, mobile: "9822099999", name: "Other Owner" } });
    const [first, second] = await db.select().from(referralCodeRequests).orderBy(referralCodeRequests.createdAt);

    // A customer cannot see or act on requests.
    expect((await call(adminListRoute, "/api/admin/referral-requests")).status).toBe(403);
    expect((await call(adminActionRoute, `/api/admin/referral-requests/${first.id}`, { method: "POST", body: { action: "issue" }, params: { id: first.id } })).status).toBe(403);

    const operator = await createUser({ role: "OPERATOR" });
    signIn(operator, "OPERATOR");
    const list = await call(adminListRoute, "/api/admin/referral-requests?status=NEW");
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(2);

    const issued = await call(adminActionRoute, `/api/admin/referral-requests/${first.id}`, { method: "POST", body: { action: "issue" }, params: { id: first.id } });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body).toMatchObject({ status: "CODE_ISSUED" });
    expect(issued.body.issuedCode).toMatch(generatedReferralCodePattern());
    // The requester is told (in the app, and by email).
    const [told] = await db.select().from(notifications).where(and(eq(notifications.userId, requester.id), eq(notifications.type, "shop.referral_request_decided")));
    expect(told.body).toContain(issued.body.issuedCode);
    // Answering twice is refused.
    expect((await call(adminActionRoute, `/api/admin/referral-requests/${first.id}`, { method: "POST", body: { action: "reject", reason: "dup" }, params: { id: first.id } })).status).toBe(409);

    const noReason = await call(adminActionRoute, `/api/admin/referral-requests/${second.id}`, { method: "POST", body: { action: "reject", reason: "" }, params: { id: second.id } });
    expect(noReason.status).toBe(422);
    const rejected = await call(adminActionRoute, `/api/admin/referral-requests/${second.id}`, {
      method: "POST",
      body: { action: "reject", reason: "Outside our service area" },
      params: { id: second.id },
    });
    expect(rejected.body).toMatchObject({ status: "REJECTED", decisionNote: "Outside our service area" });
    expect((await call(adminListRoute, "/api/admin/referral-requests?status=CODE_ISSUED")).body.requests).toHaveLength(1);

    // The issued code registers a shop.
    signIn(requester, "CUSTOMER");
    const res = await register(shopBody({ referralCode: issued.body.issuedCode }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});
