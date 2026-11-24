/**
 * Module 4 (23-Nov-2026) — delivery signature, GPS at delivery / failure,
 * fixed failed-delivery reasons and multi-stop navigation. Every behaviour is
 * behind a rule field that defaults off; these tests cover the service logic
 * with the rules off (nothing changes) and on, and the rider-screen pieces.
 * No database: the settings and the database client are stubbed.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rules: {} as Record<string, Record<string, unknown>>,
  /** Rows the next `await db.select()...` chains resolve to, in order. */
  selectResults: [] as unknown[][],
  trip: null as unknown,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

vi.mock("@/server/services/settings", async () => {
  const { RULES } = await import("@/server/config/rules");
  return {
    getRule: vi.fn(async (key: keyof typeof RULES) => ({ ...(RULES[key].defaults as object), ...(state.rules[key] ?? {}) })),
  };
});

vi.mock("@/server/db", () => {
  const chain = (): unknown => {
    const rows = state.selectResults.shift() ?? [];
    const c: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "where", "limit", "orderBy"]) c[m] = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return c;
  };
  return {
    db: {
      select: () => chain(),
      transaction: () => {
        throw new Error("no transaction expected in these tests");
      },
    },
  };
});

vi.mock("@/server/services/delivery-trips", () => ({ getRiderTrip: vi.fn(async () => state.trip) }));

import { RULES } from "@/server/config/rules";
import { composeFailureReason, FAILURE_REASON_CODES, FAILURE_REASON_LABELS } from "@/lib/delivery/failure-reasons";
import { drawStrokes, hasInk, lineWidthFor, undoStroke, type SignatureStroke } from "@/components/signature-pad";
import {
  assertDeliveryProof,
  cleanSignerName,
  signatureRules,
  uploadDeliveryProof,
  validPosition,
} from "@/server/services/delivery-proofs";
import { getNavigationTrip } from "@/server/services/rider-navigation";
import { DeliveryPartnerDashboard, type ActiveDelivery } from "@/components/delivery-partner-dashboard";
import { TripStopList } from "@/components/rider-navigation";

beforeEach(() => {
  state.rules = {};
  state.selectResults = [];
  state.trip = null;
});

describe("rule defaults — everything new is off", () => {
  it("TC-M4-001 deliveryProof signature / GPS / reason list and riderNavigation.multiStop default to false", () => {
    expect(RULES.deliveryProof.defaults).toEqual({
      photoRequired: false,
      signatureEnabled: false,
      signatureRequired: false,
      captureGps: false,
      failureReasons: false,
    });
    expect(RULES.riderNavigation.defaults.multiStop).toBe(false);
    // A stored value from before Module 4 still validates once merged with the defaults.
    expect(RULES.deliveryProof.schema.safeParse({ ...RULES.deliveryProof.defaults, photoRequired: true }).success).toBe(true);
  });
});

describe("failed-delivery reasons", () => {
  it("TC-M4-010 free text works as before (3+ characters)", () => {
    expect(composeFailureReason(null, "  Customer not at home ")).toEqual({ ok: true, text: "Customer not at home", code: null });
    expect(composeFailureReason(undefined, "ab")).toMatchObject({ ok: false });
    expect(composeFailureReason(null, "")).toMatchObject({ ok: false });
  });

  it("TC-M4-011 a listed reason stores its label, with the note when given", () => {
    expect(composeFailureReason("WRONG_ADDRESS", "")).toEqual({ ok: true, text: "Wrong address", code: "WRONG_ADDRESS" });
    expect(composeFailureReason("REFUSED", " said not ordered ")).toEqual({
      ok: true,
      text: "Customer refused the order — said not ordered",
      code: "REFUSED",
    });
  });

  it("TC-M4-012 Other needs a note; every code has a label", () => {
    expect(composeFailureReason("OTHER", "x")).toMatchObject({ ok: false });
    expect(composeFailureReason("OTHER", "Gate locked")).toEqual({ ok: true, text: "Other — Gate locked", code: "OTHER" });
    for (const code of FAILURE_REASON_CODES) expect(FAILURE_REASON_LABELS[code]).toBeTruthy();
    expect(FAILURE_REASON_CODES).toEqual(["CUSTOMER_NOT_AVAILABLE", "WRONG_ADDRESS", "REFUSED", "PHONE_UNREACHABLE", "OTHER"]);
  });
});

