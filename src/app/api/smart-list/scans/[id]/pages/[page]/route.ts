/** A page photo of the customer's own list scan (private; gone after the retention days). Admins may view any. */
import { NextResponse } from "next/server";

import { notFound } from "@/lib/errors";
import { route, type RouteContext } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { readScanPage } from "@/server/services/smart-list/scan";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: Request, context: RouteContext<{ id: string; page: string }>) => {
  const user = await requireUser();
  const { id, page } = await context.params;
  const n = Number(page);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(n) || n < 1 || n > 20) throw notFound("Photo");
  const bytes = await readScanPage(user.id, id, n, { admin: user.role === "ADMIN" });
  if (!bytes) throw notFound("Photo");
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "content-type": "image/webp", "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
});
