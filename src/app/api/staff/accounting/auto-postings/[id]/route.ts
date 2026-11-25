/**
 * docs/tax-register/BOOKS.md: the Accountant turns a queued posting into a journal draft
 * ({ action: "draft" }) — the CA then approves it like any journal — or dismisses it
 * ({ action: "dismiss", reason }).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route, type RouteContext } from "@/server/api/handler";
import { requireAnyPermission } from "@/server/authz/guards";
import { PERMISSIONS } from "@/server/authz/permissions";
import { dismissPosting, draftFromPosting } from "@/server/rbac-accounting/auto-post";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [z.object({ action: z.literal("draft") }), z.object({ action: z.literal("dismiss"), reason: z.string().min(5).max(500) })]);

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const actor = await requireAnyPermission([PERMISSIONS.JOURNAL_PREPARE]);
  const { id } = await context.params;
  const body = await parseBody(request, schema);
  if (body.action === "draft") return ok(await draftFromPosting(id, actor));
  return ok(await dismissPosting(id, body.reason, actor));
});
