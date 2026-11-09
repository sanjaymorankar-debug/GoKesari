/**
 * Keeps the staging rider on Ready next to shop A while a run goes on. Without a Ready rider in
 * range /api/checkout/delivery-windows offers only SCHEDULED and no order gets a delivery offer.
 * Rule riderZoning stops counting a location after 15 minutes, so it is refreshed well before that.
 *
 * Rule riderVerification keeps a rider without KYC and police papers from going Ready, and the
 * staging rider has none: an admin's override of that gate (the site's own function) lets it.
 */
import { as, me } from "./actors";
import { call, why } from "./http";
import { TARGET } from "./target";
import { world } from "./world";

const REFRESH_MS = 10 * 60_000;
let lastAt = 0;

async function goReady() {
  const { lat, lng } = world().location!;
  return call(await as("rider"), "PATCH", "/api/delivery-partner/status", { action: "ready", latitude: lat + 0.001, longitude: lng + 0.001 });
}

/** Called before signed-in checks on staging. Never fails a check: without a rider the checks say what they miss. */
export async function keepRiderReady() {
  if (TARGET !== "staging" || !world().location || Date.now() - lastAt < REFRESH_MS) return;
  lastAt = Date.now();
  try {
    let res = await goReady();
    if (res.status === 409 && res.body?.error?.details?.missing) {
      const partner = await call(await as("rider"), "GET", "/api/delivery-partner/me");
      const override = await call(await as("admin"), "PATCH", `/api/delivery-partner/${partner.body?.id}`, {
        action: "override_availability",
        enabled: true,
        reason: "QA regression on staging: the test rider has no KYC or police papers",
      });
      if (override.status !== 200) console.error(`[rider-ready] gate override: ${why(override)}`);
      res = await goReady();
    }
    if (res.status !== 200) console.error(`[rider-ready] ${(await me("rider")).email}: ${why(res)}`);
  } catch (error) {
    console.error(`[rider-ready] ${error instanceof Error ? error.message : String(error)}`);
  }
}
