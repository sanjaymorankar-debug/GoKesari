/**
 * My Health: GET → whether the notice is accepted and the people in my account; POST { accept: true } →
 * accept the My Health notice (records consent with the time and starts my record).
 */
import type { NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { ok, route } from "@/server/api/handler";
import { enforceRateLimit, RATE_LIMITS } from "@/server/api/rate-limit";
import { requireUser } from "@/server/authz/guards";
import { requireHealthEnabled } from "@/server/health/access";
import { bodyOf } from "@/server/health/http";
import { acceptHealthNotice, listFamily, selfPatient } from "@/server/health/patients";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const user = await requireUser();
  await requireHealthEnabled();
  const self = await selfPatient(user.id);
  return ok({ accepted: Boolean(self), patients: self ? (await listFamily(user)).map(({ linkCodeHash: _h, ...p }) => (void _h, p)) : [] });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  await requireHealthEnabled();
  enforceRateLimit(`health-me:${user.id}`, RATE_LIMITS.MUTATION);
  const body = await bodyOf(request);
  if (body.accept !== true) throw validationFailed("Please read and accept the notice.");
  const { linkCodeHash: _h, ...patient } = await acceptHealthNotice(user);
  void _h;
  return ok({ patient }, 201);
});
