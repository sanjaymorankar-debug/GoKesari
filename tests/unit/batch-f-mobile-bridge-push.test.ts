/** batch-2026-10 WS-F (F13.1.2): the website side of push registration in the app. */
import { describe, expect, it, vi } from "vitest";

import { isAppPushRegistration, registerAppPushToken } from "@/lib/mobile-bridge-push";

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
}

const registration = { token: "ExponentPushToken[abc]", platform: "android", appVariant: "production", deviceId: null, deviceName: "Pixel" };

describe("web side of the push bridge", () => {
  it("TC-B26-F-070 does nothing in a normal browser or an older app without push", async () => {
    const fetchImpl = vi.fn();
    expect(await registerAppPushToken("u1", { win: {}, fetchImpl, storage: memoryStorage() })).toBe("not-in-app");
    expect(await registerAppPushToken("u1", { win: { __gokesariApp: { platform: "android" } }, fetchImpl, storage: memoryStorage() })).toBe(
      "unsupported",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("TC-B26-F-071 asks the app once per person per session and posts the token to /api/push-tokens", async () => {
    const storage = memoryStorage();
    const getPushToken = vi.fn(async () => registration);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const win = { __gokesariApp: { getPushToken } };
    expect(await registerAppPushToken("u1", { win, fetchImpl: fetchImpl as unknown as typeof fetch, storage })).toBe("registered");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/push-tokens",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token: registration.token, platform: "android", appVariant: "production", deviceId: null, deviceName: "Pixel" }) }),
    );
    expect(await registerAppPushToken("u1", { win, fetchImpl: fetchImpl as unknown as typeof fetch, storage })).toBe("already");
    expect(getPushToken).toHaveBeenCalledTimes(1);
    // Another person signing in on the same phone registers again.
    expect(await registerAppPushToken("u2", { win, fetchImpl: fetchImpl as unknown as typeof fetch, storage })).toBe("registered");
  });

  it("TC-B26-F-072 a refused permission or a bad answer is not sent; a server error is retried next time", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const denied = { __gokesariApp: { getPushToken: async () => Promise.reject({ name: "NotAllowedError" }) } };
    expect(await registerAppPushToken("u1", { win: denied, fetchImpl: fetchImpl as unknown as typeof fetch, storage })).toBe("denied");
    const junk = { __gokesariApp: { getPushToken: async () => ({ token: "nope" }) } };
    expect(await registerAppPushToken("u1", { win: junk, fetchImpl: fetchImpl as unknown as typeof fetch, storage })).toBe("denied");
    expect(fetchImpl).not.toHaveBeenCalled();
    const ok = { __gokesariApp: { getPushToken: async () => registration } };
    expect(await registerAppPushToken("u1", { win: ok, fetchImpl: fetchImpl as unknown as typeof fetch, storage })).toBe("failed");
    expect(storage.map.size).toBe(0);
    expect(isAppPushRegistration(registration)).toBe(true);
    expect(isAppPushRegistration({ ...registration, platform: "web" })).toBe(false);
  });
});
