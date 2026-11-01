/**
 * App install prompt (docs/app-install-2026-10): the signed-in person's record
 * holds across devices. Signed-in tier (staging customer and the local server);
 * it writes only the customer's own app_install_states row — a decline count
 * and an install platform, harmless and expected to change in use.
 */
import { as } from "../lib/actors";
import { anonymous, call, expectStatus } from "../lib/http";
import { expect, qa } from "../lib/record";

qa("TC-APP-008", "decline and install are kept on the signed-in account; signed out every call is refused", async () => {
  const customer = await as("customer");
  const guest = await anonymous();
  try {
    const before = await call(customer, "GET", "/api/app-install");
    expectStatus(before, 200, "GET /api/app-install");
    for (let i = 0; i < 2; i++) expectStatus(await call(customer, "POST", "/api/app-install", { event: "declined", platform: "android" }), 200, "decline");
    expectStatus(await call(customer, "POST", "/api/app-install", { event: "installed", platform: "android" }), 200, "install");
    const after = await call(customer, "GET", "/api/app-install");
    expect(after.body.declineCount).toBe(before.body.declineCount + 2);
    expect(after.body.installedPlatforms).toContain("android");
    expectStatus(await call(customer, "POST", "/api/app-install", { event: "forever", platform: "android" }), 422, "unknown event");
    expectStatus(await call(guest, "GET", "/api/app-install"), 401, "guest GET");
    expectStatus(await call(guest, "POST", "/api/app-install", { event: "declined", platform: "ios" }), 401, "guest POST");
    // Put the platform back so the prompt keeps showing to this test account in a browser.
    expectStatus(await call(customer, "POST", "/api/app-install", { event: "uninstalled", platform: "android" }), 200, "restore");
    return `declines ${before.body.declineCount} → ${after.body.declineCount}; installed ${JSON.stringify(after.body.installedPlatforms)}; guest 401`;
  } finally {
    await guest.dispose();
  }
}, { tier: "signed" });
