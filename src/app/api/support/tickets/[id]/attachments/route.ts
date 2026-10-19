/**
 * Add a file (photo or PDF) to a ticket (F6.3.3, batch-2026-10 WS-C).
 * Multipart form: `file`, optional `internal` ("true", support only).
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { addTicketAttachment } from "@/server/aftercare/support-tickets";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const { id } = await context.params;
  const user = await requireUser();
  enforceRateLimit(`ticket-file:${user.id}`, { limit: 30, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach a file.");
  const row = await addTicketAttachment(
    id,
    user,
    { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) },
    { internal: form?.get("internal") === "true" },
  );
  return ok({ ...row, url: `/api/support/tickets/${id}/attachments/${row.id}` }, 201);
});
