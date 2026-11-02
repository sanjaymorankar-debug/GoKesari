/**
 * QA D-121 (staging retest, 02-Nov-2026): operations' order list and the
 * shop's order list labelled every order's invoice link "Tax invoice", also
 * when the shop (outside GST) had issued a bill of supply. The link now says
 * what was issued, as the customer's order pages do.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import { OrderMonitoringTable, type MonitoringRow } from "@/components/order-monitoring-table";
import { ShopOrderManager, type ShopOrderRow } from "@/components/shop-order-manager";

const monitoringRow = (invoiceLabel?: string): MonitoringRow => ({
  id: "00000000-0000-0000-0000-000000000001",
  orderNumber: "DB-20261102-ERAAO8",
  shopName: "E2E Four Features Bakery",
  customerName: "QA Customer One",
  status: "DELIVERED",
  totalPaise: 8_500,
  createdAt: new Date("2026-11-02T06:00:00Z"),
  riderName: null,
  deliveryStatus: null,
  invoiceUrl: "/api/orders/00000000-0000-0000-0000-000000000001/invoice",
  invoiceLabel,
});

const shopRow = (invoiceLabel?: string): ShopOrderRow => ({
  id: "00000000-0000-0000-0000-000000000001",
  orderNumber: "DB-20261102-ERAAO8",
  status: "DELIVERED",
  totalPaise: 8_500,
  createdAt: "2026-11-02T06:00:00.000Z",
  items: [],
  deliveryStatus: null,
  pickupCode: null,
  invoiceUrl: "/api/orders/00000000-0000-0000-0000-000000000001/invoice",
  invoiceLabel,
});

const monitoring = (label?: string) => renderToStaticMarkup(createElement(OrderMonitoringTable, { orders: [monitoringRow(label)], canReassign: false }));
const shop = (label?: string) => renderToStaticMarkup(createElement(ShopOrderManager, { orders: [shopRow(label)], deliveryAvailable: false }));

describe("order lists name the invoice by its kind (QA D-121)", () => {
  it.each([
    ["operations' order list", monitoring],
    ["the shop's order list", shop],
  ])("%s", (_name, render) => {
    const bos = render("Bill of supply");
    expect(bos).toContain("Bill of supply");
    expect(bos).not.toContain("Tax invoice");
    expect(render("Tax invoice")).toContain("Tax invoice");
    // Not issued yet: a neutral label.
    expect(render(undefined)).toMatch(/>Invoice</);
  });
});
