/** ?kind=template (the chosen categories' products) or ?kind=mine (the shop's listings); ?format=xlsx (default) or csv. */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { buildMyProducts, buildTemplate } from "@/server/services/shop-bulk-upload";

export const dynamic = "force-dynamic";

const query = z.object({ kind: z.enum(["template", "mine"]), format: z.enum(["xlsx", "csv"]).default("xlsx") });

export const GET = route(async (request: NextRequest, context: RouteContext<{ id: string }>) => {
  const user = await requireUser();
  const id = z.string().uuid().parse((await context.params).id);
  enforceRateLimit(`product-setup-download:${user.id}`, { limit: 60, windowMs: 60 * 60_000 });
  const { kind, format } = parseQuery(request, query);
  const file = await (kind === "template" ? buildTemplate(id, format, user) : buildMyProducts(id, format, user));
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.fileName}"`,
      "Cache-Control": "private, no-store",
    },
  });
});
