/**
 * Zoho Books adapter (Module 2) — REST v3 with OAuth 2.0, India data centre:
 *   accounts:  https://accounts.zoho.in/oauth/v2/{auth,token}
 *   API:       https://www.zohoapis.in/books/v3/…?organization_id=…
 *   header:    Authorization: Zoho-oauthtoken {access token}
 * GoKesari registers one Zoho API client (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET);
 * each shop connects its own Zoho Books with "Connect Zoho" (consent screen),
 * which stores the shop's refresh token encrypted. Access tokens are
 * refreshed automatically (they last an hour).
 *
 * Items with inventory tracking lose stock when an invoice is marked sent,
 * so the invoice itself is the stock reduction; a credit note for returned
 * goods puts stock back.
 *
 * No duplicates on retry: invoices and credit notes carry GoKesari's number
 * as both their number (ignore_auto_number_generation) and reference_number,
 * and are looked up by it before being created; Zoho refusing a number that
 * already exists is treated as "found".
 */
import { z } from "zod";

import type { CanonicalCreditNote, CanonicalInvoice, CanonicalItem } from "../canonical";
import { IntegrationError } from "../errors";
import type { AdapterContext, ApiAdapter, PushResult } from "../types";
import { gstState } from "@/lib/gst-states";

export const ZOHO_ACCOUNTS = "https://accounts.zoho.in";
export const ZOHO_API = "https://www.zohoapis.in/books/v3";
export const ZOHO_SCOPE = "ZohoBooks.fullaccess.all";

export const zohoConfigSchema = z.object({
  organizationId: z.string().trim().regex(/^\d+$/, "Choose your Zoho Books organisation."),
  customerName: z.string().trim().min(1).max(200).default("GoKesari Online Customers"),
});
export const zohoCredentialsSchema = z.object({
  refreshToken: z.string().min(10),
  accessToken: z.string().optional(),
  accessTokenExpiresAt: z.number().optional(),
});

export function zohoClient() {
  const clientId = process.env.ZOHO_CLIENT_ID?.trim();
  const clientSecret = process.env.ZOHO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new IntegrationError("NOT_CONFIGURED", "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET are not set on the server.");
  }
  return { clientId, clientSecret };
}

