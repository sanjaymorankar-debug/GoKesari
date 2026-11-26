/**
 * QA D-166 (staging, 26-Nov-2026): a paid delivery order still waiting for the customer's delivery location
 * (onboarding v2, address after payment) showed "No delivery address on this order." and left only Pickup in the
 * shop's planner. The shop now sees "Waiting for the customer's delivery location", plans a delivery (the rider /
 * own delivery waits for the location) and cannot turn the order into a pickup.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import { ShopOrderManager, type ShopFulfilmentSettings, type ShopOrderRow } from "@/components/shop-order-manager";

const order = (over: Partial<ShopOrderRow> = {}): ShopOrderRow => ({
  id: "00000000-0000-0000-0000-000000000166",
  orderNumber: "DB-20261126-D166AA",
  status: "PREPARING",
  totalPaise: 16_000,
  createdAt: "2026-11-26T16:00:00.000Z",
  items: [],
  deliveryStatus: null,
  pickupCode: null,
  fulfilmentPlan: null,
  ...over,
});

const planner: ShopFulfilmentSettings = {
  enabled: true,
  days: [{ date: "2026-11-27", label: "Fri, 27 Nov", slots: [{ key: "2026-11-27@10:00", start: "10:00", end: "10:30", label: "10:00–10:30" }] }],
  staff: [],
};

const card = (row: ShopOrderRow, fulfilment: ShopFulfilmentSettings | null = planner) =>
  renderToStaticMarkup(createElement(ShopOrderManager, { orders: [row], deliveryAvailable: true, fulfilment }));

/** The radio input of a planner option (its `disabled` attribute and the hint next to it). */
function option(html: string, value: string): { disabled: boolean; label: string } {
  const at = html.indexOf(`value="${value}"`);
  if (at < 0) throw new Error(`no ${value} option`);
  const start = html.lastIndexOf("<label", at);
  const end = html.indexOf("</label>", at);
  const label = html.slice(start, end);
  return { disabled: /<input[^>]*\sdisabled=""/.test(label), label };
}

describe("shop order card: a delivery order waiting for the customer's location (QA D-166)", () => {
  it("says it waits for the location; delivery options open, pickup closed", () => {
    const html = card(order({ hasAddress: false, addressPending: true }));
    expect(html).toContain("Waiting for the customer&#x27;s delivery location");
    expect(html).not.toContain("No delivery address on this order.");
    expect(option(html, "GOKESARI_PARTNER").disabled).toBe(false);
    expect(option(html, "PICKUP").disabled).toBe(true);
    expect(option(html, "PICKUP").label).toContain("The customer chose delivery");
  });

  it("an order with no address that is not waiting for one is unchanged (pickup only)", () => {
    const html = card(order({ hasAddress: false }));
    expect(html).toContain("No delivery address on this order.");
    expect(option(html, "PICKUP").disabled).toBe(false);
    expect(option(html, "GOKESARI_PARTNER").disabled).toBe(true);
  });

  it("shows the note on the card when the planner is off (rule fulfilmentOptions off)", () => {
    const html = card(order({ hasAddress: false, addressPending: true }), null);
    expect(html).toContain('data-testid="address-pending-note"');
  });
});
