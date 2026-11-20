/**
 * Release R2 (19-Nov-2026), the parts that need no database:
 * D-131 / D-109 — which Seller Central paths need sign-in, the packing-slip id, and the proxy
 *   handing the page's path to the layouts (never a path the caller chose);
 * D-142 — an /operator link for an admin or full operator goes to the matching admin page;
 * D-139 — a "Verified" board entry reads "Not verified" when the record is not verified.
 */
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { boardItemLabel } from "@/components/board/tiles";
import { L } from "@/lib/board/i18n";
import type { BoardItem, Resolved } from "@/lib/board/menus";
import { operatorPortalFallback } from "@/lib/operator-portal";
import { packingSlipOrderId, REQUEST_PATH_HEADER, shopPageNeedsSignIn } from "@/lib/request-path";
import { proxy } from "@/proxy";

const ID = "6f1c1f0e-2b7a-4d47-9c1e-0e4a3b2c1d00";

describe("D-131: Seller Central pages that send a signed-out visitor to sign in", () => {
  it.each(["/shop", "/shop/orders", `/shop/orders/${ID}/packing-slip`, "/shop/accounts/sales", "/shop/inventory"])("%s needs sign-in", (path) => {
    expect(shopPageNeedsSignIn(path)).toBe(true);
  });
  it.each(["/shop/register", "/shop/register/", "/shop/join", "/shop/join/abc123", "/shops", "/shops/my-shop", "/", "/wallet"])("%s does not", (path) => {
    expect(shopPageNeedsSignIn(path)).toBe(false);
  });
});

describe("D-109: the order id of a packing-slip page", () => {
  it("reads the id from the slip's path only", () => {
    expect(packingSlipOrderId(`/shop/orders/${ID}/packing-slip`)).toBe(ID);
    expect(packingSlipOrderId(`/shop/orders/${ID}/packing-slip/`)).toBe(ID);
    expect(packingSlipOrderId(`/shop/orders/${ID}`)).toBeNull();
    expect(packingSlipOrderId("/shop/orders")).toBeNull();
    expect(packingSlipOrderId(`/admin/orders/${ID}/packing-slip`)).toBeNull();
  });
});

describe("proxy: the page's path for the layouts", () => {
  const forwarded = (res: Response) => res.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`);

  it("passes a page's path on", () => {
    expect(forwarded(proxy(new NextRequest(`https://gokesari.test/shop/orders/${ID}/packing-slip`)))).toBe(`/shop/orders/${ID}/packing-slip`);
  });
  it("overwrites a path the caller sent", () => {
    const res = proxy(new NextRequest("https://gokesari.test/shop", { headers: { [REQUEST_PATH_HEADER]: "/shop/register" } }));
    expect(forwarded(res)).toBe("/shop");
  });
  it("leaves API calls alone", () => {
    expect(forwarded(proxy(new NextRequest("https://gokesari.test/api/shops")))).toBeNull();
  });
});

describe("D-142: an /operator link for someone who is not a limited operator", () => {
  it("staff go to the matching admin page; everyone else home", () => {
    expect(operatorPortalFallback("ADMIN", "/admin/shops")).toBe("/admin/shops");
    expect(operatorPortalFallback("OPERATOR", "/admin/document-uploads")).toBe("/admin/document-uploads");
    expect(operatorPortalFallback("CUSTOMER", "/admin/shops")).toBe("/");
    expect(operatorPortalFallback("SHOP_OWNER", "/admin/shops")).toBe("/");
  });
});

describe("D-139: a status entry on the board shows the real status", () => {
  const verified = {
    key: "verified",
    label: L("Verified", "सत्यापित", "पडताळलेले"),
    href: "/shop/bank-account",
    tick: "bankVerified",
  } as unknown as Resolved<BoardItem>;

  it("says Not verified when the bank account is not verified", () => {
    expect(boardItemLabel(verified, "en", { bankVerified: false })).toBe("Not verified");
    expect(boardItemLabel(verified, "mr", { bankVerified: false })).toBe("पडताळलेले नाही");
  });
  it("keeps Verified when it is, or when the state is not known", () => {
    expect(boardItemLabel(verified, "en", { bankVerified: true })).toBe("Verified");
    expect(boardItemLabel(verified, "en", {})).toBe("Verified");
    expect(boardItemLabel(verified, "en")).toBe("Verified");
  });
});
