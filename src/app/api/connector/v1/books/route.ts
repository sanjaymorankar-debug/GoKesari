/**
 * GoKesari Connector (Tally) — two-way books sync (billing v2, docs/billing §8
 * phase 2), while the tally_connector flag (or rule inventorySync) and
 * billing_v2 are on.
 *
 *   GET   GoKesari's books since the last exchange as Tally XML (masters, then
 *         vouchers): the connector imports it into the open company.
 *         409 with the fix list when something must be fixed first.
 *   POST  Tally's Day Book / masters export (XML as text): imported into the
 *         shop's books (masters first, vouchers keyed by type + date + number,
 *         conflicts held for the owner).
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { validationFailed } from "@/lib/errors";
import { route } from "@/server/api/handler";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { authenticateConnector } from "@/server/integrations/connections";
import { assertConnectorEnabled } from "@/server/integrations/inventory-sync-flag";
import { logSync } from "@/server/integrations/jobs";
import { requireFeatureForShop } from "@/server/services/feature-flags";
import { ExportBlocked, importForTool, MAX_SYNC_FILE_BYTES, tallyBooksForConnector } from "@/server/sync/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = route(async (request: NextRequest) => {
  const session = await authenticateConnector(request);
  await assertConnectorEnabled();
  await requireFeatureForShop("billing_v2", session.integration.shopId);
  enforceRateLimit(`connector-books:${session.tokenId}`, { limit: 20, windowMs: 10 * 60_000 });
  try {
    const out = await tallyBooksForConnector(session.integration.shopId);
    await logSync(session.integration, { level: "INFO", event: "books.sent", message: `Books ${out.range.from} to ${out.range.to} sent to Tally: ${out.counts.new} new, ${out.counts.changed} changed.`, detail: out.counts });
    return new NextResponse(out.xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store", "x-gokesari-new": String(out.counts.new), "x-gokesari-changed": String(out.counts.changed) } });
  } catch (error) {
    if (error instanceof ExportBlocked) {
      await logSync(session.integration, { level: "WARN", event: "books.blocked", message: error.message, detail: { fixes: error.fixes.slice(0, 20) } });
      return NextResponse.json({ error: { code: "FIX_FIRST", message: error.message, fixes: error.fixes } }, { status: 409 });
    }
    throw error;
  }
});

export const POST = route(async (request: NextRequest) => {
  const session = await authenticateConnector(request);
  await assertConnectorEnabled();
  await requireFeatureForShop("billing_v2", session.integration.shopId);
  enforceRateLimit(`connector-books-in:${session.tokenId}`, { limit: 20, windowMs: 10 * 60_000 });
  const xml = await request.text();
  if (xml.length > MAX_SYNC_FILE_BYTES) throw validationFailed("The Tally export is larger than 5 MB: send fewer days at a time.");
  const [shop] = await db.select({ ownerId: shops.ownerId }).from(shops).where(eq(shops.id, session.integration.shopId));
  const summary = await importForTool(session.integration.shopId, "TALLY", { name: "tally-daybook.xml", bytes: Buffer.from(xml) }, { id: shop.ownerId, role: "SHOP_OWNER" });
  await logSync(session.integration, { level: summary.conflicts || summary.vouchers.skipped.length ? "WARN" : "INFO", event: "books.received", message: `From Tally: ${summary.vouchers.created} voucher(s) added, ${summary.conflicts} to decide, ${summary.vouchers.skipped.length} skipped.`, detail: summary as unknown as Record<string, unknown> });
  return NextResponse.json(summary);
});
