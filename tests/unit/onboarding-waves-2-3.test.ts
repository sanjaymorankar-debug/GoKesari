/**
 * Onboarding Phase 2, Waves 2–3 (docs/onboarding-waves-2-3-2026-11): WP6 referral help by PIN,
 * WP7 one assisted mode, flags OFF unchanged. No database: the data each service reads is injected
 * or mocked, so the rules themselves are what is tested.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GeoArea } from "@/server/db/schema";

const m = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  user: null as null | { id: string; email: string; name: string | null; image: null; role: string },
  /** Results the fake database hands out, in order, one per awaited query. */
  queue: [] as unknown[][],
  /** Every `.set(...)` the fake database received. */
  sets: [] as Record<string, unknown>[],
  audits: [] as Record<string, unknown>[],
  draft: { id: "draft-1", assistedByUserId: null as string | null, referralCode: null as string | null, referralAnsweredAt: null as Date | null },
}));

vi.mock("@/server/services/feature-flags", async () => {
  const { AppError } = await import("@/lib/errors");
  const notAvailable = (key: string) => new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: key });
  return {
    isFeatureEnabled: async (key: string) => Boolean(m.flags[key]),
    requireFeature: async (key: string) => {
      if (!m.flags[key]) throw notAvailable(key);
    },
    featureNotAvailable: notAvailable,
  };
});

vi.mock("@/server/authz/guards", () => ({
  getCurrentUser: async () => m.user,
  requireUser: async () => {
    if (!m.user) {
      const { unauthenticated } = await import("@/lib/errors");
      throw unauthenticated();
    }
    return m.user;
  },
  requirePermission: vi.fn(async () => m.user),
}));

vi.mock("@/server/services/audit", () => ({
  AUDIT_ACTIONS: { ONBOARDING_ASSISTED_STEP: "onboarding.assisted_step" },
  recordAudit: async (entry: Record<string, unknown>) => {
    m.audits.push(entry);
  },
}));

vi.mock("@/server/dealers/codes", () => ({ activeCodeFor: async (dealerId: string, salespersonId: string | null) => (salespersonId ? null : `CODE-${dealerId}`) }));
vi.mock("@/server/services/shop-registration-draft", () => ({
  assertNoWaitingRegistration: async () => {},
  lockOpenDraft: async () => ({ ...m.draft }),
}));
vi.mock("@/server/events/emit", () => ({ emitEvent: async () => {} }));
vi.mock("@/server/payments/intents", () => ({ createPaymentIntent: async () => ({}), isLive: () => true, listIntentsFor: async () => [] }));
vi.mock("@/server/services/registration-fee-payment", () => ({ registrationFeeDue: () => 0 }));
vi.mock("@/server/services/shop-document-gate", () => ({ assertDocumentsAllowPayment: async () => {} }));

/** A chainable stand-in for drizzle's query builder: any call returns itself; awaiting it gives the next queued result. */
vi.mock("@/server/db", () => {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") {
          const next = m.queue.shift() ?? [];
          return (resolve: (v: unknown) => void) => resolve(next);
        }
        if (prop === "set") {
          return (patch: Record<string, unknown>) => {
            m.sets.push(patch);
            return chain;
          };
        }
        if (prop === "transaction") return async (run: (tx: unknown) => Promise<unknown>) => run(chain);
        return () => chain;
      },
    },
  );
  return { db: chain };
});

import { GET as byPincodeGet } from "@/app/api/referral-codes/by-pincode/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { wizardActor } from "@/server/api/wizard-actor";
import { requirePermission } from "@/server/authz/guards";
import { dealersForPincode, type CandidateDealer, type DealersForPincodeDeps } from "@/server/dealers/referral-by-pincode";
import {
  assistedDraftPatch,
  assistedFeeLink,
  actingOwnerFor,
  claimProblem,
  consentIsValid,
  startAssistedDraft,
  type HelperConsent,
} from "@/server/services/assisted-onboarding";

const area = (code: string, name: string, level: GeoArea["level"], parentCode: string | null, status: GeoArea["status"] = "ACTIVE"): GeoArea =>
  ({ code, name, level, parentCode, shortCode: null, status, createdAt: new Date(), updatedAt: new Date() }) as GeoArea;

