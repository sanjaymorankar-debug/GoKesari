/**
 * Rider Aadhaar by DigiLocker (docs/gig-worker-2026-10, "KYC provider";
 * Sandbox.co.in replaced the OTP check with its DigiLocker API). End to end on
 * the mock DigiLocker: consent → session → webhook (signed) or return link or
 * polling → Verified / Pending / Failed; declined, expired, name mismatch,
 * vendor down, duplicate webhook, the same DigiLocker account on two
 * partners, the admin's resend link — and the Aadhaar number, photo, XML,
 * date of birth and address are never stored.
 */
import { createHmac } from "node:crypto";

import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
  webhookSecret: "whsec_test_digilocker_0123456789" as string | undefined,
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, getEnv: () => ({ ...actual.getEnv(), SANDBOX_CO_WEBHOOK_SECRET: state.webhookSecret }) };
});

import { POST as resendRoute } from "@/app/api/admin/rider-kyc-checks/[id]/resend-digilocker/route";
import { POST as startRoute } from "@/app/api/delivery-partner/me/kyc/aadhaar/digilocker/route";
import { POST as otpRoute } from "@/app/api/delivery-partner/me/kyc/aadhaar/otp/route";
import { POST as mockDecideRoute } from "@/app/api/kyc-mock/digilocker/route";
import { POST as webhookRoute } from "@/app/api/webhooks/sandbox-co/digilocker/route";
import { GET as returnRoute } from "@/app/mobile-auth/digilocker-return/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { auditLogs, deliveryPartnerKycChecks, deliveryPartners, notifications } from "@/server/db/schema";
import { setDigilockerAdapterForTests } from "@/server/kyc";
import { clearMockDigilocker, decideMockDigilocker, MOCK_DIGILOCKER_LAST4, type MockDigilockerDecision } from "@/server/kyc/adapters/mock";
import { KycConfigError, KycUnavailableError } from "@/server/kyc/types";
import { approveDeliveryPartner, registerDeliveryPartner } from "@/server/services/delivery-partners";
import {
  decideRiderKycCheck,
  getMyRiderKyc,
  isRiderKycComplete,
  listRiderKycChecksForAdmin,
  resendDigilockerLink,
  startMyAadhaarDigilocker,
  syncMyAadhaarDigilocker,
} from "@/server/services/rider-kyc";
import { clearRuleCache, setRule } from "@/server/services/settings";
import { call } from "../helpers/http";
import { addRiderIdentityDocument, createUser, FULL_RIDER_REGISTRATION, resetDatabase } from "../helpers/fixtures";

const base = { fullName: "Ravi Kumar", mobile: "9876543210", vehicleType: "MOTORCYCLE" as const };

function signInAs(user: { id: string; email: string; name: string | null }, role: UserRole) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role, status: "ACTIVE" } };
}

async function approvedRider(mobile = "9876543210") {
  const user = await createUser({ role: "DELIVERY_PARTNER" });
  const admin = await createUser({ role: "ADMIN" });
  const partner = await registerDeliveryPartner(user.id, { ...base, mobile, ...FULL_RIDER_REGISTRATION });
  await addRiderIdentityDocument(partner.id);
  await approveDeliveryPartner(partner.id, { id: admin.id, role: "ADMIN" });
  return { user, admin, partner, adminActor: { id: admin.id, role: "ADMIN" as const } };
}

const sessionOf = (url: string) => new URL(url).searchParams.get("session")!;

async function rowFor(partnerId: string) {
  const [row] = await db.select().from(deliveryPartnerKycChecks).where(eq(deliveryPartnerKycChecks.deliveryPartnerId, partnerId));
  return row;
}

/** Sandbox's webhook: `x-sandbox-signature` = base64 HMAC-SHA256 of the JSON payload. */
async function webhook(sessionId: string, status: "succeeded" | "failed", signWith: string | null = state.webhookSecret ?? null) {
  const payload = {
    data: { id: sessionId, created_at: Date.now() - 60_000, updated_at: Date.now(), "@entity": "in.co.sandbox.kyc.digilocker.session", status, ...(status === "succeeded" ? { documents_consented: ["aadhaar"] } : {}) },
  };
  const raw = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signWith) headers["x-sandbox-signature"] = createHmac("sha256", signWith).update(raw).digest("base64");
  const response = await webhookRoute(new NextRequest("http://localhost/api/webhooks/sandbox-co/digilocker", { method: "POST", body: raw, headers }));
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function start(userId: string) {
  const started = await startMyAadhaarDigilocker(userId, { consentGiven: true, ipAddress: "203.0.113.7" });
  expect(started.url).toBeTruthy();
  return { ...started, session: sessionOf(started.url!) };
}