describe("signature pad helpers", () => {
  const stroke = (n: number): SignatureStroke => Array.from({ length: n }, (_, i) => ({ x: i / 10, y: 0.5, p: 0.5 }));

  it("TC-M4-020 a tap is not a signature; a stroke is; undo drops the last stroke", () => {
    expect(hasInk([])).toBe(false);
    expect(hasInk([stroke(1)])).toBe(false);
    expect(hasInk([stroke(4)])).toBe(true);
    const two = [stroke(4), stroke(2)];
    expect(undoStroke(two)).toEqual([two[0]]);
    expect(undoStroke([])).toEqual([]);
  });

  it("TC-M4-021 stylus pressure thickens the line; bad pressure falls back to the middle", () => {
    expect(lineWidthFor(1, 600)).toBeGreaterThan(lineWidthFor(0.1, 600));
    expect(lineWidthFor(Number.NaN, 600)).toBe(lineWidthFor(0.5, 600));
  });

  it("TC-M4-022 drawStrokes paints a white background for export and scales points to the image", () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop: string) => (...args: unknown[]) => calls.push(`${prop}(${args.join(",")})`),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    drawStrokes(ctx, [[{ x: 0, y: 0, p: 0.5 }, { x: 1, y: 1, p: 0.5 }]], 600, 240, true);
    expect(calls).toContain("fillRect(0,0,600,240)");
    expect(calls).toContain("moveTo(0,0)");
    expect(calls).toContain("lineTo(600,240)");
  });
});

