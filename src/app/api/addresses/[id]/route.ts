/** A single customer address — read, update, delete (delivery-system Slice A). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, noContent, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { deleteAddress, getAddress, updateAddress } from "@/server/services/addresses";

const saveSchema = z.object({
  label: z.string().max(50).nullish(),
  recipientName: z.string().max(100).nullish(),
  recipientPhone: z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number").nullish().or(z.literal("")),
  addressType: z.enum(["HOME", "WORK", "OTHER"]).optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullish(),
  area: z.string().max(100).nullish(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).nullish(),
  pincode: z.string().regex(/^\d{6}$/),
  landmark: z.string().max(200).nullish(),
  deliveryInstructions: z.string().max(500).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  isDefault: z.boolean().optional(),
});

export const GET = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requireUser();
    const { id } = await context.params;
    return ok(await getAddress(user.id, id));
  },
);

export const PATCH = route(
  async (request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requireUser();
    const { id } = await context.params;
    const body = await parseBody(request, saveSchema);
    return ok(await updateAddress(user.id, id, body));
  },
);

export const DELETE = route(
  async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
    const user = await requireUser();
    const { id } = await context.params;
    await deleteAddress(user.id, id);
    return noContent();
  },
);