async function startAndDecide(userId: string, decision: MockDigilockerDecision, holder?: string) {
  const s = await start(userId);
  decideMockDigilocker(s.session, decision, holder);
  return s;
}

beforeEach(async () => {
  state.session = null;
  state.webhookSecret = "whsec_test_digilocker_0123456789";
  resetRateLimits();
  clearMockDigilocker();
  setDigilockerAdapterForTests(null);
  await resetDatabase();
  clearRuleCache();
});

afterEach(() => setDigilockerAdapterForTests(null));

describe("Aadhaar by DigiLocker — the happy path", () => {
  it("consent → session → signed webhook → Verified; only the name, last four digits and a keyed token are kept", async () => {
    const { user, partner } = await approvedRider();
    signInAs(user, "DELIVERY_PARTNER");

    // Nothing without consent.
    expect((await call(startRoute, "/api/delivery-partner/me/kyc/aadhaar/digilocker", { method: "POST", body: { consent: false } })).status).toBe(422);

    const res = await call(startRoute, "/api/delivery-partner/me/kyc/aadhaar/digilocker", { method: "POST", body: { consent: true } });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/mobile-auth\/digilocker-mock\?session=mock-dl-/);
    expect(res.body.check).toMatchObject({ docType: "AADHAAR", status: "PENDING", method: "digilocker", digilockerOpen: true, numberMasked: "XXXX XXXX XXXX", errorCode: "digilocker_started" });
    const pending = await rowFor(partner.id);
    expect(pending).toMatchObject({ method: "digilocker", sessionStatus: "created", consentIp: null });
    expect(pending.sessionReturnKey).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(pending.consentVersion).toBe("2026-10-31-digilocker");

    // The rider approves on (mock) DigiLocker; Sandbox's webhook arrives.
    const session = sessionOf(res.body.url);
    decideMockDigilocker(session, "approve");
    expect(await webhook(session, "succeeded")).toEqual({ status: 200, body: { ok: true, result: "settled" } });

    const row = await rowFor(partner.id);
    expect(row).toMatchObject({ status: "VERIFIED", method: "digilocker", sessionStatus: "succeeded", sessionUrl: null, numberMasked: `XXXX XXXX ${MOCK_DIGILOCKER_LAST4}`, numberEncrypted: null });
    expect(row.numberToken).toMatch(/^[0-9a-f]{64}$/);
    expect(row.verifiedAt).toBeInstanceOf(Date);
    expect((await getMyRiderKyc(user.id)).aadhaar).toMatchObject({ status: "VERIFIED", method: "digilocker" });

    // The partner was told (they may have closed the page), and the audit says how.
    const notes = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notes.map((n) => n.title)).toContain("Your Aadhaar is verified");
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, partner.id));
    expect(audits.map((a) => (a.newValue as { step?: string } | null)?.step)).toEqual(expect.arrayContaining(["aadhaar_digilocker_start", "aadhaar_digilocker_webhook"]));
  });

  it("the return link settles the check too, then a duplicate webhook changes nothing", async () => {
    const { user, partner } = await approvedRider();
    const s = await startAndDecide(user.id, "approve");
    const key = (await rowFor(partner.id)).sessionReturnKey!;

    const back = await returnRoute(new NextRequest(`http://localhost/mobile-auth/digilocker-return?k=${key}`));
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("http://localhost/delivery-partner/kyc?digilocker=verified");
    const settled = await rowFor(partner.id);
    expect(settled.status).toBe("VERIFIED");

    expect(await webhook(s.session, "succeeded")).toEqual({ status: 200, body: { ok: true, result: "settled" } });
    expect(await webhook(s.session, "succeeded")).toEqual({ status: 200, body: { ok: true, result: "settled" } });
    const after = await rowFor(partner.id);
    expect(after.updatedAt).toEqual(settled.updatedAt);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entityId, partner.id));
    expect(audits.filter((a) => /digilocker_(return|webhook)/.test((a.newValue as { step?: string } | null)?.step ?? ""))).toHaveLength(1);

    // An unknown key reveals nothing and goes to the KYC page.
    const unknown = await returnRoute(new NextRequest("http://localhost/mobile-auth/digilocker-return?k=nope"));
    expect(unknown.headers.get("location")).toBe("http://localhost/delivery-partner/kyc?digilocker=unknown");
  });

  it("from the app: the return link hands back to the app build's scheme", async () => {
    const { user, partner } = await approvedRider();
    const s = await startMyAadhaarDigilocker(user.id, { consentGiven: true, app: "gokesari-preview" });
    decideMockDigilocker(sessionOf(s.url!), "deny");
    const key = (await rowFor(partner.id)).sessionReturnKey!;
    expect(key).toMatch(/\.gokesari-preview$/);
    const back = await returnRoute(new NextRequest(`http://localhost/mobile-auth/digilocker-return?k=${encodeURIComponent(key)}`));
    expect(back.headers.get("location")).toBe("gokesari-preview://digilocker-return?result=failed");
    // A scheme that is not one of ours is ignored (browser return).
    const other = await approvedRider("9876543211");
    await startMyAadhaarDigilocker(other.user.id, { consentGiven: true, app: "evil" });
    expect((await rowFor(other.partner.id)).sessionReturnKey).not.toContain(".");
  });

  it("a second tap hands out the same open link instead of a new session", async () => {
    const { user } = await approvedRider();
    const first = await start(user.id);
    const again = await startMyAadhaarDigilocker(user.id, { consentGiven: true });
    expect(again.url).toBe(first.url);
  });
});

