/**
 * Policy re-consent (docs/policy-reconsent-2026-11). Production-safe: GETs and
 * requests the server must refuse. Nobody accepts anything here.
 */
import { anonymous, call, pace } from "../lib/http";
import { expect, qa } from "../lib/record";

qa("TC-RECONSENT-001", "the re-consent state, acceptance and the admin policy report refuse a caller without a session (401)", async () => {
  const guest = await anonymous();
  const seen: string[] = [];
  try {
    const calls: [string, string, unknown][] = [
      ["GET", "/api/me/policy-consent", undefined],
      ["POST", "/api/me/policy-consent", { accept: [{ doc: "terms", version: "2026-10-24" }] }],
      ["GET", "/api/admin/policy-versions", undefined],
      ["POST", "/api/admin/policy-versions", { doc: "terms", version: "2099-01-01", summary: { en: "x" }, requiresAcceptance: false, reason: "qa" }],
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
