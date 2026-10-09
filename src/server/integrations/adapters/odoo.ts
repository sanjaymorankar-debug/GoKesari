/**
 * Odoo adapter (Module 2) — Odoo 19+ through the JSON-2 API only:
 *   POST {url}/json/2/{model}/{method}   body = named arguments
 *   Authorization: bearer {API key}      X-Odoo-Database: {database}
 * XML-RPC / JSON-RPC are deprecated in Odoo 19 and are not used. Shops on
 * Odoo 17/18 have no JSON-2 and are not supported by this adapter (decision,
 * 8 Oct 2026).
 *
 * Models: product.product (items, stock, price, HSN), account.tax (rates),
 * account.move (customer invoices `out_invoice`, credit notes `out_refund`),
 * stock.quant (stock: an Odoo invoice does not move stock by itself, so the
 * sold quantity is taken off the configured stock location as an inventory
 * adjustment; a credit note for returned goods puts it back).
 *
 * No duplicates on retry: the invoice/credit note is looked up by `ref`
 * (GoKesari's number) before it is created; the stock step runs once per job
 * (recorded with a checkpoint before the next step).
 */
import { z } from "zod";

import type { CanonicalCreditNote, CanonicalInvoice, CanonicalItem, CanonicalLine } from "../canonical";
import { IntegrationError } from "../errors";
import { assertPublicUrl } from "../net";
import type { AdapterContext, ApiAdapter, PushResult } from "../types";

export const odooConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine(
      (u) => u.startsWith("https://") || (process.env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u)),
      "Use the https:// address of your Odoo.",
    ),
  database: z.string().trim().min(1).max(200),
  /** res.partner for online customers; found or created by name when not set. */
  customerName: z.string().trim().min(1).max(200).default("GoKesari Online Customers"),
  /** stock.location the sold stock is taken from (WH/Stock). */
  stockLocationId: z.number().int().positive().optional(),
  /** Reduce Odoo stock for each invoice (and put it back for returns). */
  adjustStock: z.boolean().default(true),
});
export const odooCredentialsSchema = z.object({ apiKey: z.string().trim().min(10).max(500) });

type OdooConfig = z.infer<typeof odooConfigSchema>;

/** One JSON-2 call. Errors are mapped to the catalogue. */
export async function odooCall<T>(ctx: AdapterContext, model: string, method: string, args: Record<string, unknown>): Promise<T> {
  const config = odooConfigSchema.parse(ctx.config);
  const { apiKey } = odooCredentialsSchema.parse(ctx.credentials);
  const url = `${config.url.replace(/\/+$/, "")}/json/2/${model}/${method}`;
  // The address is the shop's: never let it point into GoKesari's own network.
  if (ctx.fetch === fetch) await assertPublicUrl(url);
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `bearer ${apiKey}`,
        "X-Odoo-Database": config.database,
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "GoKesari-Integration/1",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
      // A redirect could lead to an internal address the check above did not see.
      redirect: "error",
    });
  } catch (error) {
    throw new IntegrationError("UNREACHABLE", `${model}/${method}: ${String(error)}`);
  }
  const body = await response.text();
  if (response.ok) return (body ? JSON.parse(body) : null) as T;
  let message = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { name?: string; message?: string };
    message = `${parsed.name ?? ""}: ${parsed.message ?? ""}`.trim();
  } catch {
    /* keep the raw text */
  }
  if (response.status === 401) throw new IntegrationError("AUTH_FAILED", message);
  if (response.status === 403) throw new IntegrationError("AUTH_FAILED", `No access: ${message}`);
  if (response.status === 429) throw new IntegrationError("RATE_LIMITED", message);
  if (response.status >= 500 && !/ValidationError|UserError|AccessError/.test(message)) {
    throw new IntegrationError("UNREACHABLE", `HTTP ${response.status} ${message}`);
  }
  throw new IntegrationError("REJECTED", `${model}/${method}: ${message}`);
}

/* ------------------------------------------------------------------- pull */

interface OdooProduct {
  id: number;
  name: string;
  default_code: string | false;
  barcode: string | false;
  list_price: number;
  qty_available: number;
  uom_id: [number, string] | false;
  taxes_id: number[];
  l10n_in_hsn_code?: string | false;
}

interface OdooTax {
  id: number;
  amount: number;
  type_tax_use: string;
  name: string;
  price_include?: boolean;
}

