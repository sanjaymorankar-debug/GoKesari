/**
 * GoKesari Connector — Tally's item list (the reply to `itemsRequest`), sent
 * on start and whenever it changed. Body: the XML as text. 202 at once; the
 * items are matched and applied after the response (see the sync log).
 */
import { after, NextResponse, type NextRequest } from "next/server";

import { validationFailed } from "@/lib/errors";
import { route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { tallyAdapter } from "@/server/integrations/adapters/tally";
import { authenticateConnector } from "@/server/integrations/connections";
import { asIntegrationError, describeError } from "@/server/integrations/errors";
import { logSync } from "@/server/integrations/jobs";
import { applyPulledItems } from "@/server/integrations/pull";
import { db } from "@/server/db";
import { shopIntegrations } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

const MAX_BYTES = 20 * 1024 * 1024;

export const POST = route(async (request: NextRequest) => {
  const session = await authenticateConnector(request);
  enforceRateLimit(`connector-items:${session.tokenId}`, { limit: 30, windowMs: 10 * 60_000 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BYTES) throw validationFailed("Item list too large.");
  if (session.integration.status === "PAUSED") return NextResponse.json({ accepted: false, reason: "paused" }, { status: 202 });
  const xml = await request.text();
  if (xml.length > MAX_BYTES) throw validationFailed("Item list too large.");
  let items;
  try {
    items = tallyAdapter.parseItems(xml);
  } catch (error) {
    const e = asIntegrationError(error);
    await logSync(session.integration, { level: "WARN", event: "pull.failed", message: `Items from Tally could not be read: ${describeError(e.code).message}`, detail: { code: e.code, detail: e.detail?.slice(0, 1000) ?? null } });
    return NextResponse.json({ accepted: false, error: e.code }, { status: 422 });
  }
  const integration = session.integration;
  after(async () => {
    try {
      await applyPulledItems(integration, items);
      await db.update(shopIntegrations).set({ lastPullAt: new Date() }).where(eq(shopIntegrations.id, integration.id));
    } catch (error) {
      console.error("[integrations] connector items failed", error);
    }
  });
  return NextResponse.json({ accepted: true, items: items.length }, { status: 202 });
});
