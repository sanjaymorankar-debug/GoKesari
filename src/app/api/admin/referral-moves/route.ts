/**
 * Admin → Dealers → Referral moves (owner, 22-Nov-2026): GET the requests (?status=PENDING …);
 * POST { kind: "SHOPS", shopIds, toDealerId, toMemberId?, reason } or { kind: "MEMBER", memberId, toDealerId, toMemberId?, reason }.
 */
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { requireRole } from "@/server/authz/guards";
import { createMoveRequest, listMoveRequests } from "@/server/dealers/referral-moves";

export const dynamic = "force-dynamic";

const STATUSES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;

export const GET = route(async (request: NextRequest) => {
  await requireRole("ADMIN");
  const s = request.nextUrl.searchParams.get("status");
  return ok({ requests: await listMoveRequests(STATUSES.find((x) => x === s)) });
});

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SHOPS"), shopIds: z.array(z.string().uuid()).min(1).max(50), toDealerId: z.string().uuid(), toMemberId: z.string().uuid().nullish(), reason: z.string().min(10).max(500) }),
  z.object({ kind: z.literal("MEMBER"), memberId: z.string().uuid(), toDealerId: z.string().uuid(), toMemberId: z.string().uuid().nullish(), reason: z.string().min(10).max(500) }),
]);

export const POST = route(async (request: NextRequest) => {
  const admin = await requireRole("ADMIN");
  return ok(await createMoveRequest(await parseBody(request, body), admin), 201);
});