/** Exchanges an authorization code (connect) or a refresh token for tokens. */
export async function zohoToken(
  fetchFn: typeof fetch,
  params: { code: string; redirectUri: string } | { refreshToken: string },
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
  const { clientId, clientSecret } = zohoClient();
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  if ("code" in params) {
    form.set("grant_type", "authorization_code");
    form.set("code", params.code);
    form.set("redirect_uri", params.redirectUri);
  } else {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", params.refreshToken);
  }
  let res: Response;
  try {
    res = await fetchFn(`${ZOHO_ACCOUNTS}/oauth/v2/token`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new IntegrationError("UNREACHABLE", String(error));
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new IntegrationError(body.error === "invalid_code" || body.error === "invalid_client" ? "AUTH_FAILED" : "TOKEN_EXPIRED", body.error ?? `HTTP ${res.status}`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in ?? 3600 };
}

async function accessToken(ctx: AdapterContext): Promise<string> {
  const creds = zohoCredentialsSchema.parse(ctx.credentials);
  if (creds.accessToken && creds.accessTokenExpiresAt && creds.accessTokenExpiresAt > Date.now() + 60_000) return creds.accessToken;
  const fresh = await zohoToken(ctx.fetch, { refreshToken: creds.refreshToken });
  const next = { ...creds, accessToken: fresh.accessToken, accessTokenExpiresAt: Date.now() + fresh.expiresIn * 1000 };
  await ctx.saveCredentials(next);
  ctx.credentials = next;
  return fresh.accessToken;
}

interface ZohoReply {
  code: number;
  message: string;
  [key: string]: unknown;
}

export async function zohoCall<T extends ZohoReply>(
  ctx: AdapterContext,
  method: "GET" | "POST",
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const { organizationId } = zohoConfigSchema.parse(ctx.config);
  const url = new URL(`${ZOHO_API}${path}`);
  url.searchParams.set("organization_id", organizationId);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await ctx.fetch(url, {
      method,
      headers: { Authorization: `Zoho-oauthtoken ${await accessToken(ctx)}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (error instanceof IntegrationError) throw error;
    throw new IntegrationError("UNREACHABLE", `${path}: ${String(error)}`);
  }
  const reply = (await res.json().catch(() => ({ code: -1, message: `HTTP ${res.status}` }))) as T;
  if (res.status === 401) throw new IntegrationError("TOKEN_EXPIRED", reply.message);
  if (res.status === 429) throw new IntegrationError("RATE_LIMITED", reply.message);
  if (res.status >= 500) throw new IntegrationError("UNREACHABLE", `HTTP ${res.status} ${reply.message}`);
  return reply;
}

function ok<T extends ZohoReply>(reply: T, what: string): T {
  if (reply.code !== 0) throw new IntegrationError("REJECTED", `${what}: ${reply.message} (code ${reply.code})`);
  return reply;
}

/* ------------------------------------------------------------------- pull */

interface ZohoItem {
  item_id: string;
  name: string;
  sku?: string;
  ean?: string;
  upc?: string;
  unit?: string;
  rate?: number;
  stock_on_hand?: number;
  hsn_or_sac?: string;
  tax_percentage?: number;
  is_taxable?: boolean;
  status?: string;
}

async function readItems(ctx: AdapterContext): Promise<CanonicalItem[]> {
  const out: CanonicalItem[] = [];
  for (let page = 1; page < 200; page += 1) {
    const reply = ok(
      await zohoCall<ZohoReply & { items: ZohoItem[]; page_context?: { has_more_page?: boolean } }>(ctx, "GET", "/items", {
        page: String(page),
        per_page: "200",
        filter_by: "Status.Active",
      }),
      "Items",
    );
    for (const item of reply.items ?? []) {
      const rate = item.tax_percentage ?? null;
      const gross = item.rate != null && rate ? item.rate * (1 + rate / 100) : item.rate;
      out.push({
        externalId: item.item_id,
        name: item.name,
        sku: item.sku || null,
        barcode: item.ean || item.upc || null,
        unit: item.unit || null,
        stock: item.stock_on_hand ?? null,
        pricePaise: gross != null ? Math.round(gross * 100) : null,
        mrpPaise: null,
        hsn: item.hsn_or_sac || null,
        gstRateBp: rate != null ? Math.round(rate * 100) : null,
      });
    }
    if (!reply.page_context?.has_more_page) break;
  }
  return out;
}

/* ------------------------------------------------------------------- push */

async function customerId(ctx: AdapterContext, doc: CanonicalInvoice | CanonicalCreditNote): Promise<string> {
  const config = zohoConfigSchema.parse(ctx.config);
  const name = doc.buyer.gstin ? doc.buyer.name : config.customerName;
  const found = ok(
    await zohoCall<ZohoReply & { contacts: { contact_id: string; gst_no?: string }[] }>(ctx, "GET", "/contacts", {
      contact_name: name,
      contact_type: "customer",
    }),
    "Customer search",
  );
  const match = found.contacts?.find((c) => !doc.buyer.gstin || c.gst_no === doc.buyer.gstin);
  if (match) return match.contact_id;
  const state = gstState(doc.buyer.stateCode ?? doc.placeOfSupply ?? doc.seller.stateCode ?? null);
  const created = ok(
    await zohoCall<ZohoReply & { contact: { contact_id: string } }>(ctx, "POST", "/contacts", {}, {
      contact_name: name,
      contact_type: "customer",
      gst_treatment: doc.buyer.gstin ? "business_gst" : "consumer",
      ...(doc.buyer.gstin ? { gst_no: doc.buyer.gstin } : {}),
      ...(state ? { place_of_contact: state.alpha } : {}),
    }),
    "Customer",
  );
  return created.contact.contact_id;
}

async function taxIdFor(ctx: AdapterContext, rateBp: number, supply: "INTRA" | "INTER", cache: Map<string, string>): Promise<string | null> {
  if (rateBp === 0) return null;
  if (cache.size === 0) {
    const reply = ok(
      await zohoCall<ZohoReply & { taxes: { tax_id: string; tax_name: string; tax_percentage: number; tax_specific_type?: string; is_tax_group?: boolean }[] }>(
        ctx,
        "GET",
        "/settings/taxes",
      ),
      "Taxes",
    );
    for (const t of reply.taxes ?? []) {
      const inter = /igst/i.test(t.tax_name) || t.tax_specific_type === "igst";
      const bp = Math.round(t.tax_percentage * 100);
      const key = `${inter ? "INTER" : "INTRA"}:${bp}`;
      // Intra-state GST is a group of CGST + SGST; prefer the group.
      if (!cache.has(key) || t.is_tax_group) cache.set(key, t.tax_id);
    }
  }
  const id = cache.get(`${supply}:${rateBp}`);
  if (!id) throw new IntegrationError("TAX_NOT_MAPPED", `No ${supply === "INTER" ? "IGST" : "GST"} tax of ${rateBp / 100}% in Zoho Books.`);
  return id;
}

async function lineItems(ctx: AdapterContext, doc: CanonicalInvoice | CanonicalCreditNote) {
  const cache = new Map<string, string>();
  const out = [];
  for (const line of doc.lines) {
    const taxId = await taxIdFor(ctx, line.gstRateBp, doc.supplyType, cache);
    out.push({
      ...(line.externalItemId ? { item_id: line.externalItemId } : { name: line.name }),
      description: line.name,
      quantity: line.quantity,
      rate: Math.round(line.taxablePaise / line.quantity) / 100,
      ...(taxId ? { tax_id: taxId } : {}),
      ...(line.hsn ? { hsn_or_sac: line.hsn } : {}),
    });
  }
  return out;
}

async function findDocument(ctx: AdapterContext, path: "/invoices" | "/creditnotes", number: string): Promise<string | null> {
  const key = path === "/invoices" ? "invoices" : "creditnotes";
  const reply = ok(await zohoCall<ZohoReply & Record<string, unknown>>(ctx, "GET", path, { reference_number: number }), "Search");
  const rows = (reply[key] ?? []) as { invoice_id?: string; creditnote_id?: string; status?: string }[];
  const live = rows.find((r) => r.status !== "void");
  return live ? (live.invoice_id ?? live.creditnote_id ?? null) : null;
}

async function pushDocument(ctx: AdapterContext, doc: CanonicalInvoice | CanonicalCreditNote, kind: "INVOICE" | "CREDIT_NOTE"): Promise<PushResult> {
  const path = kind === "INVOICE" ? "/invoices" : "/creditnotes";
  const existing = await findDocument(ctx, path, doc.number);
  if (existing) return { externalRef: existing, created: false };
  const state = gstState(doc.placeOfSupply ?? doc.buyer.stateCode ?? doc.seller.stateCode ?? null);
  const body: Record<string, unknown> = {
    customer_id: await customerId(ctx, doc),
    [kind === "INVOICE" ? "invoice_number" : "creditnote_number"]: doc.number,
    reference_number: doc.number,
    date: doc.date,
    is_inclusive_tax: false,
    gst_treatment: doc.buyer.gstin ? "business_gst" : "consumer",
    ...(doc.buyer.gstin ? { gst_no: doc.buyer.gstin } : {}),
    ...(state ? { place_of_supply: state.alpha } : {}),
    line_items: await lineItems(ctx, doc),
    notes: `GoKesari order ${doc.orderNumber}`,
  };
  if (kind === "CREDIT_NOTE") {
    const invoiceId = await findDocument(ctx, "/invoices", (doc as CanonicalCreditNote).againstInvoice.number);
    if (invoiceId) body.invoice_id = invoiceId;
  }
  const reply = await zohoCall<ZohoReply & Record<string, { invoice_id?: string; creditnote_id?: string }>>(
    ctx,
    "POST",
    path,
    { ignore_auto_number_generation: "true" },
    body,
  );
  if (reply.code !== 0) {
    // Number already used: a previous attempt created it — find and use it.
    if (/already exists/i.test(reply.message)) {
      const found = await findDocument(ctx, path, doc.number);
      if (found) return { externalRef: found, created: false };
      throw new IntegrationError("DUPLICATE_NUMBER", reply.message);
    }
    throw new IntegrationError("REJECTED", `${reply.message} (code ${reply.code})`);
  }
  const record = kind === "INVOICE" ? reply.invoice : reply.creditnote;
  const id = (kind === "INVOICE" ? record?.invoice_id : record?.creditnote_id) as string;
  // Marking it sent/open makes it count (and moves stock for tracked items).
  ok(await zohoCall<ZohoReply>(ctx, "POST", `${path}/${id}/status/${kind === "INVOICE" ? "sent" : "open"}`), "Status");
  return { externalRef: id, created: true };
}

export const zohoAdapter: ApiAdapter = {
  provider: "ZOHO_BOOKS",
  transport: "API",
  label: "Zoho Books",
  description: "Your Zoho Books (India), connected with your Zoho login. Items, stock and prices come in; invoices and credit notes go out.",
  configSchema: zohoConfigSchema as unknown as z.ZodType<Record<string, unknown>>,
  credentialsSchema: zohoCredentialsSchema as unknown as z.ZodType<Record<string, unknown>>,

  async testConnection(ctx) {
    const reply = ok(
      await zohoCall<ZohoReply & { organizations?: { organization_id: string; name: string }[] }>(ctx, "GET", "/organizations"),
      "Organisations",
    );
    const { organizationId } = zohoConfigSchema.parse(ctx.config);
    const org = reply.organizations?.find((o) => o.organization_id === organizationId);
    if (!org) throw new IntegrationError("NOT_CONFIGURED", "The chosen organisation is not in this Zoho account.");
    return `Connected to Zoho Books — ${org.name}.`;
  },
  pullItems: readItems,
  pushInvoice: (ctx, invoice) => pushDocument(ctx, invoice, "INVOICE"),
  pushCreditNote: (ctx, note) => pushDocument(ctx, note, "CREDIT_NOTE"),
};
