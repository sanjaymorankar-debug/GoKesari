/** Admin: POST multipart { file, kind, shopId? } — a signed consent letter for a waiting referral move. */
import { type NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireRole } from "@/server/authz/guards";
import { addMoveDocument, type MoveDocKind } from "@/server/dealers/referral-moves";

export const dynamic = "force-dynamic";

export const POST = route(async (request: NextRequest, { params }: RouteContext<{ id: string }>) => {
  const admin = await requireRole("ADMIN");
  enforceRateLimit(`referral-move-doc:${admin.id}`, { limit: 60, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw validationFailed("Attach the signed consent (PDF or photo).");
  const kind = String(form?.get("kind") ?? "") as MoveDocKind;
  const shopId = form?.get("shopId") ? String(form.get("shopId")) : null;
  const doc = await addMoveDocument((await params).id, { kind, shopId, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, admin);
  return ok(doc, 201);
});
