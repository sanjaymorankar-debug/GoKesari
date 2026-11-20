/**
 * D-140 retest (R2, PR #416) with a rider made for it: an approved delivery
 * partner who has not done KYC nor the police verification reads
 * "You're approved — finish 2 more checks below to start delivering: …"
 * (src/app/delivery-partner/page.tsx statusMessage, getAvailabilityGate).
 *
 * Local tier: a new account applies as a rider and operations approve it (as
 * tests/qa/local/orders-riders.spec.ts does); rule riderVerification keeps its
 * gate on (the default) for the check and is restored.
 */
import { ruleValue, withRule } from "../lib/auth-helpers";
import { freshPage, freshRider } from "../lib/orders-helpers";
import { expect, qa } from "../lib/record";

qa("TC-RGR-010", "D-140: an approved rider with KYC and police verification outstanding reads 'You're approved — finish 2 more checks below to start delivering: …'", async ({ browser }) => {
  return withRule("riderVerification", { gateAvailability: true }, async () => {
    const rule = await ruleValue("riderVerification");
    const police = rule.requireCharacterCertificate ? "police verification form and character certificate approved" : "police verification form approved";
    const expected = `You're approved — finish 2 more checks below to start delivering: PAN and Aadhaar verified (KYC); ${police}.`;
    const rider = await freshRider("d140", { approve: true });
    const { context, page } = await freshPage(browser, rider);
    try {
      await page.goto("/delivery-partner");
      await expect(page.getByRole("heading", { name: "My Delivery Partner Application" })).toBeVisible();
      await expect(page.getByText(expected, { exact: true })).toBeVisible();
      await expect(page.getByText("You're approved as a delivery partner.", { exact: true }), "not the bare 'approved' line").toHaveCount(0);
      return `new approved rider, no KYC, no police verification: "${expected}"`;
    } finally {
      await context.close();
      await rider.ctx.dispose();
    }
  });
}, { tier: "local", timeout: 240_000 });
