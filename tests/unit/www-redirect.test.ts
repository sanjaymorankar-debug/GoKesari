/**
 * www.gokesari.com and www.test.gokesari.com go to the address without www,
 * the one sign-in is tied to (next.config.ts, WWW_REDIRECTS). Google sign-in
 * started on www kept its PKCE cookie on www and could not finish on the
 * address Google returned to. The rules are run through Next's own matchers,
 * so a host that is not one of ours, /api and /.well-known stay where they are.
 */
import { describe, expect, it } from "vitest";

import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { matchHas } from "next/dist/shared/lib/router/utils/prepare-destination";

import nextConfig from "../../next.config";

type Redirect = Awaited<ReturnType<NonNullable<typeof nextConfig.redirects>>>[number];

/** Where Next sends this request (first matching rule), or null when it is served as is. */
async function redirectFor(path: string, headers: Record<string, string>): Promise<{ to: string; permanent: boolean } | null> {
  const rules = (await nextConfig.redirects?.()) ?? [];
  const req = { headers } as unknown as Parameters<typeof matchHas>[0];
  for (const rule of rules as Redirect[]) {
    const params = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true })(path);
    if (!params) continue;
    if (!matchHas(req, {}, rule.has, rule.missing)) continue;
    const to = rule.destination.replace(/:(\w+)/g, (_, key: string) => String(params[key] ?? ""));
    return { to, permanent: Boolean("permanent" in rule && rule.permanent) };
  }
  return null;
}

const forwarded = (host: string) => ({ host: "127.0.0.1:3000", "x-forwarded-host": host });

describe("www goes to the address without www", () => {
  it("TC-WWW-001 behind Hostinger's proxy: every www page moves, permanently, to the same path", async () => {
    expect(await redirectFor("/", forwarded("www.gokesari.com"))).toEqual({ to: "https://gokesari.com/", permanent: true });
    expect(await redirectFor("/legal/terms", forwarded("www.gokesari.com"))).toEqual({ to: "https://gokesari.com/legal/terms", permanent: true });
    expect(await redirectFor("/cart", forwarded("www.test.gokesari.com"))).toEqual({ to: "https://test.gokesari.com/cart", permanent: true });
    expect((await redirectFor("/signin", forwarded("www.gokesari.com:443")))?.to).toBe("https://gokesari.com/signin");
    expect((await redirectFor("/about", forwarded("www.gokesari.com, 10.0.0.1")))?.to).toBe("https://gokesari.com/about");
    expect((await redirectFor("/apiary", forwarded("www.gokesari.com")))?.to).toBe("https://gokesari.com/apiary");
  });

  it("TC-WWW-002 reached directly (no forwarded host): the Host header decides", async () => {
    expect((await redirectFor("/shops", { host: "www.gokesari.com" }))?.to).toBe("https://gokesari.com/shops");
    expect((await redirectFor("/", { host: "www.test.gokesari.com:443" }))?.to).toBe("https://test.gokesari.com/");
  });

  it("TC-WWW-003 /api and /.well-known stay on www (webhooks, app-link files)", async () => {
    for (const path of ["/api", "/api/auth/callback/google", "/api/webhooks/cashfree", "/.well-known/assetlinks.json", "/.well-known/apple-app-site-association"]) {
      expect(await redirectFor(path, forwarded("www.gokesari.com")), path).toBeNull();
      expect(await redirectFor(path, { host: "www.gokesari.com" }), path).toBeNull();
    }
  });

  it("TC-WWW-004 other hosts are untouched, and the destination never comes from the request", async () => {
    for (const host of ["gokesari.com", "test.gokesari.com", "localhost:3000", "www.evil.com", "www.gokesari.com.evil.com", "evil.com, www.gokesari.com"]) {
      expect(await redirectFor("/shops", forwarded(host)), host).toBeNull();
    }
    // Host says www, the proxy says the address without www: the proxy wins.
    expect(await redirectFor("/shops", { host: "www.gokesari.com", "x-forwarded-host": "gokesari.com" })).toBeNull();
    const rules = (await nextConfig.redirects?.()) ?? [];
    expect(new Set(rules.map((r) => new URL(r.destination.replace("/:path", "/")).origin))).toEqual(
      new Set(["https://gokesari.com", "https://test.gokesari.com"]),
    );
  });
});
