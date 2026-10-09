/**
 * Runs the exact script the app injects into website pages against a fake
 * page, so its syntax and behaviour are checked without a device.
 */
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { buildBridgeScript } from "../bridge-script";

const TOKEN = "per-launch-secret";
const script = buildBridgeScript({ siteOrigin: "https://gokesari.com", token: TOKEN, platform: "android", version: "1.2.3" });

type Message = Record<string, unknown> & { type: string; id?: number; token?: string };

function loadPage(origin = "https://gokesari.com") {
  const posted: Message[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const navigator: Record<string, unknown> = {};
  const window: Record<string, unknown> = {
    location: { origin, href: `${origin}/invoices/1` },
    ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) },
  };
  const document = {
    styleSheets: [],
    addEventListener: (type: string, listener: (event: unknown) => void) => (listeners[type] ??= []).push(listener),
  };
  runInNewContext(script, { window, document, navigator, DOMException, URL, Promise, setTimeout });
  const app = window.__gokesariApp as { receive(message: unknown): void; platform: string; version: string } | undefined;
  const last = () => posted[posted.length - 1];
  const click = (href: string, init: Partial<{ defaultPrevented: boolean; download: boolean }> = {}) => {
    const event = {
      defaultPrevented: init.defaultPrevented ?? false,
      button: 0,
      target: { closest: () => ({ href, hasAttribute: () => Boolean(init.download) }) },
      preventDefault: vi.fn(),
    };
    for (const listener of listeners.click ?? []) listener(event);
    return event;
  };
  return { window, navigator: navigator as Record<string, never>, posted, app, last, click };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("injected page bridge", () => {
  it("installs only on the website's own origin", () => {
    const thirdParty = loadPage("https://payments.cashfree.com");
    expect(thirdParty.app).toBeUndefined();
    expect(thirdParty.posted).toEqual([]);

    const page = loadPage();
    expect(page.app).toMatchObject({ platform: "android", version: "1.2.3" });
    expect(page.posted).toEqual([{ type: "hello", token: TOKEN }]);
  });

  it("quotes the per-launch secret on every message", async () => {
    const page = loadPage();
    void (page.navigator.share as (d: unknown) => Promise<void>)({ text: "hi" });
    (page.navigator.geolocation as { watchPosition: (s: () => void) => number }).watchPosition(() => {});
    await flush();
    expect(page.posted.every((m) => m.token === TOKEN)).toBe(true);
  });

  it("shares through the native sheet, and a dismissed sheet is an AbortError", async () => {
    const page = loadPage();
    const share = page.navigator.share as (data: unknown) => Promise<void>;

    const done = share({ title: "List your shop", text: "Join", url: "https://gokesari.com/shop/register" });
    expect(page.last()).toMatchObject({ type: "share", title: "List your shop", text: "Join", url: "https://gokesari.com/shop/register" });
    page.app!.receive({ type: "reply", id: page.last().id, result: true });
    await expect(done).resolves.toBeUndefined();

    const cancelled = share({ text: "x" });
    page.app!.receive({ type: "reply", id: page.last().id, error: { name: "AbortError", message: "Share cancelled." } });
    const error = await cancelled.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("answers getCurrentPosition with a browser-shaped position or error", async () => {
    const page = loadPage();
    const geo = page.navigator.geolocation as {
      getCurrentPosition(ok: (p: unknown) => void, fail: (e: unknown) => void, options?: unknown): void;
    };

    const ok = vi.fn();
    geo.getCurrentPosition(ok, vi.fn(), { enableHighAccuracy: true, timeout: 10_000, maximumAge: 300_000 });
    expect(page.last()).toMatchObject({
      type: "geo.current",
      options: { enableHighAccuracy: true, timeout: 10_000, maximumAge: 300_000 },
    });
    page.app!.receive({
      type: "reply",
      id: page.last().id,
      result: { latitude: 18.52, longitude: 73.85, accuracy: 12, heading: -1, speed: null, timestamp: 1 },
    });
    await flush();
    expect(ok).toHaveBeenCalledWith(
      expect.objectContaining({
        coords: expect.objectContaining({ latitude: 18.52, longitude: 73.85, accuracy: 12, heading: null, speed: null }),
        timestamp: 1,
      }),
    );

    const fail = vi.fn();
    geo.getCurrentPosition(vi.fn(), fail);
    page.app!.receive({ type: "reply", id: page.last().id, error: { code: 1, message: "denied" } });
    await flush();
    const error = fail.mock.calls[0][0];
    // The rider dashboard compares err.code with err.PERMISSION_DENIED.
    expect(error.code).toBe(error.PERMISSION_DENIED);
  });

  it("streams watchPosition fixes until cleared", () => {
    const page = loadPage();
    const geo = page.navigator.geolocation as {
      watchPosition(ok: (p: unknown) => void, fail?: (e: unknown) => void): number;
      clearWatch(id: number): void;
    };
    const ok = vi.fn();
    const fail = vi.fn();
    const watchId = geo.watchPosition(ok, fail);
    expect(page.last()).toMatchObject({ type: "geo.watch", watchId });

    page.app!.receive({ type: "position", watchId, fix: { latitude: 1, longitude: 2, timestamp: 3 } });
    page.app!.receive({ type: "position", watchId, error: { code: 2, message: "off" } });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0]).toMatchObject({ code: 2, POSITION_UNAVAILABLE: 2 });

    geo.clearWatch(watchId);
    expect(page.last()).toMatchObject({ type: "geo.clearWatch", watchId });
    page.app!.receive({ type: "position", watchId, fix: { latitude: 1, longitude: 2, timestamp: 4 } });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("sends taps on links to other sites outside the app, and nothing else", () => {
    const page = loadPage();

    const external = page.click("https://example.com/price-list");
    expect(external.preventDefault).toHaveBeenCalled();
    expect(page.last()).toMatchObject({ type: "openExternal", url: "https://example.com/price-list" });

    const before = page.posted.length;
    for (const event of [
      page.click("https://gokesari.com/orders"),
      page.click("tel:+919800000000"),
      page.click("https://example.com/x", { defaultPrevented: true }),
      page.click("https://example.com/file.pdf", { download: true }),
    ]) {
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(page.posted.length).toBe(before);
  });

  it("does not install twice on the same page", () => {
    const page = loadPage();
    runInNewContext(script, { window: page.window, document: { addEventListener() {} }, navigator: {}, DOMException, URL, Promise, setTimeout });
    expect(page.posted.filter((m) => m.type === "hello")).toHaveLength(1);
  });
});