describe("Aadhaar by DigiLocker — when it doesn't verify", () => {
  it("declined consent → Failed, with a way to start again", async () => {
    const { user, partner } = await approvedRider();
    const s = await startAndDecide(user.id, "deny");
    expect(await webhook(s.session, "failed")).toMatchObject({ status: 200 });
    expect(await rowFor(partner.id)).toMatchObject({ status: "FAILED", errorCode: "digilocker_denied", sessionStatus: "failed" });
    const view = (await getMyRiderKyc(user.id)).aadhaar!;
    expect(view.reason).toMatch(/did not share/);
    const retry = await start(user.id);
    expect(retry.check).toMatchObject({ status: "PENDING", errorCode: "digilocker_started" });
  });

  it("expired at DigiLocker, or our link ran out unused → Failed (expired)", async () => {
    const { user, partner } = await approvedRider();
    await startAndDecide(user.id, "expire");
    expect(await syncMyAadhaarDigilocker(user.id)).toMatchObject({ status: "FAILED", errorCode: "digilocker_expired" });

    await start(user.id);
    await db.update(deliveryPartnerKycChecks).set({ sessionExpiresAt: new Date(Date.now() - 1000) }).where(eq(deliveryPartnerKycChecks.deliveryPartnerId, partner.id));
    expect(await syncMyAadhaarDigilocker(user.id)).toMatchObject({ status: "FAILED", errorCode: "digilocker_expired" });
  });

  it("name on the Aadhaar doesn't match → Pending for an admin (manual review), who decides by hand", async () => {
    const { user, partner, adminActor } = await approvedRider();
    await startAndDecide(user.id, "mismatch");
    const check = await syncMyAadhaarDigilocker(user.id);
    expect(check).toMatchObject({ status: "PENDING", errorCode: "name_mismatch", numberMasked: `XXXX XXXX ${MOCK_DIGILOCKER_LAST4}` });
    const [admin] = (await listRiderKycChecksForAdmin(adminActor)).filter((c) => c.docType === "AADHAAR");
    expect(admin).toMatchObject({ method: "digilocker", sessionStatus: "succeeded", nameOnRecord: "SOMEONE ELSE ENTIRELY", adminReason: expect.stringMatching(/name/i) });
    expect(admin.nameMatchScore).toBeLessThan(80);
    await decideRiderKycCheck(check!.id, "VERIFIED", "Name matches the Aadhaar card shown in person", adminActor);
    expect(await rowFor(partner.id)).toMatchObject({ status: "VERIFIED", method: "manual" });
  });

  it("vendor down at start or while checking → stays Pending with an error code, never Failed", async () => {
    const { user, partner } = await approvedRider();
    setDigilockerAdapterForTests({
      startSession: async () => {
        throw new KycUnavailableError("timeout", "slow");
      },
      sessionStatus: async () => null,
      fetchAadhaar: async () => ({ kind: "session_unusable", providerRef: null }),
    });
    const down = await startMyAadhaarDigilocker(user.id, { consentGiven: true });
    expect(down).toMatchObject({ url: null, check: { status: "PENDING", errorCode: "vendor_timeout" } });

    setDigilockerAdapterForTests({
      startSession: async () => {
        throw new KycConfigError("auth_failed", "bad key");
      },
      sessionStatus: async () => null,
      fetchAadhaar: async () => ({ kind: "session_unusable", providerRef: null }),
    });
    expect((await startMyAadhaarDigilocker(user.id, { consentGiven: true })).check).toMatchObject({ status: "PENDING", errorCode: "config_auth_failed" });

    setDigilockerAdapterForTests(null);
    await startAndDecide(user.id, "down");
    expect(await syncMyAadhaarDigilocker(user.id)).toMatchObject({ status: "PENDING", errorCode: "vendor_source_down" });
    expect((await rowFor(partner.id)).sessionStatus).toBe("created");
  });

  it("the same DigiLocker account on another partner → Failed (already used)", async () => {
    const first = await approvedRider("9876543210");
    await startAndDecide(first.user.id, "approve", "holder-same-person");
    expect((await syncMyAadhaarDigilocker(first.user.id))?.status).toBe("VERIFIED");

    const second = await approvedRider("9876543211");
    await startAndDecide(second.user.id, "approve", "holder-same-person");
    expect(await syncMyAadhaarDigilocker(second.user.id)).toMatchObject({ status: "FAILED", errorCode: "already_used" });
  });
});

