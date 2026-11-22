/**
 * Photo shopping list: upload 1–N page photos (multipart, field "page", repeated) and get the lines read by AI
 * (docs/smart-shopping-2026-11, Feature 1). Signed-in customers; flag smart_list_scan_enabled.
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { scanShoppingList } from "@/server/services/smart-list/scan";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`list-scan:${user.id}`, { limit: 10, windowMs: 10 * 60_000 });
  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("page") ?? []).filter((f): f is File => f instanceof File);
  if (files.length === 0) throw validationFailed("Take or choose a photo of your list.");
  const pages = await Promise.all(files.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), contentType: f.type })));
  const lang = (form?.get("lang") as string | null) ?? (await getBoardLang());
  return ok(await scanShoppingList(user.id, pages, ["en", "hi", "mr"].includes(lang) ? lang : "en"), 201);
});
