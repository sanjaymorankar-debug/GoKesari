/**
 * Page and field fixes from the QA run of 24 Oct 2026 (tests/qa money-*):
 * each case names the TC ID whose run found the gap. The server halves of
 * these are in tests/integration/qa-2026-10-24-money-fixes.test.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

import { CartView } from "@/components/cart-view";
import { WalletView } from "@/components/wallet-view";
import { PAY_BUTTON_LABELS, payButtonLabel } from "@/lib/checkout-payment";
import { addDays, isCalendarDate, todayIn } from "@/lib/dates";
import { getEnv } from "@/lib/env";
import { RUPEE_DECIMALS_MESSAGE, parseRupeeInput } from "@/lib/rupee-input";
import { subscriptionQuantityMax, subscriptionQuantityProblem, subscriptionQuantityStep } from "@/lib/subscription-quantity";
import { isoDateSchema, todayOrLaterDateSchema } from "@/server/api/date-schema";

describe("TC-FLD-030: the wallet amount box takes at most two decimals (shared parseRupeeInput)", () => {
  // What /wallet and the shop wallet recharge accept: a positive amount with at most two decimals.
  const accepted = (typed: string) => {
    const parsed = parseRupeeInput(typed);
    return parsed.ok === true && parsed.paise > 0 ? parsed.paise : null;
  };
  it.each([
    ["70.50", 7050],
    ["70.5", 7050],
    ["1", 100],
    ["100000", 10_000_000],
    ["0.99", 99],
    [" 25 ", 2500],
  ])("%s → %i paise", (typed, paise) => {
    expect(accepted(typed)).toBe(paise);
  });
  it.each(["10.555", "0", "-5", "", "abc", "1e3", "0.00", "1,000"])("refuses %j (nothing is rounded and charged)", (typed) => {
    expect(accepted(typed)).toBeNull();
  });
  it("10.555 gets the decimals message", () => {
    expect(parseRupeeInput("10.555")).toEqual({ ok: false, error: RUPEE_DECIMALS_MESSAGE });
  });
});

describe("TC-FLD-108 / TC-FLD-109: one shared date schema for the subscription routes", () => {
  it("accepts only real calendar dates written YYYY-MM-DD", () => {
    for (const ok of ["2026-10-24", "2028-02-29", "2026-12-31"]) expect(isCalendarDate(ok), ok).toBe(true);
    for (const bad of ["2026-02-31", "2027-02-29", "2026-13-01", "2026-00-10", "", "tomorrow", "next friday", "24-10-2026"]) {
      expect(isCalendarDate(bad), bad).toBe(false);
      expect(isoDateSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("a start date may be today or later, never yesterday", () => {
    const today = todayIn(getEnv().APP_TIMEZONE);
    expect(todayOrLaterDateSchema.safeParse(today).success).toBe(true);
    expect(todayOrLaterDateSchema.safeParse(addDays(today, 3)).success).toBe(true);
    const past = todayOrLaterDateSchema.safeParse(addDays(today, -1));
    expect(past.success).toBe(false);
    expect(past.error?.issues.map((i) => i.message)).toEqual(["The date cannot be in the past."]);
    expect(todayOrLaterDateSchema.safeParse("").error?.issues.map((i) => i.message)).toEqual(["Enter a real date as YYYY-MM-DD."]);
  });
});

describe("TC-FLD-107: subscription quantities follow the page's step and maximum", () => {
  it("litres and kilograms move in halves up to 50; packs one at a time up to 50 packs", () => {
    expect(subscriptionQuantityStep("L", 1000)).toBe(500);
    expect(subscriptionQuantityStep("kg", 1000)).toBe(500);
    expect(subscriptionQuantityStep("piece", 1000)).toBe(1000);
    expect(subscriptionQuantityMax("L", 1000)).toBe(50_000);
    expect(subscriptionQuantityMax("pack", 500)).toBe(25_000);
  });
  it("refuses off-step, too small and too large amounts with a message the page can show", () => {
    for (const ok of [500, 1000, 2500, 50_000]) expect(subscriptionQuantityProblem(ok, "L", 1000), String(ok)).toBeNull();
    for (const bad of [2300, 250, 0, 50_500, 100_000, 1.5]) {
      expect(subscriptionQuantityProblem(bad, "L", 1000), String(bad)).toMatch(/steps of 0.5 L, from 0.5 L to 50 L/);
    }
    expect(subscriptionQuantityProblem(1500, "piece", 1000)).toMatch(/steps of 1 piece/);
  });
});

describe("cart: the pay button and the payment radios", () => {
  it("the button names the chosen method", () => {
    expect(payButtonLabel("ONLINE")).toBe("Pay online");
    expect(payButtonLabel("COD")).toBe("Place order — pay cash on delivery");
    expect(payButtonLabel("WALLET")).toBe("Pay from wallet");
    expect(payButtonLabel("ONLINE", true)).toBe("Placing order…");
    expect(new Set(Object.values(PAY_BUTTON_LABELS)).size).toBe(3);
  });

  it("'Pay with' is a fieldset with a legend, so each radio is named by its own label only", () => {
    const html = renderToStaticMarkup(
      createElement(CartView, {
        cart: {
          cartId: "c",
          groups: [
            {
              shop: {
                id: "s",
                name: "Dairy",
                slug: "dairy",
                classification: "KESARI",
                deliveryAvailable: true,
                deliveryFeePaise: 0,
                freeDeliveryAbovePaise: null,
                status: "APPROVED",
                openingHours: null,
              },
              lines: [
                {
                  cartItemId: "i",
                  shopProductId: "p",
                  productName: "Cow Milk",
                  categoryName: "Milk",
                  department: "DAIRY",
                  unit: "L",
                  unitSizeMilli: 1000,
                  imageUrl: null,
                  quantity: 1,
                  unitPricePaise: 7000,
                  lineTotalPaise: 7000,
                  purchasable: true,
                  unavailableReason: null,
                },
              ],
              subtotalPaise: 7000,
              deliveryFeePaise: 0,
              taxPaise: 0,
              totalPaise: 7000,
            },
          ],
          itemCount: 1,
          subtotalPaise: 7000,
          deliveryFeePaise: 0,
          taxPaise: 0,
          grandTotalPaise: 7000,
          hasUnavailableItems: false,
        } as never,
        walletBalancePaise: 100_000,
        addresses: [{ id: "a", label: null, line1: "2 Test Lane", area: null, city: "Pune", pincode: "411001", isDefault: true }],
        onlinePaymentsEnabled: true,
      }),
    );
    const block = html.slice(html.lastIndexOf("<fieldset", html.indexOf('data-testid="payment-method"')));
    const fieldset = block.slice(0, block.indexOf("</fieldset>"));
    expect(fieldset.startsWith("<fieldset")).toBe(true);
    expect(fieldset).toContain("<legend");
    expect(fieldset).toContain("Pay with");
    // Three labels, one radio each — none wraps the others.
    const labels = fieldset.split("<label").slice(1).map((l) => l.slice(0, l.indexOf("</label>")));
    expect(labels).toHaveLength(3);
    for (const label of labels) expect(label.match(/type="radio"/g)).toHaveLength(1);
    expect(html).toContain("Pay from wallet");
  });
});

describe("TC-PAY-002 (phone): the wallet page cannot grow wider than the screen", () => {
  it("the columns are minmax(0, 1fr) / min-w-0, so a long description truncates instead of widening 'Add money'", () => {
    const html = renderToStaticMarkup(
      createElement(WalletView, {
        balancePaise: 1000,
        promotionalBalancePaise: 0,
        lowBalanceThresholdPaise: 0,
        todaysDeductionPaise: 0,
        forecast: { horizonDays: 15, upcomingCostPaise: 0, sufficient: true, recommendedTopUpPaise: 0 } as never,
        transactions: [
          { id: "t", type: "REFUND", amountPaise: 100, newBalancePaise: 1000, description: "Refund: ".padEnd(400, "x"), createdAt: new Date().toISOString() },
        ],
      }),
    );
    const root = html.match(/^<div class="([^"]+)"/)![1].split(" ");
    expect(root).toEqual(expect.arrayContaining(["grid", "grid-cols-1", "lg:grid-cols-[minmax(0,1fr)_22rem]"]));
    expect(root).not.toContain("lg:grid-cols-[1fr_22rem]");
    // Both columns may shrink below their content.
    const columns = [...html.matchAll(/<div class="(min-w-0[^"]*)"/g)].map((m) => m[1]);
    expect(columns.some((c) => c.includes("space-y-6"))).toBe(true);
    expect(columns.some((c) => c.includes("lg:sticky"))).toBe(true);
    expect(html).toMatch(/class="truncate [^"]*"[^>]*>Refund: x+/);
  });
});
