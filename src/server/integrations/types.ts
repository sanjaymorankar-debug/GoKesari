/**
 * The adapter interface (Module 2). One adapter per accounting / inventory
 * software, three ways of reaching it:
 *
 *   API        GoKesari calls the software's web API (Odoo, Zoho Books).
 *   CONNECTOR  the software runs on the shop's PC with no internet API
 *              (TallyPrime): the GoKesari Connector there asks GoKesari for
 *              work and talks to the software locally. The adapter builds the
 *              requests and reads the replies; the connector only carries them.
 *   FILE       no confirmed API (myBillBook, Vyapar, any other): the shop
 *              uploads an export and downloads files to import. The API slot
 *              stays open — a FILE provider can become an API adapter later
 *              without touching the rest of the integration layer.
 */
import type { z } from "zod";

import type { IntegrationJob, IntegrationProvider, ShopIntegration } from "@/server/db/schema";
import type { CanonicalCreditNote, CanonicalInvoice, CanonicalItem } from "./canonical";

export type Transport = "API" | "CONNECTOR" | "FILE";

export interface AdapterContext {
  integration: ShopIntegration;
  /** Non-secret settings (validated by the adapter's configSchema). */
  config: Record<string, unknown>;
  /** Decrypted secrets (validated by the adapter's credentialsSchema). */
  credentials: Record<string, unknown>;
  /** Persists changed secrets (e.g. a refreshed OAuth token), encrypted. */
  saveCredentials(next: Record<string, unknown>): Promise<void>;
  /** Injected so tests (and a future proxy) can stand in for the network. */
  fetch: typeof fetch;
  /** The job's saved progress (API adapters with more than one step). */
  state: Record<string, unknown>;
  /** Saves progress before the next step, so a retry does not repeat a finished step. */
  checkpoint(next: Record<string, unknown>): Promise<void>;
}

export interface PushResult {
  /** The document's id or number in the shop's software. */
  externalRef: string;
  /** False when the document was already there (a retry found it): nothing new was created. */
  created: boolean;
}

interface AdapterBase {
  provider: IntegrationProvider;
  transport: Transport;
  label: string;
  /** Shown on the connect screen. */
  description: string;
  configSchema: z.ZodType<Record<string, unknown>>;
  credentialsSchema: z.ZodType<Record<string, unknown>>;
}

export interface ApiAdapter extends AdapterBase {
  transport: "API";
  testConnection(ctx: AdapterContext): Promise<string>;
  pullItems(ctx: AdapterContext): Promise<CanonicalItem[]>;
  pushInvoice(ctx: AdapterContext, invoice: CanonicalInvoice): Promise<PushResult>;
  pushCreditNote(ctx: AdapterContext, note: CanonicalCreditNote): Promise<PushResult>;
}

/** One request for the connector to send to the local software. */
export interface ConnectorStep {
  stepId: string;
  /** The request body, e.g. Tally XML. */
  body: string;
}

export type StepOutcome =
  | { kind: "next"; state: Record<string, unknown> }
  | { kind: "done"; result: PushResult; state: Record<string, unknown> };

export interface ConnectorAdapter extends AdapterBase {
  transport: "CONNECTOR";
  /** The request for the job's current step (from job.state). */
  stepFor(job: IntegrationJob, ctx: AdapterContext): ConnectorStep;
  /** Reads the software's reply to a step: the next step, or the job's result. Throws IntegrationError on failure. */
  applyStepResult(job: IntegrationJob, ctx: AdapterContext, stepId: string, response: string): StepOutcome;
  /** The request the connector runs (on change) to read the items. */
  itemsRequest(ctx: AdapterContext): string;
  parseItems(response: string): CanonicalItem[];
}

export interface FileAdapter extends AdapterBase {
  transport: "FILE";
  /** Header aliases for this software's item export (canonical field → header names). */
  itemColumns: Partial<Record<FileItemField, string[]>>;
  /** Whether the preset is confirmed against a real export from the software. */
  presetConfirmed: boolean;
}

export const FILE_ITEM_FIELDS = ["externalId", "name", "sku", "barcode", "unit", "stock", "price", "mrp", "hsn", "gstRate"] as const;
export type FileItemField = (typeof FILE_ITEM_FIELDS)[number];

export type Adapter = ApiAdapter | ConnectorAdapter | FileAdapter;
