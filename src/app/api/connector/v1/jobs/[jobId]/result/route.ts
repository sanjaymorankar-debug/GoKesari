/**
 * GoKesari Connector — Tally's reply to a job's request.
 * POST { ok: true, stepId, response } | { ok: false, stepId, errorCode, detail? }
 * → { done } or { done: false, next: { jobId, stepId, body } } for the next step
 *   (e.g. "voucher not found" → create it).
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { validationFailed } from "@/lib/errors";
import { parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { authenticateConnector } from "@/server/integrations/connections";
import { submitConnectorResult } from "@/server/integrations/jobs";

export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024;

const schema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), stepId: z.string().max(40), response: z.string().max(MAX_BYTES) }),
  z.object({
    ok: z.literal(false),
    stepId: z.string().max(40),
    errorCode: z.enum(["TALLY_NOT_RUNNING", "TALLY_COMPANY_NOT_OPEN", "UNREACHABLE", "INTERNAL"]),
    detail: z.string().max(4000).optional(),
  }),
]);

export const POST = route(async (request: NextRequest, context: { params: Promise<{ jobId: string }> }) => {
  const session = await authenticateConnector(request);
  enforceRateLimit(`connector-result:${session.tokenId}`, { limit: 600, windowMs: 10 * 60_000 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES + 1024) throw validationFailed("Reply too large.");
  const jobId = z.string().uuid().parse((await context.params).jobId);
  const result = await parseBody(request, schema);
  return NextResponse.json(await submitConnectorResult(session.integration, session.tokenId, jobId, result), {
    headers: { "cache-control": "no-store" },
  });
});
