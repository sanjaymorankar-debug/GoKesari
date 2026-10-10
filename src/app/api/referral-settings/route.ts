/**
 * Whether a referral code is mandatory or optional right now, for the
 * registration forms and the mobile app (docs/nearby-referral-2026-10,
 * feature 2). Public and read-only: the values only, never who changed them.
 * The registration endpoints enforce the setting themselves.
 *
 * GET → { customer: "MANDATORY" | "OPTIONAL", shop: "MANDATORY" | "OPTIONAL" }
 */
import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { getReferralSettings } from "@/server/services/referral-settings";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const settings = await getReferralSettings();
  return NextResponse.json(
    { customer: settings.referral_required_customer.value, shop: settings.referral_required_shop.value },
    { headers: { "cache-control": "no-store" } },
  );
});
