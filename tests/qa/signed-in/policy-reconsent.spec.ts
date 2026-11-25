/**
 * Policy re-consent as a signed-in user and an admin sees it
 * (docs/policy-reconsent-2026-11). Read-only: nothing is accepted or published.
 */
import { as } from "../lib/actors";
import { call, expectStatus } from "../lib/http";
import { expect, qa } from "../lib/record";

const signed = { tier: "signed" as const };

qa("TC-RECONSENT-002", "a customer reads their re-consent state; with the flag off nothing is pending", async () => {
  const res = await call(await as("customer"), "GET", "/api/me/policy-consent");
  expectStatus(res, 200, "GET /api/me/policy-consent");
  const body = res.body as { enabled: boolean; needsReconsent: boolean; pending: { doc: string; version: string }[] };
  expect(typeof body.enabled).toBe("boolean");
  expect(Array.isArray(body.pending)).toBe(true);
  if (!body.enabled) expect(body.needsReconsent).toBe(false);
  expect(body.needsReconsent).toBe(body.pending.length > 0);
  return `enabled ${body.enabled}, pending ${body.pending.map((p) => `${p.doc} ${p.version}`).join(", ") || "none"}`;
}, signed);

qa("TC-RECONSENT-003", "only staff with the consent permission read the policy acceptance report; a customer cannot publish", async () => {
  const customer = await as("customer");
  expect((await call(customer, "GET", "/api/admin/policy-versions")).status).toBe(403);
  const publish = await call(customer, "POST", "/api/admin/policy-versions", {
    doc: "terms",
    version: "2099-01-01",
    summary: { en: "qa" },
    requiresAcceptance: false,
    reason: "qa",
  });
  expect(publish.status).toBe(403);
  const report = await call(await as("admin"), "GET", "/api/admin/policy-versions");
  expectStatus(report, 200, "admin report");
  const docs = (report.body as { documents: { doc: string; audience: number }[] }).documents;
  expect(docs.map((d) => d.doc).sort()).toEqual(["privacy-policy", "seller-terms", "terms"]);
  return docs.map((d) => `${d.doc}: audience ${d.audience}`).join("; ");
}, signed);
