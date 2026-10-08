/**
 * The integration safety net (Module 2), run every minute by
 * /api/cron/integration-sync next to the other sweeps. Nothing is sent on a
 * schedule — every push is queued by its event and run straight after
 * commit — this only catches what fell through:
 *   - API jobs whose retry time came while no request was around to run them;
 *   - an invoice / credit note whose push failed to queue (its hook errored);
 *   - a Tally connector that has been offline while entries wait: the owner
 *     is told once a day;
 *   - e-invoice requests that failed because the GSP was down.
 */
import { and, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import { db } from "@/server/db";
import { creditNotes, integrationJobs, shopIntegrations, shops, taxInvoices } from "@/server/db/schema";
import { emitEvent } from "@/server/events/emit";
import { retryFailedEinvoices } from "@/server/gst/einvoice";
import { describeError } from "./errors";
import { dispatchDueJobs, enqueueCreditNotePush, enqueueInvoicePush, logSync, type DispatchSummary } from "./jobs";
import { CONNECTOR_ONLINE_SECONDS } from "./connections";

const LOOKBACK_DAYS = 7;
const OFFLINE_ALERT_MINUTES = 30;

export interface SweepSummary {
  dispatched: DispatchSummary;
  requeuedInvoices: number;
  requeuedCreditNotes: number;
  connectorsOffline: number;
  einvoicesGenerated: number;
}

export async function integrationSweep(): Promise<SweepSummary> {
  const dispatched = await dispatchDueJobs({ limit: 50 });
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  // Settle for a minute first: a push queued in the delivery's own transaction is not "missing".
  const settled = new Date(Date.now() - 60_000);

  const invoices = await db
    .select({ id: taxInvoices.id, shopId: taxInvoices.shopId })
    .from(taxInvoices)
    .innerJoin(shopIntegrations, and(eq(shopIntegrations.shopId, taxInvoices.shopId), ne(shopIntegrations.status, "DISCONNECTED")))
    .where(
      and(
        gte(taxInvoices.issuedAt, since),
        lt(taxInvoices.issuedAt, settled),
        gte(taxInvoices.issuedAt, shopIntegrations.connectedAt),
        sql`not exists (select 1 from ${integrationJobs} j where j.integration_id = ${shopIntegrations.id} and j.kind = 'PUSH_INVOICE' and j.subject_id = ${taxInvoices.id}::text)`,
      ),
    )
    .limit(200);
  for (const inv of invoices) await enqueueInvoicePush(inv);

  const notes = await db
    .select({ id: creditNotes.id, shopId: creditNotes.shopId })
    .from(creditNotes)
    .innerJoin(shopIntegrations, and(eq(shopIntegrations.shopId, creditNotes.shopId), ne(shopIntegrations.status, "DISCONNECTED")))
    .where(
      and(
        gte(creditNotes.issuedAt, since),
        lt(creditNotes.issuedAt, settled),
        gte(creditNotes.issuedAt, shopIntegrations.connectedAt),
        sql`not exists (select 1 from ${integrationJobs} j where j.integration_id = ${shopIntegrations.id} and j.kind = 'PUSH_CREDIT_NOTE' and j.subject_id = ${creditNotes.id}::text)`,
      ),
    )
    .limit(200);
  for (const note of notes) await enqueueCreditNotePush(note);

  // Tally connectors offline with entries waiting.
  const offlineSince = new Date(Date.now() - CONNECTOR_ONLINE_SECONDS * 1000);
  const waitingSince = new Date(Date.now() - OFFLINE_ALERT_MINUTES * 60_000);
  const offline = await db
    .select({ integration: shopIntegrations, shopName: shops.name, ownerId: shops.ownerId })
    .from(shopIntegrations)
    .innerJoin(shops, eq(shops.id, shopIntegrations.shopId))
    .where(
      and(
        eq(shopIntegrations.provider, "TALLY"),
        inArray(shopIntegrations.status, ["ACTIVE", "ERROR"]),
        or(isNull(shopIntegrations.connectorSeenAt), lt(shopIntegrations.connectorSeenAt, offlineSince)),
        sql`exists (select 1 from ${integrationJobs} j where j.integration_id = ${shopIntegrations.id} and j.status in ('PENDING', 'FAILED') and j.created_at < ${waitingSince.toISOString()}::timestamptz)`,
      ),
    );
  let connectorsOffline = 0;
  const info = describeError("CONNECTOR_OFFLINE");
  for (const row of offline) {
    connectorsOffline += 1;
    if (row.integration.lastErrorCode === "CONNECTOR_OFFLINE") continue;
    await db
      .update(shopIntegrations)
      .set({ lastErrorCode: "CONNECTOR_OFFLINE", lastErrorAt: new Date(), updatedAt: new Date() })
      .where(eq(shopIntegrations.id, row.integration.id));
    await logSync(row.integration, { level: "WARN", event: "connector.offline", message: `${info.message} Entries are waiting to be sent.` });
    await emitEvent({
      type: "integration.job_dead",
      subjectId: row.integration.id,
      payload: { shopName: row.shopName, ownerId: row.ownerId, what: "Entries for Tally", reason: info.message, fix: info.fix },
      idempotencyKey: `connector-offline:${row.integration.id}:${new Date().toISOString().slice(0, 10)}`,
    }).catch((e) => console.error("[integrations] offline notice failed", e));
  }

  const einvoicesGenerated = await retryFailedEinvoices();
  return { dispatched, requeuedInvoices: invoices.length, requeuedCreditNotes: notes.length, connectorsOffline, einvoicesGenerated };
}
