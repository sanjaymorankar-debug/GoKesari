/**
 * Apply a checked bulk upload (Module 1). Answers 202 at once and applies it
 * straight after the response (Next.js `after`), product by product; poll
 * GET …/media-imports/{importId} for progress. Calling it again on an apply
 * that stopped (no progress for 2 minutes) resumes it; products already done
 * are skipped. 409 while it is running or once it is finished.
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { runMediaImport, startMediaImport } from "@/server/services/shop-media-import";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

const ids = z.object({ id: z.string().uuid(), importId: z.string().uuid() });

export const POST = route(async (_request: NextRequest, context: RouteContext<{ id: string; importId: string }>) => {
  const { id, importId } = ids.parse(await context.params);
  const actor = await requireShopCatalogueAccess(id);
  enforceRateLimit(`shop-media-import-apply:${actor.id}`, { limit: 20, windowMs: 60 * 60_000 });
  await startMediaImport(id, importId);
  after(async () => {
    try {
      await runMediaImport(importId, actor);
    } catch (error) {
      console.error("[media-import] apply failed", importId, error);
    }
  });
  return ok({ id: importId, status: "APPLYING" }, 202);
});
