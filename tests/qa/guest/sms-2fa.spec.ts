/**
 * SMS sign-in code and checkout code (docs/sms-2fa-2026-11). Production-safe:
 * only GETs and requests the server must refuse; nothing is sent.
 */
import { anonymous, call, pace, type Method } from "../lib/http";
import { expect, qa } from "../lib/record";

qa("TC-SMS2FA-Q01", "the checkout code and Sign-in security APIs refuse a caller without a session (401)", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    const calls: [string, string, unknown][] = [
      ["GET", "/api/checkout/otp", undefined],
      ["POST", "/api/checkout/otp", {}],
      ["POST", "/api/checkout/otp/verify", { code: "123456" }],
      ["GET", "/api/admin/sign-in-security", undefined],
      ["PUT", "/api/admin/sign-in-security", { kind: "audience", audience: "customers", enabled: true, reason: "qa guest probe" }],
    ];
    for (const [method, path, body] of calls) {
      await pace();
      const res = await call(guest, method as Method, path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      seen.push(`${method} ${path} → 401`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});

qa("TC-SMS2FA-Q02", "the SMS step page without a pending sign-in says it expired and links back to sign-in", async () => {
  const guest = await anonymous();
  try {
    const res = await call(guest, "GET", "/signin/second-factor");
    expect(res.status).toBe(200);
    expect(res.text).toContain("expired");
    return "GET /signin/second-factor → 200, expired notice";
  } finally {
    await guest.dispose();
  }
});
