/**
 * GoKesari Connector — long-poll for work. GET ?wait=25 holds the request
 * until a job is queued for this connection (woken at once on this server,
 * else found at the next check) or the wait ends. Each job comes with the
 * exact XML to send to Tally; the connector posts Tally's reply to
 * /jobs/{jobId}/result.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { parseQuery, route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { authenticateConnector } from "@/server/integrations/connections";
import { claimConnectorWork, waitForConnectorWork } from "@/server/integrations/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CHECK_MS = 5_000;

export const GET = route(async (request: NextRequest) => {
  const session = await authenticateConnector(request);
  enforceRateLimit(`connector-poll:${session.tokenId}`, { limit: 240, windowMs: 10 * 60_000 });
  const { wait } = parseQuery(request, z.object({ wait: z.coerce.number().int().min(0).max(30).default(25) }));
  const until = Date.now() + wait * 1000;
  let jobs = session.integration.status === "PAUSED" ? [] : await claimConnectorWork(session.integration, session.tokenId);
  while (jobs.length === 0 && session.integration.status !== "PAUSED" && Date.now() < until && !request.signal.aborted) {
    await waitForConnectorWork(session.integration.id, Math.min(CHECK_MS, until - Date.now()));
    if (request.signal.aborted) break;
    jobs = await claimConnectorWork(session.integration, session.tokenId);
  }
  return NextResponse.json({ jobs }, { headers: { "cache-control": "no-store" } });
});
