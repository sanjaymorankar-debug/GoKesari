/**
 * Inbound email webhook for forwarded supplier bills (src/server/accounts/inbound.ts).
 * Body: { to: string[] | string, from?, subject?, attachments: [{ filename, contentType, contentBase64 }] }
 * (map the provider's own payload to this shape in its webhook settings or a small worker).
 */
import { after, type NextRequest } from "next/server";
import { z } from "zod";

import { ok, parseBody, route } from "@/server/api/handler";
import { processCapture } from "@/server/accounts/capture/service";
import { assertInboundAuthorized, receiveBillEmail } from "@/server/accounts/inbound";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  to: z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : v.split(","))),
  from: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  attachments: z.array(z.object({ filename: z.string().nullable().optional(), contentType: z.string().nullable().optional(), contentBase64: z.string().max(20_000_000) })).max(20),
});

export const POST = route(async (request: NextRequest) => {
  assertInboundAuthorized(request);
  const body = await parseBody(request, schema);
  const capture = await receiveBillEmail({ to: body.to, from: body.from ?? null, subject: body.subject ?? null, attachments: body.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType ?? null, contentBase64: a.contentBase64 })) });
  after(() => processCapture(capture.id).then(() => undefined));
  return ok({ captureId: capture.id }, 201);
});