const MH = area("MH", "Maharashtra", "STATE", null);
const PUNE = area("MH-PUN", "Pune", "DISTRICT", "MH");
const HAVELI = area("MH-PUN-HAV", "Haveli", "TALUKA", "MH-PUN");
const KOTHRUD = area("MH-PUN-HAV-KOT", "Kothrud", "LOCALITY", "MH-PUN-HAV");

function deps(candidates: CandidateDealer[], codes: Record<string, string | null> = {}): DealersForPincodeDeps & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    areaForPincode: async (pin) => (pin === "411038" ? { area: KOTHRUD } : null),
    ancestry: async () => [KOTHRUD, HAVELI, PUNE, MH],
    dealersInAreas: async (codesAsked) => {
      asked.push(codesAsked);
      return candidates.filter((c) => codesAsked.includes(c.areaCode));
    },
    activeCode: async (id) => (id in codes ? codes[id] : `GKS-${id}`),
  };
}

const dealer = (dealerId: string, areaCode: string, over: Partial<CandidateDealer> = {}): CandidateDealer => ({
  dealerId,
  areaCode,
  legalName: `Dealer ${dealerId}`,
  mobileE164: "+919876543210",
  status: "APPROVED",
  isInternal: false,
  ...over,
});

beforeEach(() => {
  m.flags = {};
  m.user = null;
  m.queue = [];
  m.sets = [];
  m.audits = [];
  m.draft = { id: "draft-1", assistedByUserId: null, referralCode: null, referralAnsweredAt: null };
  resetRateLimits();
  vi.mocked(requirePermission).mockClear();
});

/* ------------------------------------------------------------------ WP6 */

describe("WP6 dealersForPincode: PIN → area → ancestors → territories → approved dealers → active code", () => {
  it("asks for the PIN's area and every ancestor, and lists the closest area first", async () => {
    const d = deps([dealer("state", "MH"), dealer("district", "MH-PUN"), dealer("locality", "MH-PUN-HAV-KOT"), dealer("taluka", "MH-PUN-HAV")]);
    const result = await dealersForPincode("411038", { includePhone: false }, d);
    expect(d.asked).toEqual([["MH-PUN-HAV-KOT", "MH-PUN-HAV", "MH-PUN", "MH"]]);
    expect(result.area).toBe("Kothrud");
    expect(result.dealers.map((x) => x.area)).toEqual(["Kothrud", "Haveli", "Pune", "Maharashtra"]);
    expect(result.dealers[0]).toMatchObject({ displayName: "Dealer locality", code: "GKS-locality", areaLevel: "LOCALITY" });
  });

  it("lists a dealer once, at its closest area; skips dealers not approved, internal, or without an active code", async () => {
    const d = deps(
      [
        dealer("a", "MH"),
        dealer("a", "MH-PUN-HAV-KOT"),
        dealer("suspended", "MH-PUN", { status: "SUSPENDED" }),
        dealer("direct", "MH-PUN", { isInternal: true }),
        dealer("nocode", "MH-PUN"),
        dealer("b", "MH-PUN"),
      ],
      { nocode: null },
    );
    const result = await dealersForPincode("411038", { includePhone: false }, d);
    expect(result.dealers.map((x) => [x.displayName, x.area])).toEqual([
      ["Dealer a", "Kothrud"],
      ["Dealer b", "Pune"],
    ]);
  });

  it("shows the phone only when asked (signed-in caller)", async () => {
    const d = deps([dealer("a", "MH-PUN")]);
    expect((await dealersForPincode("411038", { includePhone: false }, d)).dealers[0].phone).toBeNull();
    expect((await dealersForPincode("411038", { includePhone: true }, d)).dealers[0].phone).toBe("+91 98765 43210");
  });

  it("caps the list and answers empty for a bad or unmapped PIN without reading dealers", async () => {
    const many = Array.from({ length: 8 }, (_, i) => dealer(`d${i}`, "MH-PUN"));
    expect((await dealersForPincode("411038", { includePhone: false }, deps(many))).dealers).toHaveLength(5);
    const d = deps(many);
    expect(await dealersForPincode("0110", { includePhone: false }, d)).toEqual({ pincode: "0110", area: null, dealers: [] });
    expect(await dealersForPincode("999999", { includePhone: false }, d)).toEqual({ pincode: "999999", area: null, dealers: [] });
    expect(d.asked).toEqual([]);
  });
});

