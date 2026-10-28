/** Public shop search (§15) and shop registration (§8). */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { SHOP_TYPE_KEY_PATTERN } from "@/lib/shop-types";
import { NextResponse } from "next/server";

import { ok, parseBody, route } from "@/server/api/handler";
import { requirePermission } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRule } from "@/server/services/settings";
import { registerShop, searchShops, toShopView } from "@/server/services/shops";
import { assertRegistrationReferralCode, attributeRegistrationReferral } from "@/server/services/referral-requests";
import { recordShopAttributionSafely } from "@/server/dealers/attribution";
import { shopRegisterSchema } from "@/server/services/shop-register-schema";

export const dynamic = "force-dynamic";

/** Short in-memory cache keyed by query string: repeated identical searches skip the DB. */
const SEARCH_TTL_MS = 60_000;
const searchCache = new Map<string, { at: number; body: unknown }>();
const CACHE_HEADERS = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" };

export const GET = route(async (request: NextRequest) => {
  const url = new URL(request.url);
  // Search results are public, so anonymous requests are cacheable by the CDN too.
  const anonymous = !request.headers.get("cookie") && !request.headers.get("authorization");
  const cacheKey = url.searchParams.toString();
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) {
    return NextResponse.json(hit.body, { headers: anonymous ? CACHE_HEADERS : undefined });
  }
  const p = url.searchParams;
  const type = p.get("type");
  // Search is public: the service returns only APPROVED shops, and only
  // their public card columns.
  const body = await searchShops({
      query: p.get("q") ?? undefined,
      city: p.get("city") ?? undefined,
      area: p.get("area") ?? undefined,
      pincode: p.get("pincode") ?? undefined,
      shopType: type && SHOP_TYPE_KEY_PATTERN.test(type) ? type : undefined,
      classification: (p.get("classification") as "KESARI" | "GREEN") ?? undefined,
      deliveryOnly: p.get("delivery") === "true",
      limit: Number(p.get("limit") ?? 24),
      offset: Number(p.get("offset") ?? 0),
  });
  if (searchCache.size > 200) searchCache.clear();
  searchCache.set(cacheKey, { at: Date.now(), body });
  return NextResponse.json(body, { headers: anonymous ? CACHE_HEADERS : undefined });
});

// Shared with dealer-assisted registration (docs/dealer-programme), which must validate exactly the same way.
const registerSchema = shopRegisterSchema;

/**
 * 201 for a new registration; 200 when the caller's own rejected registration
 * of the same shop was updated and sent back for review (`resubmitted: true`).
 * 409 CONFLICT (details.reason "DUPLICATE_SHOP") when the shop is already
 * registered — see services/shop-duplicates.ts.
 */
export const POST = route(async (request: NextRequest) => {
  const user = await requirePermission(PERMISSIONS.SHOP_CREATE);
  const body = await parseBody(request, registerSchema);

  const privileged = can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE);
  // Referral code (docs/four-features-2026-10): with rule shopReferral.required a
  // self-service registration needs a valid code — checked before anything is saved.
  if (!privileged && body.annualTurnoverRupees == null && (await getRule("registrationFeeByTurnover")).enabled) {
    throw validationFailed("Please check the highlighted fields.", {
      fields: { annualTurnover: "Enter your annual turnover — it sets the registration fee." },
    });
  }
  const referralCode = privileged ? null : await assertRegistrationReferralCode(body.referralCode);
  const { employeeId, ...details } = body;
  const result = await registerShop(details, user, { privileged });
  if (referralCode) await attributeRegistrationReferral(result, referralCode, user);
  // docs/dealer-programme: which dealer (and employee) brought the shop — never blocks the registration.
  await recordShopAttributionSafely(result.id, user, { employeeText: employeeId ?? null });
  return ok(toShopView(result), result.resubmitted ? 200 : 201);
});
