/**
 * Billing v2 phase 7 (docs/billing §8 live path; §13 scenario 11): the public
 * REST API (OAuth2 client credentials, per-shop scopes), the Tally connector's
 * two-way books endpoint, and the connector flags. Both layouts.
 */
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/auth", () => ({ auth: async () => null, handlers: {}, signIn: async () => {}, signOut: async () => {} }));

import { GET as booksGet, POST as booksPost } from "@/app/api/public/v1/books/route";
import { GET as openapi } from "@/app/api/public/v1/openapi.json/route";
import { GET as partiesGet } from "@/app/api/public/v1/parties/route";
import { GET as stockGet, PATCH as stockPatch } from "@/app/api/public/v1/stock/route";
import { POST as tokenPost } from "@/app/api/public/v1/oauth/token/route";
import { GET as connectorBooksGet, POST as connectorBooksPost } from "@/app/api/connector/v1/books/route";
import { db } from "@/server/db";
import { accSalesInvoices, featureFlags, shopProducts, type FeatureFlagKey } from "@/server/db/schema";
import { createParty } from "@/server/accounts/parties";
import { createSalesInvoice } from "@/server/accounts/sales";
import { issueConnectorToken, saveIntegration } from "@/server/integrations/connections";
import { integrationSyncEnabled } from "@/server/integrations/inventory-sync-flag";
import { createApiClient, revokeApiClient } from "@/server/public-api/auth";
import { addDaysIso, gstin, gstShop, IST_TODAY, resetBatchE } from "../helpers/batch-e";
import { createUser, resetDatabase } from "../helpers/fixtures";

const today = IST_TODAY();

async function flag(key: FeatureFlagKey, enabled: boolean) {
  await db.insert(featureFlags).values({ key, enabled }).onConflictDoUpdate({ target: featureFlags.key, set: { enabled } });
}

async function send(handler: (r: NextRequest) => Promise<Response>, url: string, init: { method?: string; token?: string; body?: string; contentType?: string } = {}) {
  const res = await handler(
    new NextRequest(`http://localhost${url}`, {
      method: init.method ?? "GET",
      headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.contentType ? { "content-type": init.contentType } : {}) },
      body: init.body,
    }),
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json: json as Record<string, unknown> & { data?: unknown } };
}

const tokenFor = async (clientId: string, clientSecret: string, scope?: string) =>
  send(tokenPost as never, "/api/public/v1/oauth/token", { method: "POST", contentType: "application/x-www-form-urlencoded", body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret, ...(scope ? { scope } : {}) }).toString() });

beforeEach(async () => {
  await resetDatabase();
  await resetBatchE();
  await db.execute(sql`DELETE FROM feature_flags WHERE key IN ('billing_v2', 'tally_connector', 'zoho_connector', 'odoo_connector')`);
  await flag("billing_v2", true);
  await createUser({ role: "ADMIN" });
});

