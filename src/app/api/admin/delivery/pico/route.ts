/**
 * Admin → Delivery management → Pico Xpress (docs/pico-xpress-2026-11).
 *   GET   ?filter=live|delivered|problems|cancelled|all&q=  overview, shipments, API calls, webhook events
 *         ?log=<id>                                          one API call with its (masked) bodies
 *   POST  { action: "refill", count? }                      fetch AWB numbers from Pico now (SYSTEM_CONFIG)
 * Operations (DELIVERY_ORDER_MANAGE_ANY) may view; Refresh / Cancel of a shipment use /api/orders/[id]/pico.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { notFound } from "@/lib/errors";
import { ok, parseBody, route } from "@/server/api/handler";
import { RATE_LIMITS, enforceRateLimit } from "@/server/api/rate-limit";
import { requireDeliveryConfig, requireDeliveryOps } from "@/server/delivery/access";
import { apiLogDetail, listShipments, picoOverview, recentApiLogs, recentEvents, SHIPMENT_FILTERS, type ShipmentFilter } from "@/server/delivery/pico/admin";
import { poolLevels, refillPool } from "@/server/delivery/pico/awb-pool";
import { picoConfig, picoEnvForSite } from "@/server/delivery/pico/config";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

export const GET = route(async (request: NextRequest) => {
  await requireDeliveryOps();
  const params = request.nextUrl.searchParams;
  const logId = params.get("log");
  if (logId) {
    if (!/^[0-9a-f-]{36}$/i.test(logId)) throw notFound("API call");
    const log = await apiLogDetail(logId);
    if (!log) throw notFound("API call");
    return ok({ log });
  }
  const f = params.get("filter") ?? "live";
  const filter: ShipmentFilter = f === "all" || f in SHIPMENT_FILTERS ? (f as ShipmentFilter) : "live";
  const [overview, shipments, apiLogs, events] = await Promise.all([picoOverview(), listShipments(filter, params.get("q") ?? ""), recentApiLogs(), recentEvents()]);
  return ok({ overview, shipments, apiLogs, events });
});

const body = z.object({ action: z.literal("refill"), count: z.number().int().min(1).max(1000).optional() });

export const POST = route(async (request: NextRequest) => {
  const user = await requireDeliveryConfig();
  enforceRateLimit(`pico-admin:${user.id}`, RATE_LIMITS.MUTATION);
  const input = await parseBody(request, body);
  const cfg = picoConfig();
  if (!cfg.ok) return ok({ added: 0, problem: cfg.problem }, 409);
  const env = picoEnvForSite();
  const added = await refillPool(env, input.count);
  await recordAudit({
    actorId: user.id,
    actorRole: user.role,
    action: AUDIT_ACTIONS.SETTING_CHANGED,
    entityType: "delivery_awb_pool",
    entityId: env,
    newValue: { refill: added },
  }).catch(() => undefined);
  return ok({ added, pool: await poolLevels(env) });
});
