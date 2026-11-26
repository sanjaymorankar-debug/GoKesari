/** F11 — the /r/CODE link redirects with a relative Location (never the internal host) and remembers the code. */
import { describe, expect, it, vi } from "vitest";

const sharing = vi.hoisted(() => ({ on: false }));
vi.mock("@/server/authz/guards", () => ({ getCurrentUser: vi.fn(async () => null) }));
// docs/referral-sharing-2026-11: rule referralSharing (the database-backed path is tests/integration/referral-sharing.test.ts).
vi.mock("@/server/services/referral-links", () => ({
  referralSharingOn: vi.fn(async () => sharing.on),
  logReferralEvent: vi.fn(async () => null),
  landingPathFor: (t: { audience: string }, signedIn: boolean) => (t.audience === "shop-owner" ? "/shop/register" : signedIn ? "/refer" : "/signin"),
  resolveReferralLink: vi.fn(async (code: string) => ({
    code: code.toUpperCase(),
    kind: "CUSTOMER",
    referrerUserId: "u1",
    referrerName: "Asha",
    level: "Customer",
    audience: "customer",
    usable: true,
    outcome: "OK",
    message: null,
  })),
}));

import { NextRequest } from "next/server";

import { GET } from "@/app/r/[code]/route";

describe("referral link", () => {
  it("sends a signed-out visitor to /signin with the code in a cookie (rule referralSharing off: the original route)", async () => {
    sharing.on = false;
    const res = await GET(new NextRequest("https://0.0.0.0:3000/r/gkabc234"), { params: Promise.resolve({ code: "gkabc234" }) });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.cookies.get("gk_ref")?.value).toBe("GKABC234");
  });

  it("does the same with referral sharing on, and remembers the link too", async () => {
    sharing.on = true;
    const res = await GET(new NextRequest("https://0.0.0.0:3000/r/gkabc234?c=wa"), { params: Promise.resolve({ code: "gkabc234" }) });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.cookies.get("gk_ref")?.value).toBe("GKABC234");
    expect(res.cookies.get("gk_ref_link")?.value).toBe("GKABC234");
  });
});
