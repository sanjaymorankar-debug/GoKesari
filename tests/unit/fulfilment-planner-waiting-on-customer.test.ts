/**
 * QA D-147 (staging regression, 09-Nov-2026): with rule fulfilmentOptions on,
 * "Packed — mark ready" comes from the fulfilment planner and stayed active
 * while a line was "(waiting for customer)" on a substitute; pressing it only
 * got the server's 409. The planner now waits as the older button does.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import type { PlannerPlan } from "@/components/fulfilment-planner";
import { ShopOrderManager, type ShopFulfilmentSettings, type ShopOrderItem, type ShopOrderRow } from "@/components/shop-order-manager";

const item = (id: string, fulfilmentStatus: string): ShopOrderItem => ({
  id,
  productNameSnapshot: "E2E Packaged Biscuits",
  unitSnapshot: "pack",
  quantityMilli: 1_000,
  lineTotalPaise: 5_000,
  fulfilmentStatus,
  substituteNameSnapshot: fulfilmentStatus === "PENDING" ? null : "E2E Bread",
  substituteUnitSnapshot: fulfilmentStatus === "PENDING" ? null : "loaf",
  substituteQuantityMilli: fulfilmentStatus === "PENDING" ? null : 1_000,
  substituteLineTotalPaise: fulfilmentStatus === "PENDING" ? null : 4_000,
});

const order = (lineStatuses: string[], plan: PlannerPlan | null = null): ShopOrderRow => ({
  id: "00000000-0000-0000-0000-000000000001",
  orderNumber: "DB-20261109-D147AA",
  status: "PREPARING",
  totalPaise: 5_000,
  createdAt: "2026-11-09T06:00:00.000Z",
  items: lineStatuses.map((status, index) => item(`line-${index}`, status)),
  deliveryStatus: null,
  pickupCode: null,
  fulfilmentPlan: plan,
});

const planner: ShopFulfilmentSettings = {
  enabled: true,
  days: [{ date: "2026-11-10", label: "Tue, 10 Nov", slots: [{ key: "2026-11-10@10:00", start: "10:00", end: "11:00", label: "10:00–11:00" }] }],
  staff: [],
};

const plan: PlannerPlan = {
  option: "PICKUP",
  optionLabel: "Pickup from the shop",
  whenLabel: "Tue, 10 Nov, 10:00–11:00",
  slotKey: "2026-11-10@10:00",
  staff: null,
  staffLinkPath: null,
  outForDelivery: false,
  completed: false,
  locked: false,
  riderSearchFrom: null,
};

const card = (row: ShopOrderRow, fulfilment: ShopFulfilmentSettings | null = planner) =>
  renderToStaticMarkup(createElement(ShopOrderManager, { orders: [row], deliveryAvailable: false, fulfilment }));

/** The opening tag of the button with this label, whose `disabled` attribute the checks read. */
function buttonTag(html: string, label: string): string {
  const tags = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<\/button>/g) ?? [];
  const found = tags.find((tag) => tag.includes(label));
  if (!found) throw new Error(`No "${label}" button on the card`);
  return found.slice(0, found.indexOf(">") + 1);
}

const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

describe("the planner's mark-ready waits for the customer's answer on a substitute (QA D-147)", () => {
  it("is disabled while a line waits for the customer", () => {
    expect(isDisabled(buttonTag(card(order(["SUBSTITUTION_PROPOSED"])), "Packed — mark ready"))).toBe(true);
  });

  it("is disabled when only one of several lines waits", () => {
    expect(isDisabled(buttonTag(card(order(["PICKED", "SUBSTITUTION_PROPOSED"])), "Packed — mark ready"))).toBe(true);
  });

  it.each([
    ["accepted the substitute", "SUBSTITUTED"],
    ["refused the substitute", "REMOVED"],
  ])("is enabled again once the customer has %s", (_name, decided) => {
    expect(isDisabled(buttonTag(card(order(["PICKED", decided])), "Packed — mark ready"))).toBe(false);
  });

  it("leaves an order with no substitute alone", () => {
    expect(isDisabled(buttonTag(card(order(["PENDING"])), "Packed — mark ready"))).toBe(false);
  });

  it("keeps changing a saved plan open while the customer decides: only marking ready waits", () => {
    const html = card(order(["SUBSTITUTION_PROPOSED"], plan));
    expect(html).not.toContain("Packed — mark ready");
    expect(isDisabled(buttonTag(html, "Change"))).toBe(false);
  });

  it("still disables the older button when the rule is off", () => {
    const html = card(order(["SUBSTITUTION_PROPOSED"]), null);
    expect(isDisabled(buttonTag(html, "Packed — mark ready"))).toBe(true);
  });
});
