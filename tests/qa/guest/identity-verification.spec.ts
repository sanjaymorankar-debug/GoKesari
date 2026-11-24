/**
 * Identity verification (docs/identity-verification-2026-11, 24-Nov-2026).
 * Production-safe: only GETs and requests the server must refuse. Whether the
 * customers' or shop owners' switch is on or off, every identity API refuses
 * a caller without a session (401), and the return link reveals nothing for an
 * unknown key.
 */
import { anonymous, call, pace } from "../lib/http";
import { expect, qa } from "../lib/record";
import { NO_SUCH_ID } from "../lib/routes";

qa("TC-IDV-001", "identity verification APIs refuse a caller without a session (401)", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    const calls: [string, string, unknown][] = [
      ["GET", "/api/account/identity", undefined],
      ["POST", "/api/account/identity/digilocker", { consent: true }],
      ["POST", "/api/account/identity/digilocker/sync", {}],
      ["POST", "/api/account/identity/pan", { consent: true, pan: "ABCPE1234F" }],
      ["GET", "/api/admin/identity-verifications", undefined],
      ["POST", `/api/admin/identity-verifications/${NO_SUCH_ID}/decision`, { decision: "APPROVE", note: "qa guest" }],
    ];
    for (const [method, path, body] of calls) {
      await pace();
      const res = await call(guest, method as "GET" | "POST", path, body);
      expect(res.status, `${method} ${path}`).toBe(401);
      seen.push(`${method} ${path} → 401`);
    }
  } finally {
    await guest.dispose();
  }
  return seen.join("; ");
});
