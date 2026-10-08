/** Every accounting adapter by provider (Module 2). */
import type { IntegrationProvider } from "@/server/db/schema";
import { genericFileAdapter, myBillBookAdapter, vyaparAdapter } from "./adapters/file";
import { odooAdapter } from "./adapters/odoo";
import { tallyAdapter } from "./adapters/tally";
import { zohoAdapter } from "./adapters/zoho";
import type { Adapter, ApiAdapter, ConnectorAdapter, FileAdapter } from "./types";

export const ADAPTERS: Record<IntegrationProvider, Adapter> = {
  TALLY: tallyAdapter,
  ODOO: odooAdapter,
  ZOHO_BOOKS: zohoAdapter,
  MYBILLBOOK: myBillBookAdapter,
  VYAPAR: vyaparAdapter,
  GENERIC_FILE: genericFileAdapter,
};

export const adapterFor = (provider: IntegrationProvider): Adapter => ADAPTERS[provider];

export const isApiAdapter = (a: Adapter): a is ApiAdapter => a.transport === "API";
export const isConnectorAdapter = (a: Adapter): a is ConnectorAdapter => a.transport === "CONNECTOR";
export const isFileAdapter = (a: Adapter): a is FileAdapter => a.transport === "FILE";

export const API_PROVIDERS = (Object.keys(ADAPTERS) as IntegrationProvider[]).filter((p) => ADAPTERS[p].transport === "API");
