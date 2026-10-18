/**
 * Barcode look-ups from external product data sources into staging
 * (batch-2026-10 WS-D, F9.1.2): GS1 India DataKart (mock until configured)
 * and Open Food Facts. A source whose rule flag is off is refused before any
 * request leaves the server. Found records become an ordinary import job
 * (staged, de-duplicated by GTIN, attribution stored). The request waits for
 * the job up to LOOKUP_WAIT_MS; a longer job (slow image hosts, a busy
 * database) carries on in the background, as any import does, and the reply
 * holds its progress so the screen can link to it — a look-up never holds the
 * request past the web server's gateway time-out (S-035, 504 on staging).
 */
import { conflict, validationFailed } from "@/lib/errors";
import { AUDIT_ACTIONS, recordAudit } from "@/server/services/audit";

import { gs1DataSource } from "./data-sources/gs1-datakart";
import { offLookupSource } from "./data-sources/open-food-facts";
import type { BarcodeLookupSource } from "./data-sources/types";
import { createIngestJob, getJob, processIngestJob, stagedToInputRows, toProgress, type JobActor, type JobProgress, type ProcessOptions } from "./ingest-jobs";

/** How long a look-up request waits for its import job before replying with the job's progress. */
export const LOOKUP_WAIT_MS = 20_000;

export type LookupSourceName = "GS1" | "OFF";

export function lookupSourceFor(name: LookupSourceName, deps: { fetch?: typeof fetch } = {}): BarcodeLookupSource {
  return name === "GS1" ? gs1DataSource() : offLookupSource({ fetch: deps.fetch });
}

export async function lookupAndStage(
  input: { source: LookupSourceName; gtins: string[] },
  actor: JobActor,
  deps: { source?: BarcodeLookupSource; fetch?: typeof fetch; process?: ProcessOptions; waitMs?: number } = {},
): Promise<{ mode: string; found: number; notFound: string[]; job: JobProgress | null }> {
  const gtins = [...new Set(input.gtins.map((g) => g.replace(/\s/g, "")).filter(Boolean))];
  if (gtins.length === 0) throw validationFailed("Enter at least one barcode.");
  if (gtins.length > 200) throw validationFailed("Look up at most 200 barcodes at a time.");
  const source = deps.source ?? lookupSourceFor(input.source, { fetch: deps.fetch });
  if (!(await source.isEnabled())) {
    await recordAudit({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PMD_SOURCE_LOOKUP,
      entityType: "pmd_source",
      entityId: source.key,
      newValue: { refused: "disabled", count: gtins.length },
    });
    throw conflict(
      input.source === "GS1"
        ? "GS1 India DataKart look-ups are switched off (setting pmdSources.gs1Enabled), or the DataKart keys are not set."
        : "Open Food Facts look-ups are switched off (setting pmdSources.openFoodFactsEnabled).",
      { reason: "SOURCE_DISABLED", source: source.key },
    );
  }
  const { found, notFound } = await source.lookup(gtins);
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: AUDIT_ACTIONS.PMD_SOURCE_LOOKUP,
    entityType: "pmd_source",
    entityId: source.key,
    newValue: { mode: source.mode(), asked: gtins.length, found: found.length, notFound: notFound.length },
  });
  if (found.length === 0) return { mode: source.mode(), found: 0, notFound, job: null };
  const job = await createIngestJob(
    {
      kind: input.source === "GS1" ? "GS1_DATAKART" : "OPEN_FOOD_FACTS",
      source,
      fileName: `${source.label} look-up (${found.length})`,
      rows: stagedToInputRows(found),
      createdVia: "LOOKUP",
      autoStart: false,
    },
    actor,
  );
  const run = processIngestJob(job.id, { maxBatches: 1000, ...deps.process });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([
    run.then((progress) => ({ progress })),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deps.waitMs ?? LOOKUP_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (waited) return { mode: source.mode(), found: found.length, notFound, job: waited.progress };
  // Still running: it holds the job's lease and finishes on its own; the pmd-ingest cron resumes it if this process stops.
  run.catch((e) => console.error("[pmd-lookup] import failed", job.id, e));
  return { mode: source.mode(), found: found.length, notFound, job: toProgress(await getJob(job.id)) };
}
