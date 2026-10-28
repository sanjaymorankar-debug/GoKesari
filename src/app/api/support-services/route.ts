/**
 * Paid Support Services for a shop (docs/dealer-programme, GKS-SP-001). The shop's owner, or the
 * approved dealer who brought the shop; anyone else gets 404. 404 too while the feature is off
 * for the shop's district.
 *
 * GET ?shopId= → services with their current charges, and the shop's requests
 * POST multipart { shopId, serviceKey, quantity, description, files[] } → the request (paid at once when free)
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { AppError, validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { createSupportRequest, listShopRequests, listSupportServices, requesterFor, supportServicesOn } from "@/server/services/support-services";

export const dynamic = "force-dynamic";

const notAvailable = () => new AppError("NOT_FOUND", "This feature is not available.", { reason: "FEATURE_NOT_AVAILABLE", feature: "paid_support_services_enabled" });

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const shopId = z.string().uuid().parse(request.nextUrl.searchParams.get("shopId"));
  if (!(await supportServicesOn(shopId))) throw notAvailable();
  await requesterFor(shopId, user);
  const [services, requests] = await Promise.all([listSupportServices(), listShopRequests(shopId)]);
  return ok({ services, requests });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  enforceRateLimit(`support-service:${user.id}`, { limit: 20, windowMs: 60 * 60_000 });
  const form = await request.formData().catch(() => null);
  if (!form) throw validationFailed("Send the request as a form.");
  const shopId = z.string().uuid().safeParse(form.get("shopId"));
  if (!shopId.success) throw validationFailed("Choose the shop.");
  const files: { name: string; bytes: Buffer }[] = [];
  for (const f of form.getAll("files")) if (f instanceof File && f.size > 0) files.push({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) });
  const created = await createSupportRequest(
    {
      shopId: shopId.data,
      serviceKey: String(form.get("serviceKey") ?? ""),
      quantity: Number(form.get("quantity") ?? 1),
      description: String(form.get("description") ?? ""),
      files,
    },
    user,
  );
  return ok({ request: created }, 201);
});
