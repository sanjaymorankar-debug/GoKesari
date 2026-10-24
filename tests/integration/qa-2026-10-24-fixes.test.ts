/**
 * Fixes from the automated QA run of 24 Oct 2026 (docs/testing/qa-defects.json):
 *
 * D-01 (TC-SEC-001) — write routes that validated the body or looked the
 *   record up before checking the session told a signed-out caller field
 *   names (422) or whether an id exists (404). Each now answers 401 first.
 * D-04 (TC-LOC-002, TC-FLD-020) — a PIN code never starts with 0: the
 *   location bar, addresses, shops and societies refuse 0xxxxx / 000000.
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

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));

import { PATCH as payoutBatchPatch } from "@/app/api/admin/payouts/batches/[id]/route";
import { POST as excelApplyPost, DELETE as excelApplyDelete } from "@/app/api/excel-uploads/[id]/apply/route";
import { POST as excelUploadsPost } from "@/app/api/excel-uploads/route";
import { POST as einvoicePost } from "@/app/api/invoices/[id]/einvoice/route";
import { POST as ewayBillPost } from "@/app/api/invoices/[id]/eway-bill/route";
import { POST as locationPost } from "@/app/api/location/route";
import { POST as assignPost } from "@/app/api/orders/[id]/assign/route";
import { POST as fulfilmentPlanPost } from "@/app/api/orders/[id]/fulfilment-plan/route";
import { POST as handoverPost } from "@/app/api/orders/[id]/fulfilment-plan/handover/route";
import { POST as fulfilmentPost } from "@/app/api/orders/[id]/fulfilment/route";
import { PATCH as orderStatusPatch } from "@/app/api/orders/[id]/status/route";
import { POST as priceRequestsPost } from "@/app/api/price-requests/route";
import { POST as productsPost } from "@/app/api/products/route";
import { DELETE as shopProductDelete, PATCH as shopProductPatch } from "@/app/api/shop-products/[id]/route";
import { PATCH as stockSettingsPatch } from "@/app/api/shop-products/[id]/stock-settings/route";
import { POST as segmentsPost } from "@/app/api/shops/[id]/marketing/segments/route";
import { resetRateLimits } from "@/server/api/rate-limit";
import { createAddress } from "@/server/services/addresses";
import { call } from "../helpers/http";
import { createUser, resetDatabase } from "../helpers/fixtures";

const ID = "00000000-0000-4000-8000-000000000000";

beforeEach(async () => {
  await resetDatabase();
  resetRateLimits();
  state.session = null;
});

describe("D-01: a signed-out caller gets 401 before the request is read", () => {
  const routes: [string, (...a: never[]) => Promise<Response>, string][] = [
    ["PATCH /api/admin/payouts/batches/[id]", payoutBatchPatch, "PATCH"],
    ["POST /api/excel-uploads", excelUploadsPost, "POST"],
    ["POST /api/excel-uploads/[id]/apply", excelApplyPost, "POST"],
    ["DELETE /api/excel-uploads/[id]/apply", excelApplyDelete, "DELETE"],
    ["POST /api/invoices/[id]/einvoice", einvoicePost, "POST"],
    ["POST /api/invoices/[id]/eway-bill", ewayBillPost, "POST"],
    ["POST /api/orders/[id]/assign", assignPost, "POST"],
    ["POST /api/orders/[id]/fulfilment", fulfilmentPost, "POST"],
    ["POST /api/orders/[id]/fulfilment-plan", fulfilmentPlanPost, "POST"],
    ["POST /api/orders/[id]/fulfilment-plan/handover", handoverPost, "POST"],
    ["PATCH /api/orders/[id]/status", orderStatusPatch, "PATCH"],
    ["POST /api/price-requests", priceRequestsPost, "POST"],
    ["POST /api/products", productsPost, "POST"],
    ["PATCH /api/shop-products/[id]", shopProductPatch, "PATCH"],
    ["DELETE /api/shop-products/[id]", shopProductDelete, "DELETE"],
    ["PATCH /api/shop-products/[id]/stock-settings", stockSettingsPatch, "PATCH"],
    ["POST /api/shops/[id]/marketing/segments", segmentsPost, "POST"],
  ];

  it.each(routes)("%s → 401 for an empty body and an unknown id", async (_name, handler, method) => {
    const res = await call(handler, `/api/x/${ID}`, { method, body: method === "DELETE" ? undefined : {}, params: { id: ID } });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("a signed-in caller still gets the route's own answer (validation, not found)", async () => {
    const user = await createUser({ role: "SHOP_OWNER" });
    state.session = { user: { id: user.id, email: user.email, name: null, image: null, role: "SHOP_OWNER", status: "ACTIVE" } };
    const status = await call(orderStatusPatch, `/api/orders/${ID}/status`, { method: "PATCH", body: {}, params: { id: ID } });
    expect(status.status).toBe(422);
    const product = await call(shopProductPatch, `/api/shop-products/${ID}`, { method: "PATCH", body: { onlinePricePaise: 100 }, params: { id: ID } });
    expect(product.status).toBe(404);
  });
});

describe("D-04: an Indian PIN code never starts with 0", () => {
  it("the location bar refuses 011001 and 000000 and accepts 411001", async () => {
    for (const pincode of ["011001", "000000"]) {
      const res = await call(locationPost, "/api/location", { method: "POST", body: { pincode } });
      expect(res.status, pincode).toBe(422);
    }
    const ok = await call(locationPost, "/api/location", { method: "POST", body: { pincode: "411001" } });
    expect(ok.status).toBe(200);
    expect(ok.body.pincode).toBe("411001");
  });

  it("an address with a PIN starting with 0 is refused", async () => {
    const user = await createUser();
    await expect(createAddress(user.id, { line1: "1 Lane", city: "Pune", pincode: "011001" })).rejects.toThrow(/PIN/);
    const saved = await createAddress(user.id, { line1: "1 Lane", city: "Pune", pincode: "411001" });
    expect(saved.pincode).toBe("411001");
  });
});
