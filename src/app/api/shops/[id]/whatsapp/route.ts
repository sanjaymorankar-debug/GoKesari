/**
 * The shop's WhatsApp order alerts (docs/smart-shopping-2026-11/FEATURE3_WHATSAPP_ORDERS.md).
 * The shop's owner only — operators and admins do not manage a shop's numbers.
 *
 *   GET                                         settings, numbers and their WhatsApp status
 *   PUT   { enabled, owner, staff[] }           save; new numbers get a test message
 *   POST  { action: "recheck", contactId }      send the test message to one number again
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { requireFeatureForShop } from "@/server/services/feature-flags";
import { getShopWhatsAppSettings, recheckWhatsAppNumber, saveShopWhatsAppSettings } from "@/server/whatsapp/shop-orders/contacts";
import { WHATSAPP_FLAG } from "@/server/whatsapp/shop-orders/state";

const phone = z.string().trim().min(10).max(20);
const label = z.string().trim().max(60).nullish();

const saveSchema = z.object({
  enabled: z.boolean(),
  owner: z.object({ phone, optedIn: z.boolean(), label }).nullable(),
  staff: z.array(z.object({ phone, label, optedIn: z.boolean().optional() })).max(10),
});

const actionSchema = z.object({ action: z.literal("recheck"), contactId: z.string().uuid() });

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  await requireFeatureForShop(WHATSAPP_FLAG, id);
  return ok(await getShopWhatsAppSettings(id, user.id));
});

export const PUT = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  await requireFeatureForShop(WHATSAPP_FLAG, id);
  const body = await parseBody(request, saveSchema);
  return ok(await saveShopWhatsAppSettings(id, user.id, body));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const { id } = await context.params;
  await requireFeatureForShop(WHATSAPP_FLAG, id);
  const body = await parseBody(request, actionSchema);
  return ok(await recheckWhatsAppNumber(id, user.id, body.contactId));
});
