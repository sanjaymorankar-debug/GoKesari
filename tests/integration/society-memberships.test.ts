/**
 * GET /api/societies/mine: a member gets their membership and a description
 * of the society, not the society row. Anyone can hold a PENDING request for
 * any verified society, so the gate contact, coordinates and the staff who
 * registered or verified the society are not part of it; the gate contact
 * goes only to the society's own active admins and operators.
 */
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

import { GET as mySocietiesGet } from "@/app/api/societies/mine/route";
import {
  decideMembership,
  decideSociety,
  listMySocieties,
  registerSociety,
  requestMembership,
  updateSocietySettings,
} from "@/server/services/societies";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

const actor = (u: { id: string; role: UserRole }) => ({ id: u.id, role: u.role });

function signIn(user: { id: string; email: string; name: string | null; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" } };
}

const GATE_PHONE = "+91 98200 11223";

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

async function verifiedSociety() {
  const founder = await createUser({ role: "CUSTOMER" });
  const operator = await createUser({ role: "OPERATOR" });
  const society = await registerSociety(
    { name: "Green Meadows", addressLine1: "Plot 7, Baner Road", area: "Baner", city: "Pune", pincode: "411045", latitude: 18.559, longitude: 73.786, unitLabel: "A-101" },
    actor(founder),
  );
  await decideSociety(society.id, "verify", actor(operator));
  await updateSocietySettings(
    society.id,
    { gateContactName: "Main Gate Desk", gateContactPhone: GATE_PHONE, shareGateContactWithRider: false, deliveryInstructions: "Use gate 2" },
    { id: founder.id, role: "SOCIETY_ADMIN" },
  );
  return { society, founder, operator };
}

async function mine(user: Parameters<typeof signIn>[0]) {
  signIn(user);
  const res = await call(mySocietiesGet, "/api/societies/mine");
  expect(res.status).toBe(200);
  return res.body as { membership: Record<string, unknown>; society: Record<string, unknown> }[];
}

const NEVER_SENT = ["registeredBy", "verifiedBy", "verifiedAt", "rejectionReason", "latitude", "longitude", "addressLine1", "deliveryInstructions", "userId", "approvedBy"];

describe("GET /api/societies/mine", () => {
  it("a pending request shows the society as search does: no gate contact, coordinates or staff ids", async () => {
    const { society, founder, operator } = await verifiedSociety();
    const applicant = await createUser({ role: "CUSTOMER" });
    await requestMembership(society.id, actor(applicant), "B-1204");

    const body = await mine(applicant);
    expect(body).toEqual([
      {
        membership: { id: expect.any(String), role: "RESIDENT", status: "PENDING", unitLabel: "B-1204", createdAt: expect.any(String) },
        society: { id: society.id, name: "Green Meadows", area: "Baner", city: "Pune", pincode: "411045", status: "VERIFIED" },
      },
    ]);
    const text = JSON.stringify(body);
    for (const key of [...NEVER_SENT, "gateContactName", "gateContactPhone"]) expect(text).not.toContain(`"${key}"`);
    for (const value of [GATE_PHONE, "Main Gate Desk", founder.id, operator.id, "Use gate 2"]) expect(text).not.toContain(value);
  });

  it("an approved resident still gets no gate contact; the society's admin does", async () => {
    const { society, founder } = await verifiedSociety();
    const resident = await createUser({ role: "CUSTOMER" });
    const request = await requestMembership(society.id, actor(resident));
    await decideMembership(request.id, true, { id: founder.id, role: "SOCIETY_ADMIN" });

    const asResident = await mine(resident);
    expect(asResident[0].membership).toMatchObject({ role: "RESIDENT", status: "ACTIVE" });
    expect(asResident[0].society).not.toHaveProperty("gateContactPhone");
    expect(JSON.stringify(asResident)).not.toContain(GATE_PHONE);

    const asAdmin = await mine(founder);
    expect(asAdmin[0].membership).toMatchObject({ role: "ADMIN", status: "ACTIVE", unitLabel: "A-101" });
    expect(asAdmin[0].society).toMatchObject({ id: society.id, gateContactName: "Main Gate Desk", gateContactPhone: GATE_PHONE });
    const text = JSON.stringify(asAdmin);
    for (const key of NEVER_SENT) expect(text).not.toContain(`"${key}"`);
  });

  it("feeds the society and address pages what they read", async () => {
    const { society, founder } = await verifiedSociety();
    const [row] = await listMySocieties(founder.id);
    // /society: name, role, unit, both statuses, ids for the links; /profile/addresses: id, name, statuses.
    expect(row).toMatchObject({
      membership: { id: expect.any(String), role: "ADMIN", status: "ACTIVE", unitLabel: "A-101" },
      society: { id: society.id, name: "Green Meadows", status: "VERIFIED" },
    });
  });
});
