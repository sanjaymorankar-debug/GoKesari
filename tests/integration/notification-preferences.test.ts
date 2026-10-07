/**
 * Notification settings on /profile. Shop promotions are controlled by the
 * marketing-consent switch alone, so the settings table has no row for them,
 * and a campaign's approval notice reaches its shop owner as shop news.
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

import { GET, PUT } from "@/app/api/notifications/preferences/route";
import { categoryOf } from "@/server/notifications/templates";
import { NOTIFICATION_TYPES, getPreferenceMatrix } from "@/server/services/notifications";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

beforeEach(async () => {
  await resetDatabase();
  state.session = null;
});

async function signedInCustomer() {
  const user = await createUser();
  state.session = {
    user: { id: user.id, email: user.email, name: user.name, image: null, role: user.role, status: "ACTIVE" },
  };
  return user;
}

describe("notification settings", () => {
  it("have no row for shop promotions", async () => {
    const user = await signedInCustomer();

    const matrix = await getPreferenceMatrix(user.id);
    expect(matrix.map((row) => row.category)).not.toContain("MARKETING");
    expect(matrix.map((row) => row.label)).not.toContain("Offers & campaigns");

    const res = await call(GET, "/api/notifications/preferences");
    expect(res.status).toBe(200);
    expect(res.body.preferences.map((row: { category: string }) => row.category)).not.toContain("MARKETING");
  });

  it("refuse a switch for shop promotions", async () => {
    await signedInCustomer();

    const res = await call(PUT, "/api/notifications/preferences", {
      method: "PUT",
      body: { category: "MARKETING", channel: "EMAIL", enabled: true },
    });

    expect(res.status).toBe(422);
  });

  it("file a campaign's approval notice under shop operations", () => {
    expect(categoryOf(NOTIFICATION_TYPES.CAMPAIGN_DECIDED)).toBe("SHOP");
  });
});
