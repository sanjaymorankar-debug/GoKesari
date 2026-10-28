/**
 * POST { what: "PAN" | "BANK_ACCOUNT", reason } — ADMIN only: the full number, once, audited with
 * the reason. Never cached. docs/dealer-programme (security §4).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { requireDealerProgramme } from "@/server/dealers/http";
import { revealDealerSecret } from "@/server/dealers/service";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  await requireDealerProgramme();
  const admin = await requireRole("ADMIN");
  const id = z.string().uuid().parse((await context.params).id);
  const body = await parseBody(request, z.object({ what: z.enum(["PAN", "BANK_ACCOUNT"]), reason: z.string().max(300) }));
  const response = ok({ value: await revealDealerSecret(id, body.what, body.reason, admin) });
  response.headers.set("cache-control", "no-store");
  return response;
});