describe("Aadhaar by DigiLocker — webhook, settings, admin", () => {
  it("the webhook refuses unsigned and wrongly signed payloads, and everything when no secret is set", async () => {
    const { user, partner } = await approvedRider();
    const s = await startAndDecide(user.id, "approve");
    expect((await webhook(s.session, "succeeded", null)).status).toBe(401);
    expect((await webhook(s.session, "succeeded", "some_other_secret_123456")).status).toBe(401);
    state.webhookSecret = undefined;
    expect((await webhook(s.session, "succeeded")).status).toBe(503);
    expect((await rowFor(partner.id)).status).toBe("PENDING");
    // An unknown session is acknowledged and ignored.
    state.webhookSecret = "whsec_test_digilocker_0123456789";
    expect(await webhook("00000000-0000-0000-0000-000000000000", "failed")).toEqual({ status: 200, body: { ok: true, result: "unknown_session" } });
  });

  it("the OTP fields are gone with DigiLocker on; legacy OTP and DigiLocker each refuse the other method", async () => {
    const { user, adminActor } = await approvedRider();
    signInAs(user, "DELIVERY_PARTNER");
    expect((await call(otpRoute, "/api/delivery-partner/me/kyc/aadhaar/otp", { method: "POST", body: { aadhaar: "2341 2341 2346", consent: true } })).status).toBe(409);
    await setRule("riderVerification", { aadhaarMethod: "okyc_legacy" }, adminActor);
    expect((await call(startRoute, "/api/delivery-partner/me/kyc/aadhaar/digilocker", { method: "POST", body: { consent: true } })).status).toBe(409);
  });

  it("an Aadhaar verified by the legacy OTP stays valid after the switch", async () => {
    const { user, partner } = await approvedRider();
    await db.insert(deliveryPartnerKycChecks).values({
      deliveryPartnerId: partner.id,
      docType: "AADHAAR",
      status: "VERIFIED",
      numberMasked: "XXXX XXXX 2346",
      numberToken: "a".repeat(64),
      provider: "sandboxco",
      consentVersion: "2026-10-31",
      consentGivenAt: new Date(),
      verifiedAt: new Date(),
    });
    expect((await getMyRiderKyc(user.id)).aadhaar).toMatchObject({ status: "VERIFIED", method: "okyc_legacy" });
    expect(await startMyAadhaarDigilocker(user.id, { consentGiven: true })).toMatchObject({ url: null, check: { status: "VERIFIED" } });
    const [p] = await db.select().from(deliveryPartners).where(eq(deliveryPartners.id, partner.id));
    expect(await isRiderKycComplete(p.id)).toBe(false); // PAN still missing — the Aadhaar half counts
  });

  it("admin: method, session status and reason; Resend link starts a new session and notifies the partner", async () => {
    const { user, admin, adminActor, partner } = await approvedRider();
    await startAndDecide(user.id, "expire");
    await syncMyAadhaarDigilocker(user.id);
    const [row] = await listRiderKycChecksForAdmin(adminActor);
    expect(row).toMatchObject({ method: "digilocker", status: "FAILED", sessionStatus: "expired", canResend: true, adminReason: expect.stringMatching(/expired/) });

    signInAs(admin, "ADMIN");
    const resent = await call(resendRoute, `/api/admin/rider-kyc-checks/${row.id}/resend-digilocker`, { method: "POST", params: { id: row.id } });
    expect(resent.status).toBe(200);
    expect(resent.body.check).toMatchObject({ status: "PENDING", errorCode: "digilocker_resent", digilockerOpen: true });
    const notes = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(notes.some((n) => n.actionUrl === "/delivery-partner/kyc/digilocker/open")).toBe(true);

    // Only an admin; never for a Verified check.
    await expect(resendDigilockerLink(row.id, { id: user.id, role: "DELIVERY_PARTNER" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    decideMockDigilocker(sessionOf((await rowFor(partner.id)).sessionUrl!), "approve");
    await syncMyAadhaarDigilocker(user.id);
    await expect(resendDigilockerLink(row.id, adminActor)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("the mock consent page's API refuses unknown sessions", async () => {
    expect((await call(mockDecideRoute, "/api/kyc-mock/digilocker", { method: "POST", body: { session: "mock-dl-unknown", decision: "approve" } })).status).toBe(404);
    expect((await call(mockDecideRoute, "/api/kyc-mock/digilocker", { method: "POST", body: { session: "mock-dl-unknown", decision: "hack" } })).status).toBe(400);
  });
});
