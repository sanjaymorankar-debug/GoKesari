/**
 * Manufacturer API keys (batch-2026-10 WS-D, F9.1.2) — signed-in member.
 * GET  → keys (prefix, last use, revoked) — never the key itself
 * POST { label } → a new key, shown ONCE in this response
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireUser } from "@/server/authz/guards";
import { issueApiKey, listApiKeys, requireManufacturerMembership } from "@/server/pmd/manufacturers";

export const dynamic = "force-dynamic";

const schema = z.object({ label: z.string().trim().max(80).nullish() });

export const GET = route(async (request: NextRequest) => {
  const user = await requireUser();
  const account = await requireManufacturerMembership(user.id, new URL(request.url).searchParams.get("account"));
  return ok({ keys: await listApiKeys(account.id) });
});

export const POST = route(async (request: NextRequest) => {
  const user = await requireUser();
  const account = await requireManufacturerMembership(user.id, new URL(request.url).searchParams.get("account"));
  const body = await parseBody(request, schema);
  return ok(await issueApiKey(account.id, { label: body.label ?? null }, user), 201);
});
