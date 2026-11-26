/**
 * docs/silent-update-2026-11: the rules behind silent website updates
 * (src/lib/app-update-policy.ts).
 */
import { describe, expect, it } from "vitest";

import {
  canApplyUpdate,
  CHUNK_RELOAD_WINDOW_MS,
  isChunkLoadError,
  isSensitivePath,
  mayRecoverFromChunkError,
  mustClearUserData,
} from "@/lib/app-update-policy";

describe("isSensitivePath", () => {
  it.each(["/cart", "/orders/pay/sandbox/abc", "/orders/payment-return", "/wallet", "/wallet/topup", "/onboarding/shop", "/sell", "/shop/billing", "/signin", "/franchise/buy"])(
    "never switches on its own on %s",
    (path) => expect(isSensitivePath(path)).toBe(true),
  );
  it.each(["/", "/search", "/shops/abc", "/orders", "/orders/123", "/profile", "/admin", "/shop/manage/products", "/cartoons"])("may switch on %s", (path) =>
    expect(isSensitivePath(path)).toBe(false),
  );
});

describe("canApplyUpdate", () => {
  it("switches on a calm page", () => {
    expect(canApplyUpdate({ pathname: "/", dirty: false, paymentOpen: false })).toBe(true);
  });
  it("waits while a form is being filled, a payment window is open, or on checkout", () => {
    expect(canApplyUpdate({ pathname: "/profile", dirty: true, paymentOpen: false })).toBe(false);
    expect(canApplyUpdate({ pathname: "/orders/1", dirty: false, paymentOpen: true })).toBe(false);
    expect(canApplyUpdate({ pathname: "/cart", dirty: false, paymentOpen: false })).toBe(false);
  });
});

describe("isChunkLoadError", () => {
  it("knows webpack, Chrome, Safari and Firefox wordings", () => {
    const named = new Error("Loading chunk 123 failed.");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("Loading CSS chunk app-layout failed"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/_next/static/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError("error loading dynamically imported module")).toBe(true);
  });
  it("ignores everything else", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("mayRecoverFromChunkError", () => {
  it("reloads once, then not again within the window (no loop)", () => {
    const now = 1_000_000_000;
    expect(mayRecoverFromChunkError(null, now)).toBe(true);
    expect(mayRecoverFromChunkError(String(now - 1000), now)).toBe(false);
    expect(mayRecoverFromChunkError(String(now - CHUNK_RELOAD_WINDOW_MS - 1), now)).toBe(true);
    expect(mayRecoverFromChunkError("garbage", now)).toBe(true);
  });
});

describe("mustClearUserData", () => {
  it("clears after sign-out and when another account signs in", () => {
    expect(mustClearUserData("u1", "guest")).toBe(true);
    expect(mustClearUserData("u1", "u2")).toBe(true);
  });
  it("keeps data for the same account, a first visit, and a guest who signs in", () => {
    expect(mustClearUserData("u1", "u1")).toBe(false);
    expect(mustClearUserData(null, "u1")).toBe(false);
    expect(mustClearUserData("guest", "u1")).toBe(false);
  });
});