describe("WP6 GET /api/referral-codes/by-pincode", () => {
  const request = (pin: string, ip = "10.0.0.1") => new Request(`http://localhost/api/referral-codes/by-pincode?pin=${pin}`, { headers: { "x-forwarded-for": ip } }) as never;

  it("is 404 while onboarding_referral_by_pin_enabled is off", async () => {
    const response = await byPincodeGet(request("411038"));
    expect(response.status).toBe(404);
  });

  it("refuses a bad PIN and rate-limits a caller after 10 look-ups a minute", async () => {
    m.flags.onboarding_referral_by_pin_enabled = true;
    expect((await byPincodeGet(request("12"))).status).toBe(422);
    // An unmapped PIN answers from the (fake) database: empty area rows.
    for (let i = 0; i < 9; i++) {
      m.queue.push([]);
      expect((await byPincodeGet(request("411038"))).status).toBe(200);
    }
    expect((await byPincodeGet(request("411038"))).status).toBe(429);
    // Another caller has their own window.
    m.queue.push([]);
    expect((await byPincodeGet(request("411038", "10.0.0.2"))).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ WP7 */

const helper = { id: "11111111-1111-4111-8111-111111111111", role: "SHOP_OWNER" as const };
const OWNER = "22222222-2222-4222-8222-222222222222";
const future = () => new Date(Date.now() + 10 * 60_000);
const consent = (over: Partial<HelperConsent> = {}): HelperConsent => ({ role: "DEALER", sessionId: "sess-1", ownerUserId: OWNER, consentExpiresAt: future(), code: "GKS-MH-PUN-0001", ...over });

describe("WP7 consent, draft columns and code lock (pure rules)", () => {
  it("a consent counts only while OWNER_VERIFIED, for this owner and not expired", () => {
    const row = { id: "s", status: "OWNER_VERIFIED", ownerUserId: OWNER, consentExpiresAt: future() };
    expect(consentIsValid(row, OWNER)).toBe(true);
    expect(consentIsValid({ ...row, status: "OTP_SENT" }, OWNER)).toBe(false);
    expect(consentIsValid({ ...row, status: "SHOP_SUBMITTED" }, OWNER)).toBe(false);
    expect(consentIsValid(row, "someone-else")).toBe(false);
    expect(consentIsValid({ ...row, consentExpiresAt: new Date(Date.now() - 1) }, OWNER)).toBe(false);
    expect(consentIsValid({ ...row, consentExpiresAt: null }, OWNER)).toBe(false);
  });

  it("the patch records who helped, how and under which consent, and puts the helper's code on the draft", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    expect(assistedDraftPatch(helper, consent(), now)).toEqual({
      assistedByUserId: helper.id,
      assistedRole: "DEALER",
      assistedSessionId: "sess-1",
      referralCode: "GKS-MH-PUN-0001",
      referralAnsweredAt: now,
      updatedAt: now,
    });
    // An operator without a code leaves the owner's referral answer alone.
    const op = assistedDraftPatch(helper, consent({ role: "OPERATOR", code: null }), now);
    expect(op).not.toHaveProperty("referralCode");
    expect(op.assistedRole).toBe("OPERATOR");
  });

  it("another helper's draft, or a different code the owner already used, cannot be claimed", () => {
    const blank = { assistedByUserId: null, referralCode: null, referralAnsweredAt: null };
    expect(claimProblem(blank, helper, consent())).toBeNull();
    expect(claimProblem({ ...blank, assistedByUserId: helper.id }, helper, consent())).toBeNull();
    expect(claimProblem({ ...blank, assistedByUserId: "other" }, helper, consent())).toMatch(/Someone else/);
    expect(claimProblem({ ...blank, referralCode: "OTHER1", referralAnsweredAt: new Date() }, helper, consent())).toMatch(/only one code/);
    expect(claimProblem({ ...blank, referralCode: "GKS-MH-PUN-0001", referralAnsweredAt: new Date() }, helper, consent())).toBeNull();
  });
});

describe("WP7 startAssistedDraft writes the assisted columns", () => {
  it("with a valid dealer consent: the owner's draft gets assisted_by_user_id, assisted_role, the session and the locked code; audited", async () => {
    m.flags.onboarding_assisted_mode_enabled = true;
    // findHelperConsent: the dealer session rows, then the update's returning().
    m.queue.push([
      { id: "sess-9", status: "OWNER_VERIFIED", ownerUserId: OWNER, consentExpiresAt: future(), dealerId: "d1", salespersonId: null, dealerUserId: helper.id, dealerStatus: "APPROVED" },
    ]);
    m.queue.push([{ id: "draft-1" }]);
    const result = await startAssistedDraft(helper, OWNER);
    expect(result).toEqual({ draftId: "draft-1", role: "DEALER", code: "CODE-d1" });
    expect(m.sets).toHaveLength(1);
    expect(m.sets[0]).toMatchObject({ assistedByUserId: helper.id, assistedRole: "DEALER", assistedSessionId: "sess-9", referralCode: "CODE-d1" });
    expect(m.audits).toEqual([expect.objectContaining({ actorId: helper.id, action: "onboarding.assisted_step", entityId: "draft-1", newValue: expect.objectContaining({ step: "STARTED", ownerId: OWNER }) })]);
  });

  it("without a valid consent nothing is written and the refusal is audited", async () => {
    m.flags.onboarding_assisted_mode_enabled = true;
    m.queue.push([
      // Another dealer's session for this owner: not this helper's.
      { id: "sess-x", status: "OWNER_VERIFIED", ownerUserId: OWNER, consentExpiresAt: future(), dealerId: "d2", salespersonId: null, dealerUserId: "someone-else", dealerStatus: "APPROVED" },
    ]);
    await expect(startAssistedDraft(helper, OWNER)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(m.sets).toEqual([]);
    expect(m.audits).toEqual([expect.objectContaining({ newValue: { step: "REFUSED", reason: "no_valid_consent" } })]);
  });

  it("a draft another helper holds is refused (409) and left alone", async () => {
    m.flags.onboarding_assisted_mode_enabled = true;
    m.draft.assistedByUserId = "another-helper";
    m.queue.push([{ id: "sess-9", status: "OWNER_VERIFIED", ownerUserId: OWNER, consentExpiresAt: future(), dealerId: "d1", salespersonId: null, dealerUserId: helper.id, dealerStatus: "APPROVED" }]);
    await expect(startAssistedDraft(helper, OWNER)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(m.sets).toEqual([]);
  });
});

/* --------------------------------------------------------- flags OFF */

describe("flags OFF: behaviour unchanged", () => {
  it("assisted services answer 404 and touch nothing", async () => {
    await expect(startAssistedDraft(helper, OWNER)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(actingOwnerFor(helper, OWNER, { path: "/api/shops/registration-draft/referral", method: "POST" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(assistedFeeLink(helper, OWNER)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.sets).toEqual([]);
    expect(m.audits).toEqual([]);
  });

  it("the wizard routes' actor without the assist header is exactly requirePermission(SHOP_CREATE)", async () => {
    m.user = { id: OWNER, email: "o@example.com", name: "Owner", image: null, role: "CUSTOMER" };
    const actor = await wizardActor(new Request("http://localhost/api/shops/registration-draft/referral", { method: "POST" }));
    expect(actor).toBe(m.user);
    expect(requirePermission).toHaveBeenCalledWith("shop:create");
    // No request at all (a GET called directly): the same.
    expect(await wizardActor()).toBe(m.user);
  });

  it("with the assist header while the flag is off: 404, and the owner is never acted for", async () => {
    m.user = { id: helper.id, email: "h@example.com", name: "Helper", image: null, role: "SHOP_OWNER" };
    const request = new Request("http://localhost/api/shops/registration-draft/referral", { method: "POST", headers: { "x-gk-assist-owner": OWNER } });
    await expect(wizardActor(request)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(requirePermission).not.toHaveBeenCalled();
  });
});
