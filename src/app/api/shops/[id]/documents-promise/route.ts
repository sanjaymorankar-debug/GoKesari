/**
 * The owner promises the missing documents within 30 days, so the registration fee can be paid
 * (owner decision 29 Oct 2026, services/shop-document-gate.ts). The shop then waits for an admin
 * or operator to approve it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { promiseShopDocuments } from "@/server/services/shop-document-gate";

const schema = z.object({ promise: z.literal(true) });

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  await parseBody(request, schema);
  return ok(await promiseShopDocuments(id, user));
});
