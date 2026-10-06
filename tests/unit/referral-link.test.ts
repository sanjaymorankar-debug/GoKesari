/** F11 — the /r/CODE link redirects with a relative Location (never the internal host) and remembers the code. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/authz/guards", () => ({ getCurrentUser: vi.fn(async () => null) }));

import { NextRequest } from "next/server";

import { GET } from "@/app/r/[code]/route";

describe("referral link", () => {
  it("sends a signed-out visitor to /signin with the code in a cookie", async () => {
    const res = await GET(new NextRequest("https://0.0.0.0:3000/r/gkabc234"), { params: Promise.resolve({ code: "gkabc234" }) });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/signin");
    expect(res.cookies.get("gk_ref")?.value).toBe("GKABC234");
  });
});
