/** GET — the error file of an import: every refused row with its reason, as CSV (batch-2026-10 WS-D, F9.1.4). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { assertJobAccess } from "@/server/pmd/api-access";
import { errorFileCsv, getJob } from "@/server/pmd/ingest-jobs";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  await assertJobAccess(await getJob(id), user);
  const csv = await errorFileCsv(id);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="import-${id.slice(0, 8)}-errors.csv"`,
      "Cache-Control": "no-store",
    },
  }) as never;
});
