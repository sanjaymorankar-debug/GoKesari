/** The CSV template for bulk descriptions (Module 1). */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { route, type RouteContext } from "@/server/api/handler";
import { mediaCsvTemplate } from "@/server/services/shop-media-import";
import { requireShopCatalogueAccess } from "@/server/services/shop-staff";

export const dynamic = "force-dynamic";

export const GET = route(async (_request: NextRequest, context: RouteContext<{ id: string }>) => {
  const id = z.string().uuid().parse((await context.params).id);
  await requireShopCatalogueAccess(id);
  return new NextResponse(`﻿${mediaCsvTemplate()}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gokesari-descriptions-template.csv"',
      "Cache-Control": "private, no-store",
    },
  });
});