describe("public REST API (OAuth2 client credentials)", () => {
  it("issues scoped tokens; reads books, stock and parties; writes vouchers and item updates; revocation ends access", async () => {
    const s = await gstShop();
    await createParty(s.shop.id, { kind: "CUSTOMER", name: "Hotel Sunrise", gstin: gstin("27", "AAACH1234K") }, s.owner.id);
    const { client, clientSecret } = await createApiClient(s.shop.id, { name: "My ERP", scopes: ["books:read", "books:write", "stock:read", "stock:write", "parties:read"] }, s.owner);

    expect((await tokenFor(client.clientId, "wrong")).status).toBe(401);
    expect((await tokenFor(client.clientId, clientSecret, "invoices:read")).json.error).toBe("invalid_scope");
    const t = await tokenFor(client.clientId, clientSecret);
    expect(t.status).toBe(200);
    const token = String(t.json.access_token);
    expect(t.json).toMatchObject({ token_type: "Bearer", expires_in: 3600 });

    const range = `from=${addDaysIso(today, -30)}&to=${addDaysIso(today, 1)}`;
    const books = await send(booksGet as never, `/api/public/v1/books?${range}`, { token });
    expect(books.status).toBe(200);
    expect((books.json.data ?? books.json) as { schema: string }).toMatchObject({ schema: "gokesari.books/1" });
    expect((await send(booksGet as never, `/api/public/v1/books?${range}`)).status).toBe(401);
    const partiesRes = (await send(partiesGet as never, "/api/public/v1/parties", { token })).json as unknown as { data?: { name: string }[] } | { name: string }[];
    expect((Array.isArray(partiesRes) ? partiesRes : (partiesRes.data ?? [])).map((p) => p.name)).toContain("Hotel Sunrise");
    expect((await send(stockGet as never, "/api/public/v1/stock", { token })).status).toBe(200);

    const narrow = await tokenFor(client.clientId, clientSecret, "parties:read");
    expect((await send(booksGet as never, `/api/public/v1/books?${range}`, { token: String(narrow.json.access_token) })).status).toBe(403);

    const voucher = {
      vouchers: [
        {
          key: `Sales|${today}|API-1`,
          type: "Sales",
          tallyType: "Sales",
          date: today,
          number: "API-1",
          narration: "From ERP",
          party: "Hotel Sunrise",
          ledgerLines: [{ ledger: "Hotel Sunrise", amountPaise: 10_500 }, { ledger: "Sales", amountPaise: -10_000 }, { ledger: "Output CGST", amountPaise: -250 }, { ledger: "Output SGST", amountPaise: -250 }],
          inventoryLines: [{ item: "Cow Milk", godown: "", qtyMilli: -2000, ratePaise: 5_000 }],
          taxLines: [],
        },
      ],
    };
    const posted = await send(booksPost as never, "/api/public/v1/books", { method: "POST", token, contentType: "application/json", body: JSON.stringify(voucher) });
    expect((posted.json.data ?? posted.json) as { vouchers: { created: number } }).toMatchObject({ vouchers: { created: 1 } });
    const again = await send(booksPost as never, "/api/public/v1/books", { method: "POST", token, contentType: "application/json", body: JSON.stringify(voucher) });
    expect((again.json.data ?? again.json) as { vouchers: { unchanged: number } }).toMatchObject({ vouchers: { unchanged: 1 } });
    expect(await db.select().from(accSalesInvoices).where(eq(accSalesInvoices.shopId, s.shop.id))).toHaveLength(1);

    const patched = await send(stockPatch as never, "/api/public/v1/stock", { method: "PATCH", token, contentType: "application/json", body: JSON.stringify({ stockItems: [{ key: "x", name: "Cow Milk", group: "Dairy", unit: "L", hsn: "04011000", gstRateBp: 500, cessBp: 0, mrpPaise: null, salePricePaise: null, barcode: null, openingQtyMilli: 0 }] }) });
    expect(patched.status).toBe(200);
    expect((await db.select().from(shopProducts).where(eq(shopProducts.id, s.milkSp.id)))[0].hsnCode).toBe("04011000");

    await revokeApiClient(s.shop.id, client.id, s.owner);
    expect((await send(stockGet as never, "/api/public/v1/stock", { token })).status).toBe(401);
    expect((await tokenFor(client.clientId, clientSecret)).status).toBe(401);

    const doc = await send(openapi as never, "/api/public/v1/openapi.json");
    expect(doc.json).toMatchObject({ openapi: "3.1.0" });
  });

  it("answers nothing while billing_v2 is off", async () => {
    const s = await gstShop();
    const { client, clientSecret } = await createApiClient(s.shop.id, { name: "ERP", scopes: ["stock:read"] }, s.owner);
    await flag("billing_v2", false);
    expect((await tokenFor(client.clientId, clientSecret)).status).toBe(404);
  });
});

describe("Tally connector: two-way books", () => {
  it("sends GoKesari's books as Tally XML and takes Tally's day book back (flag tally_connector)", async () => {
    const s = await gstShop();
    await flag("tally_connector", true);
    await saveIntegration(s.shop.id, { provider: "TALLY", config: { company: "Dairy GST" } }, { id: s.owner.id, role: "SHOP_OWNER", via: "OWNER" });
    const { token } = (await issueConnectorToken(s.shop.id, "Shop PC", { id: s.owner.id, role: "SHOP_OWNER", via: "OWNER" })) as unknown as { token: string };
    const party = await createParty(s.shop.id, { kind: "CUSTOMER", name: "Hotel Sunrise", gstin: gstin("27", "AAACH1234K") }, s.owner.id);
    await createSalesInvoice(s.shop.id, { partyId: party.id, paymentMode: "CREDIT", lines: [{ shopProductId: s.milkSp.id, description: "Cow Milk", hsn: "0401", qtyMilli: 1000, unit: "L", ratePaise: 5_000, gstRateBp: 500 }] }, s.owner);

    const out = await send(connectorBooksGet as never, "/api/connector/v1/books", { token });
    expect(out.status).toBe(200);
    expect(out.text).toContain("<ENVELOPE>");
    expect(out.text).toContain('VCHTYPE="Sales"');

    // Tally sends back its day book: what GoKesari sent is recognised, a new receipt is added.
    const dayBook = out.text.replace(
      "</REQUESTDATA>\n</IMPORTDATA>\n</BODY>",
      `<TALLYMESSAGE><VOUCHER VCHTYPE="Journal"><DATE>${today.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>T-9</VOUCHERNUMBER><NARRATION>Bank charges</NARRATION><ALLLEDGERENTRIES.LIST><LEDGERNAME>Expense</LEDGERNAME><AMOUNT>-15.00</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>15.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE>\n</REQUESTDATA>\n</IMPORTDATA>\n</BODY>`,
    );
    const back = await send(connectorBooksPost as never, "/api/connector/v1/books", { method: "POST", token, contentType: "text/xml", body: dayBook });
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ vouchers: { created: 1 }, conflicts: 0 });

    await flag("tally_connector", false);
    expect((await send(connectorBooksGet as never, "/api/connector/v1/books", { token })).status).toBe(409);
  });

  it("each connector flag switches on its own provider's live sync", async () => {
    expect(await integrationSyncEnabled()).toBe(false);
    await flag("zoho_connector", true);
    expect(await integrationSyncEnabled("ZOHO_BOOKS")).toBe(true);
    expect(await integrationSyncEnabled("TALLY")).toBe(false);
    expect(await integrationSyncEnabled()).toBe(true);
  });
});