describe("signature proof (rule deliveryProof)", () => {
  it("TC-M4-030 signatureRequired counts only while the pad is on", async () => {
    expect(await signatureRules()).toEqual({ enabled: false, required: false });
    state.rules.deliveryProof = { signatureRequired: true };
    expect(await signatureRules()).toEqual({ enabled: false, required: false });
    state.rules.deliveryProof = { signatureEnabled: true, signatureRequired: true };
    expect(await signatureRules()).toEqual({ enabled: true, required: true });
  });

  it("TC-M4-031 rules off: markDelivered's proof check passes without touching the database", async () => {
    state.selectResults = [[{ unexpected: true }]];
    await expect(assertDeliveryProof("d1")).resolves.toBeUndefined();
    expect(state.selectResults).toHaveLength(1); // no query ran
  });

  it("TC-M4-032 signature required: refused without one, allowed with one", async () => {
    state.rules.deliveryProof = { signatureEnabled: true, signatureRequired: true };
    state.selectResults = [[]];
    await expect(assertDeliveryProof("d1")).rejects.toMatchObject({ code: "CONFLICT" });
    state.selectResults = [[{ id: "sig-1" }]];
    await expect(assertDeliveryProof("d1")).resolves.toBeUndefined();
  });

  it("TC-M4-033 signatureRequired with the pad off is ignored (nothing the rider could do)", async () => {
    state.rules.deliveryProof = { signatureEnabled: false, signatureRequired: true };
    await expect(assertDeliveryProof("d1")).resolves.toBeUndefined();
  });

  it("TC-M4-034 photo and signature both required: the photo is checked first", async () => {
    state.rules.deliveryProof = { photoRequired: true, signatureEnabled: true, signatureRequired: true };
    state.selectResults = [[{ id: "photo" }], []];
    await expect(assertDeliveryProof("d1")).rejects.toThrow(/signature/i);
    state.selectResults = [[]];
    await expect(assertDeliveryProof("d1")).rejects.toThrow(/photo/i);
  });

  it("TC-M4-035 uploading a signature while the pad is off is refused (404) before any lookup", async () => {
    await expect(
      uploadDeliveryProof("d1", { id: "u1", role: "DELIVERY_PARTNER" }, Buffer.from("x"), "SIGNATURE"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("TC-M4-036 a signature is only for the rider holding the picked-up delivery", async () => {
    state.rules.deliveryProof = { signatureEnabled: true };
    state.selectResults = [[{ d: { status: "PICKED_UP", orderId: "o1" }, riderUserId: "someone-else" }]];
    await expect(
      uploadDeliveryProof("d1", { id: "u1", role: "DELIVERY_PARTNER" }, Buffer.from("x"), "SIGNATURE"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    state.selectResults = [[{ d: { status: "ACCEPTED", orderId: "o1" }, riderUserId: "u1" }]];
    await expect(
      uploadDeliveryProof("d1", { id: "u1", role: "DELIVERY_PARTNER" }, Buffer.from("x"), "SIGNATURE"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("TC-M4-037 signer name is trimmed, collapsed and capped; positions are range-checked", () => {
    expect(cleanSignerName("  Asha   Patil ")).toBe("Asha Patil");
    expect(cleanSignerName("   ")).toBeNull();
    expect(cleanSignerName(null)).toBeNull();
    expect(cleanSignerName("x".repeat(200))).toHaveLength(80);
    expect(validPosition({ latitude: 18.52, longitude: 73.85 })).toEqual({ latitude: 18.52, longitude: 73.85 });
    expect(validPosition({ latitude: 91, longitude: 0 })).toBeNull();
    expect(validPosition({ latitude: Number.NaN, longitude: 0 })).toBeNull();
    expect(validPosition(null)).toBeNull();
  });
});

describe("GPS at delivery / failure (rule deliveryProof.captureGps)", () => {
  it("TC-M4-040 kept only while the rule is on; accuracy rounded", async () => {
    const { gpsToKeep } = await import("@/server/services/delivery-assignment");
    const p = { latitude: 18.5204, longitude: 73.8567, accuracyM: 12.6 };
    expect(await gpsToKeep(p)).toBeNull(); // rule off (default)
    expect(await gpsToKeep(p, { captureGps: false })).toBeNull();
    expect(await gpsToKeep(p, { captureGps: true })).toEqual({ latitude: 18.5204, longitude: 73.8567, accuracyM: 13 });
    expect(await gpsToKeep({ latitude: 18.5, longitude: 73.8 }, { captureGps: true })).toEqual({
      latitude: 18.5,
      longitude: 73.8,
      accuracyM: null,
    });
    expect(await gpsToKeep({ latitude: 200, longitude: 0 }, { captureGps: true })).toBeNull();
    expect(await gpsToKeep(null, { captureGps: true })).toBeNull();
    state.rules.deliveryProof = { captureGps: true };
    expect(await gpsToKeep(p)).not.toBeNull();
  });
});

describe("multi-stop navigation (rule riderNavigation.multiStop)", () => {
  const trip = {
    tripId: "t1",
    stops: [
      { kind: "PICKUP", deliveryOrderId: "a", orderId: "oa", orderNumber: "A-1", label: "Shop A", done: true, eta: null, late: false, current: false },
      { kind: "PICKUP", deliveryOrderId: "b", orderId: "ob", orderNumber: "B-1", label: "Shop B", done: false, eta: "2026-11-23T10:00:00.000Z", late: false, current: true },
      { kind: "DROP", deliveryOrderId: "a", orderId: "oa", orderNumber: "A-1", label: "Kothrud", done: false, eta: "2026-11-23T10:20:00.000Z", late: true, current: false },
    ],
  };

  it("TC-M4-050 off by default, and off while batching is off — single-stop behaviour unchanged", async () => {
    state.trip = trip;
    expect(await getNavigationTrip("u1")).toBeNull();
    state.rules.riderNavigation = { multiStop: true };
    expect(await getNavigationTrip("u1")).toBeNull();
  });

  it("TC-M4-051 on with a trip: ordered stops and the next stop", async () => {
    state.rules.riderNavigation = { multiStop: true };
    state.rules.batching = { enabled: true };
    state.trip = trip;
    const view = await getNavigationTrip("u1");
    expect(view?.stops.map((s) => `${s.kind}:${s.deliveryOrderId}`)).toEqual(["PICKUP:a", "PICKUP:b", "DROP:a"]);
    expect(view?.nextStop).toMatchObject({ kind: "PICKUP", deliveryOrderId: "b" });
    state.trip = null; // carrying one order
    expect(await getNavigationTrip("u1")).toBeNull();
  });

  it("TC-M4-052 the stop list marks this route's stop and links the next stop elsewhere", async () => {
    state.rules.riderNavigation = { multiStop: true };
    state.rules.batching = { enabled: true };
    state.trip = trip;
    const view = (await getNavigationTrip("u1"))!;
    const onA = renderToStaticMarkup(createElement(TripStopList, { trip: view, deliveryOrderId: "a", leg: "TO_CUSTOMER" }));
    expect(onA).toContain('data-testid="next-stop"');
    expect(onA).toContain("/delivery-partner/navigate/b");
    expect(onA).toContain("(late)");
    const onB = renderToStaticMarkup(createElement(TripStopList, { trip: view, deliveryOrderId: "b", leg: "TO_SHOP" }));
    expect(onB).not.toContain('data-testid="next-stop"');
    expect(onB).toContain('aria-current="step"');
  });
});

describe("rider dashboard (flag-off unchanged, flag-on steps)", () => {
  const delivery = (extra: Partial<ActiveDelivery> = {}): ActiveDelivery => ({
    id: "00000000-0000-0000-0000-0000000000d1",
    status: "PICKED_UP",
    orderNumber: "DB-20261123-M4",
    orderTotalPaise: 10_000,
    cashToCollectPaise: null,
    shopName: "Dairy One",
    shopAddress: "Pune",
    customerAddress: "Kothrud, Pune",
    distanceKm: "2.1",
    needsPickupCode: false,
    needsDeliveryOtp: false,
    outForDeliveryAt: new Date("2026-11-23T09:00:00Z"),
    customerNotes: null,
    societyName: null,
    societyInstructions: null,
    ...extra,
  });
  const render = (d: ActiveDelivery) =>
    renderToStaticMarkup(
      createElement(DeliveryPartnerDashboard, {
        isOnline: true,
        activeDelivery: d,
        earnings: { todayPaise: 0, totalPaise: 0, deliveryCount: 0 },
      }),
    );

  it("TC-M4-060 rules off: no signature pad, and Mark delivered is not held for one", () => {
    const html = render(delivery());
    expect(html).not.toContain('data-testid="delivery-signature"');
    expect(html).not.toContain('data-testid="signature-pad"');
    expect(html).toMatch(/<button[^>]*>Mark delivered<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Mark delivered/);
  });

  it("TC-M4-061 signature on and required: the pad shows before Mark delivered, which waits for it", () => {
    const html = render(delivery({ signatureEnabled: true, signatureRequired: true, signatureUploaded: false }));
    expect(html).toContain('data-testid="signature-pad"');
    expect(html).toContain("Customer signature (required)");
    expect(html.indexOf('data-testid="signature-pad"')).toBeLessThan(html.indexOf("Mark delivered"));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Mark delivered/);
  });

  it("TC-M4-062 a saved signature lets the rider deliver", () => {
    const html = render(delivery({ signatureEnabled: true, signatureRequired: true, signatureUploaded: true }));
    expect(html).toContain("Customer signature added");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Mark delivered/);
  });
});
