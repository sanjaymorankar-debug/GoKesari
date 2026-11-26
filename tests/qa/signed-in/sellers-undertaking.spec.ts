/**
 * Seller undertaking: fresh, safe and compliant goods (docs/seller-undertaking-2026-11).
 * Reads the shop owner's status and sends only acceptances the server must refuse, so nothing is
 * recorded for the test account (the full accept → order-accept path is in
 * tests/integration/seller-undertaking.test.ts).
 */
import { as } from "../lib/actors";
import { call, pace } from "../lib/http";
import { expect, qa } from "../lib/record";

qa("TC-SUND-003", "a signed-in shop owner reads their undertaking status: versions, effective date and whether it is required", async () => {
  const res = await call(await as("shop"), "GET", "/api/seller/undertaking");
  expect(res.status, res.text).toBe(200);
  expect(res.body).toMatchObject({
    version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    termsVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    effectiveDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    gateEnabled: expect.any(Boolean),
    accepted: expect.any(Boolean),
    required: expect.any(Boolean),
  });
  // required = gate on and not accepted.
  expect(res.body.required).toBe(res.body.gateEnabled && !res.body.accepted);
  return `version ${res.body.version}, gate ${res.body.gateEnabled ? "on" : "off"}, accepted ${res.body.accepted}`;
}, { tier: "signed" });

qa("TC-SUND-004", "acceptance is refused unless both boxes are explicitly ticked; a user without a shop is refused", async () => {
  const shop = await as("shop");
  const seen: string[] = [];
  for (const body of [{}, { acceptUndertaking: true }, { acceptTerms: true }, { acceptUndertaking: true, acceptTerms: false }]) {
    await pace();
    const res = await call(shop, "POST", "/api/seller/undertaking", body);
    expect(res.status, JSON.stringify(body)).toBe(422);
    seen.push(`${JSON.stringify(body)} → 422`);
  }
  await pace();
  // The rider: on the test site the QA customers have shops of their own from signup checks (26-Nov-2026).
  const noShop = await call(await as("rider"), "GET", "/api/seller/undertaking");
  expect(noShop.status).toBe(403);
  seen.push("rider (no shop) GET → 403");
  return seen.join("; ");
}, { tier: "signed" });