const str = (v: string | false | null | undefined) => (v ? String(v) : null);

async function readItems(ctx: AdapterContext): Promise<CanonicalItem[]> {
  const products: OdooProduct[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = await odooCall<OdooProduct[]>(ctx, "product.product", "search_read", {
      domain: [
        ["sale_ok", "=", true],
        ["active", "=", true],
      ],
      fields: ["name", "default_code", "barcode", "list_price", "qty_available", "uom_id", "taxes_id", "l10n_in_hsn_code"],
      limit: 500,
      offset,
      order: "id",
    });
    products.push(...page);
    if (page.length < 500) break;
  }
  const taxIds = [...new Set(products.flatMap((p) => p.taxes_id ?? []))];
  const taxes = taxIds.length
    ? await odooCall<OdooTax[]>(ctx, "account.tax", "search_read", {
        domain: [["id", "in", taxIds]],
        fields: ["amount", "type_tax_use", "name", "price_include"],
      })
    : [];
  const taxById = new Map(taxes.map((t) => [t.id, t]));
  return products.map((p) => {
    const saleTax = (p.taxes_id ?? []).map((id) => taxById.get(id)).find((t) => t && t.type_tax_use === "sale");
    const ratePct = saleTax?.amount ?? null;
    // GoKesari prices include GST; Odoo's list price usually excludes it.
    const gross = saleTax && !saleTax.price_include && ratePct ? p.list_price * (1 + ratePct / 100) : p.list_price;
    return {
      externalId: String(p.id),
      name: p.name,
      sku: str(p.default_code),
      barcode: str(p.barcode),
      unit: p.uom_id ? p.uom_id[1] : null,
      stock: p.qty_available,
      pricePaise: Math.round(gross * 100),
      mrpPaise: null,
      hsn: str(p.l10n_in_hsn_code ?? false),
      gstRateBp: ratePct != null ? Math.round(ratePct * 100) : null,
    };
  });
}

/* ------------------------------------------------------------------- push */

async function partnerFor(ctx: AdapterContext, config: OdooConfig, doc: CanonicalInvoice | CanonicalCreditNote): Promise<number> {
  const domain = doc.buyer.gstin ? [["vat", "=", doc.buyer.gstin]] : [["name", "=", config.customerName]];
  const found = await odooCall<{ id: number }[]>(ctx, "res.partner", "search_read", { domain, fields: ["id"], limit: 1 });
  if (found[0]) return found[0].id;
  const vals = doc.buyer.gstin
    ? { name: doc.buyer.name, vat: doc.buyer.gstin, is_company: true }
    : { name: config.customerName, is_company: true };
  const [id] = await odooCall<number[]>(ctx, "res.partner", "create", { vals_list: [vals] });
  return id;
}

/** Sale tax for a rate: IGST for inter-state supplies, the CGST+SGST group otherwise. */
async function taxFor(ctx: AdapterContext, rateBp: number, supply: "INTRA" | "INTER", cache: Map<string, number>): Promise<number | null> {
  if (rateBp === 0) return null;
  const key = `${supply}:${rateBp}`;
  if (cache.has(key)) return cache.get(key)!;
  const taxes = await odooCall<OdooTax[]>(ctx, "account.tax", "search_read", {
    domain: [
      ["type_tax_use", "=", "sale"],
      ["amount", "=", rateBp / 100],
    ],
    fields: ["name", "amount", "type_tax_use", "price_include"],
  });
  const pick = taxes.find((t) => (supply === "INTER" ? /igst/i.test(t.name) : !/igst/i.test(t.name)) && !t.price_include);
  if (!pick) throw new IntegrationError("TAX_NOT_MAPPED", `No ${supply === "INTER" ? "IGST" : "GST"} sale tax of ${rateBp / 100}% in Odoo.`);
  cache.set(key, pick.id);
  return pick.id;
}

async function invoiceLines(ctx: AdapterContext, doc: CanonicalInvoice | CanonicalCreditNote) {
  const cache = new Map<string, number>();
  const lines: unknown[] = [];
  for (const line of doc.lines) {
    const tax = await taxFor(ctx, line.gstRateBp, doc.supplyType, cache);
    lines.push([
      0,
      0,
      {
        ...(line.externalItemId ? { product_id: Number(line.externalItemId) } : {}),
        name: line.hsn ? `${line.name} (HSN ${line.hsn})` : line.name,
        quantity: line.quantity,
        price_unit: Math.round(line.taxablePaise / line.quantity) / 100,
        tax_ids: tax ? [[6, 0, [tax]]] : [],
      },
    ]);
  }
  return lines;
}

