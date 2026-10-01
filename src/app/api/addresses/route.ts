/** Customer delivery addresses — list and create (delivery-system Slice A). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { createAddress, listAddresses } from "@/server/services/addresses";

export const dynamic = "force-dynamic";

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

export const GET = route(async () => {
  const user = await requireUser();
  return ok({ addresses: await listAddresses(user.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const body = await parseBody(request, saveSchema);
  return ok(await createAddress(user.id, body), 201);
});
