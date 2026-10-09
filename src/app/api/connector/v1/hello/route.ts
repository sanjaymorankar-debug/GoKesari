/**
 * GoKesari Connector (Tally) — sign-in check at start-up.
 * POST { version, tallyRunning?, companies? } (Bearer connector token)
 * → which company to use, how often to check, and the request that reads
 *   Tally's items (the connector runs it on start and every 2 minutes, and
 *   uploads the result to /items only when it changed).
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { parseBody, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { tallyAdapter } from "@/server/integrations/adapters/tally";
import { authenticateConnector } from "@/server/integrations/connections";
import { contextFor, logSync } from "@/server/integrations/jobs";

export const dynamic = "force-dynamic";

const schema = z.object({
  version: z.string().max(40),
  tallyRunning: z.boolean().optional(),
  companies: z.array(z.string().max(200)).max(50).optional(),
  machine: z.string().max(100).optional(),
});

export const POST = route(async (request: NextRequest) => {
  const session = await authenticateConnector(request);
  enforceRateLimit(`connector-hello:${session.tokenId}`, { limit: 30, windowMs: 10 * 60_000 });
  const body = await parseBody(request, schema);
  const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, session.integration.shopId));
  const company = (session.integration.config.company as string | undefined) ?? null;
  const companyOpen = body.companies ? (company ? body.companies.includes(company) : false) : null;
  await logSync(session.integration, {
    level: body.tallyRunning === false || companyOpen === false ? "WARN" : "INFO",
    event: "connector.started",
    message:
      body.tallyRunning === false
        ? "The GoKesari Connector started, but Tally is not open on the shop computer."
        : companyOpen === false
          ? `The GoKesari Connector started, but the company "${company}" is not open in Tally.`
          : `The GoKesari Connector started${body.machine ? ` on ${body.machine}` : ""}.`,
    detail: { version: body.version, companies: body.companies ?? null },
  });
  let itemsRequest: string | null = null;
  try {
    itemsRequest = tallyAdapter.itemsRequest(contextFor(session.integration, null));
  } catch {
    itemsRequest = null; // company not set yet: the connector waits and asks again
  }
  return NextResponse.json(
    {
      shop: { name: shop?.name ?? "" },
      company,
      paused: session.integration.status === "PAUSED",
      pollSeconds: 25,
      itemCheckSeconds: 120,
      itemsRequest,
    },
    { headers: { "cache-control": "no-store" } },
  );
});
