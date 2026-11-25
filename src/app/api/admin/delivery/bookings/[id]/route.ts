/**
 * docs/hdms-2026-11: one partner booking — detail (GET) and actions (POST, Operations; audited):
 *   cancel      cancel with the partner (before pickup only);
 *   refresh     ask the partner for the latest status now;
 *   simulate    sandbox simulator only, never on gokesari.com: send a signed test event (PICKED_UP, DELIVERED, ...).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { deployedSiteKind } from "@/lib/env";
import { conflict } from "@/lib/errors";
import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { BOOKING_STATUSES } from "@/server/db/hdms-schema";
import { requireDeliveryOps } from "@/server/delivery/access";
import { bookingDetail } from "@/server/delivery/admin";
import { applyBookingUpdate, cancelBooking } from "@/server/delivery/bookings";
import { signMockWebhook } from "@/server/delivery/providers/mock";
import { callProvider, getProvider, webhookSecretFor } from "@/server/delivery/providers/registry";
import { handleDeliveryWebhook } from "@/server/delivery/webhooks";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(3).max(200) }),
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("simulate"), status: z.enum(BOOKING_STATUSES), reason: z.string().max(200).optional() }),
]);

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDeliveryOps();
  const { id } = await context.params;
  return ok(await bookingDetail(id));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireDeliveryOps();
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  const { booking } = await bookingDetail(id);
  let result: unknown;
  if (body.action === "cancel") {
    result = (await cancelBooking(id, "ADMIN", body.reason)).booking;
  } else if (body.action === "refresh") {
    const provider = booking.providerCode ? await getProvider(booking.providerCode) : null;
    if (!provider || !booking.externalRef) throw conflict("This booking has no partner reference to refresh.");
    const t = await callProvider(provider, { operation: "track", bookingId: id, retries: 0 }, (a, ctx) => a.track(ctx, booking.externalRef!));
    result = (await applyBookingUpdate(id, { status: t.status, source: "ADMIN", note: "Refreshed by operations", riderName: t.riderName, riderPhone: t.riderPhone, riderLocation: t.riderLocation, etaMinutes: t.etaMinutes })).booking;
  } else {
    if (deployedSiteKind() === "production") throw conflict("Simulation is not available on the live site.");
    if (booking.providerCode !== "MOCK" || !booking.externalRef) throw conflict("Only sandbox-simulator bookings can be simulated.");
    const provider = await getProvider("MOCK");
    const secret = provider ? webhookSecretFor(provider) : null;
    if (!secret) throw conflict("Set a webhook secret on the sandbox simulator first (Providers).");
    const raw = JSON.stringify({ events: [{ id: `sim-${Date.now()}`, ref: booking.externalRef, status: body.status, reason: body.reason ?? null, riderName: "Sandbox Rider" }] });
    result = await handleDeliveryWebhook("MOCK", raw, new Headers({ "x-mock-signature": signMockWebhook(raw, secret) }));
  }
  await recordAudit({ actorId: user.id, actorRole: user.role, action: AUDIT_ACTIONS.SETTING_CHANGED, entityType: "delivery_booking", entityId: id, newValue: body });
  return ok({ result });
});
