/**
 * A consultant firm's own side (docs/consult-booking-2026-11): the owner, members, consult staff and the
 * operator who onboarded the shop (setup only).
 * GET ?view=setup | calendar&from&to&member | dashboard
 * POST { action, … }: profile {…} · publish · pause · member {…} · hours {memberId, rows[]} · service {…}
 *                     · time-off {…} · time-off-delete {id}
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { isDateKey, istDateKey } from "@/lib/consult/time";
import { notFound, validationFailed } from "@/lib/errors";
import { ok, route, type RouteContext } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { firmAccessOrNull } from "@/server/consult/access";
import { memberDocumentLinks } from "@/server/consult/files";
import { addTimeOff, deleteTimeOff, ensureProfile, pauseProfile, publishProfile, saveMember, saveService, setMemberHours, setupView, updateProfile } from "@/server/consult/setup";
import { firmCalendar, firmDashboard } from "@/server/consult/views";

export const dynamic = "force-dynamic";

const shopOf = async (context: RouteContext<{ shopId: string }>) => z.string().uuid().parse((await context.params).shopId);

export const GET = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  const shopId = await shopOf(context);
  if (!(await firmAccessOrNull(shopId, user))) throw notFound("Consultant");
  const q = request.nextUrl.searchParams;
  const view = q.get("view") ?? "setup";
  if (view === "calendar") {
    const today = istDateKey(new Date());
    const from = isDateKey(q.get("from")) ? q.get("from")! : today;
    const to = isDateKey(q.get("to")) ? q.get("to")! : from;
    if (to < from) throw validationFailed("The end is before the start.");
    return ok(await firmCalendar(shopId, user, from, to, q.get("member")));
  }
  if (view === "dashboard") return ok(await firmDashboard(shopId, user));
  if (view === "documents") return ok({ documents: await memberDocumentLinks(z.string().uuid().parse(q.get("member")), user) });
  await ensureProfile(shopId, user).catch(() => null);
  return ok(await setupView(shopId, user));
});

export const POST = route(async (request: NextRequest, context: RouteContext<{ shopId: string }>) => {
  const user = await requireUser();
  enforceRateLimit(`consult-setup:${user.id}`, RATE_LIMITS.MUTATION);
  const shopId = await shopOf(context);
  // Someone with no access to this firm learns nothing, not even which actions exist.
  if (!(await firmAccessOrNull(shopId, user))) throw notFound("Consultant");
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  switch (body.action) {
    case "create":
      return ok({ profile: await ensureProfile(shopId, user) });
    case "profile":
      return ok({ profile: await updateProfile(shopId, body.profile ?? {}, user) });
    case "publish":
      return ok({ profile: await publishProfile(shopId, user) });
    case "pause":
      return ok({ profile: await pauseProfile(shopId, user) });
    case "member":
      return ok({ member: await saveMember(shopId, body.member ?? {}, user) });
    case "hours":
      return ok({ hours: await setMemberHours(shopId, z.string().uuid().parse(body.memberId), body.rows ?? [], user) });
    case "service":
      return ok({ service: await saveService(shopId, body.service ?? {}, user) });
    case "time-off":
      return ok({ timeOff: await addTimeOff(shopId, body.timeOff ?? {}, user) });
    case "time-off-delete":
      await deleteTimeOff(shopId, z.string().uuid().parse(body.id), user);
      return ok({ deleted: true });
    default:
      throw validationFailed("Unknown action.");
  }
});