async function findMove(ctx: AdapterContext, moveType: string, ref: string): Promise<number | null> {
  const found = await odooCall<{ id: number }[]>(ctx, "account.move", "search_read", {
    domain: [
      ["move_type", "=", moveType],
      ["ref", "=", ref],
      ["state", "!=", "cancel"],
    ],
    fields: ["id"],
    limit: 1,
  });
  return found[0]?.id ?? null;
}

async function adjustStock(ctx: AdapterContext, config: OdooConfig, lines: CanonicalLine[], sign: -1 | 1): Promise<void> {
  if (!config.adjustStock || !config.stockLocationId) return;
  const ids: number[] = [];
  for (const line of lines) {
    if (!line.externalItemId) continue;
    const productId = Number(line.externalItemId);
    const quants = await odooCall<{ id: number; quantity: number }[]>(ctx, "stock.quant", "search_read", {
      domain: [
        ["product_id", "=", productId],
        ["location_id", "=", config.stockLocationId],
      ],
      fields: ["id", "quantity"],
      limit: 1,
    });
    if (quants[0]) {
      await odooCall(ctx, "stock.quant", "write", {
        ids: [quants[0].id],
        vals: { inventory_quantity: quants[0].quantity + sign * line.quantity },
      });
      ids.push(quants[0].id);
    } else {
      const [id] = await odooCall<number[]>(ctx, "stock.quant", "create", {
        vals_list: [{ product_id: productId, location_id: config.stockLocationId, inventory_quantity: sign * line.quantity }],
      });
      ids.push(id);
    }
  }
  if (ids.length > 0) await odooCall(ctx, "stock.quant", "action_apply_inventory", { ids });
}

async function pushMove(
  ctx: AdapterContext,
  doc: CanonicalInvoice | CanonicalCreditNote,
  moveType: "out_invoice" | "out_refund",
): Promise<PushResult> {
  const config = odooConfigSchema.parse(ctx.config);
  let id = await findMove(ctx, moveType, doc.number);
  const created = id == null;
  if (id == null) {
    const partnerId = await partnerFor(ctx, config, doc);
    const vals: Record<string, unknown> = {
      move_type: moveType,
      partner_id: partnerId,
      invoice_date: doc.date,
      ref: doc.number,
      narration: `GoKesari order ${doc.orderNumber}`,
      invoice_line_ids: await invoiceLines(ctx, doc),
    };
    if (moveType === "out_refund") {
      const original = await findMove(ctx, "out_invoice", (doc as CanonicalCreditNote).againstInvoice.number);
      if (original) vals.reversed_entry_id = original;
    }
    [id] = await odooCall<number[]>(ctx, "account.move", "create", { vals_list: [vals] });
    await odooCall(ctx, "account.move", "action_post", { ids: [id] });
  }
  // Stock moves once per job (checkpointed), whether the move was new or found.
  if (!ctx.state.stockDone) {
    const restock = moveType === "out_refund" ? (doc as CanonicalCreditNote).restock : true;
    if (restock) await adjustStock(ctx, config, doc.lines, moveType === "out_invoice" ? -1 : 1);
    await ctx.checkpoint({ ...ctx.state, stockDone: true, moveId: id });
  }
  return { externalRef: String(id), created };
}

export const odooAdapter: ApiAdapter = {
  provider: "ODOO",
  transport: "API",
  label: "Odoo (version 19 or later)",
  description: "Your Odoo through its JSON-2 API with an API key (Odoo 19+). Products, stock and prices come in; invoices and credit notes go out.",
  configSchema: odooConfigSchema as unknown as z.ZodType<Record<string, unknown>>,
  credentialsSchema: odooCredentialsSchema as unknown as z.ZodType<Record<string, unknown>>,

  async testConnection(ctx) {
    const companies = await odooCall<{ name: string }[]>(ctx, "res.company", "search_read", { domain: [], fields: ["name"], limit: 5 });
    return `Connected to Odoo — ${companies.map((c) => c.name).join(", ") || "no company"}.`;
  },
  pullItems: readItems,
  pushInvoice: (ctx, invoice) => pushMove(ctx, invoice, "out_invoice"),
  pushCreditNote: (ctx, note) => pushMove(ctx, note, "out_refund"),
};
