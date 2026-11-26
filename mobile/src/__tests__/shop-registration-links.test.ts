/** 1.14.0 — registration subscription pushes open the shop's registration pages in the app. */
import { describe, expect, it } from "vitest";

import { deepLinkKind } from "../deep-links";

const SITE = "https://gokesari.com";

describe("shop registration links (1.14.0)", () => {
  it("fee page, registration page and receipts are shop-registration routes", () => {
    expect(deepLinkKind(`${SITE}/shop/registration-fee?shop=1f0e`, SITE)).toBe("shop-registration");
    expect(deepLinkKind(`${SITE}/shop/manage/registration?shop=1f0e`, SITE)).toBe("shop-registration");
    expect(deepLinkKind(`${SITE}/shop/membership/receipt/1f0e`, SITE)).toBe("shop-registration");
  });
  it("Add my shop stays shop-register", () => {
    expect(deepLinkKind(`${SITE}/shop/register?ref=SHOPAB2CD`, SITE)).toBe("shop-register");
  });
});
