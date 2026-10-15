/**
 * Bulk product upload (docs/product-import-2026-10): import a previewed file.
 * Body { inventoryMode: "SET" (default: stock becomes the file's Quantity) | "ADD" (added to current stock) }.
 * Answers 202 at once and imports straight after the response, in batches;
 * poll GET /api/v1/product-imports/{jobId}. Calling it again on an import
 * that stopped (no progress for 5 minutes) resumes it.
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { INVENTORY_MODES } from "@/lib/product-import";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { runCommit, startCommit } from "@/server/services/product-import";

export const dynamic = "force-dynamic";

const body = z.object({ inventoryMode: z.enum(INVENTORY_MODES).default("SET") });

export const POST = route(async (request: NextRequest, context: RouteContext<{ jobId: string }>) => {
  const jobId = z.string().uuid().parse((await context.params).jobId);
  const user = await requireUser();
  enforceRateLimit(`product-import-commit:${user.id}`, { limit: 60, windowMs: 60 * 60_000 });
  const raw = await request.json().catch(() => ({}));
  const { inventoryMode } = body.parse(raw ?? {});
  await startCommit(jobId, inventoryMode, user);
  after(async () => {
    try {
      await runCommit(jobId, user);
    } catch (error) {
      console.error("[product-import] import failed", jobId, error);
    }
  });
  return ok({ jobId, status: "importing", inventoryMode }, 202);
});
