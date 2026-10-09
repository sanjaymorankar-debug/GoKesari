/**
 * Module 2 — accounting / inventory integration (docs/three-modules-2026-10).
 *
 * Real PostgreSQL; the shop's software is faked at the HTTP boundary (Odoo
 * JSON-2) or at the connector boundary (Tally XML replies). Covers the
 * brief's sync tests — retry with backoff, no duplicate invoice on retry or
 * on a lost reply, DEAD after N attempts with the owner told — plus connector
 * isolation between shops, write-only secrets, the pull conflict rules
 * (software wins stock and price, online orders stay reserved, never above
 * MRP), matching, file sync and change webhooks.
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserRole } from "@/server/db/schema";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; email: string; name: string | null; image: string | null; role: UserRole; status: "ACTIVE" };
  },
}));

vi.mock("@/server/auth", () => ({
  auth: async () => state.session,
  handlers: {},
  signIn: async () => {},
  signOut: async () => {},
}));

import { POST as connectorHello } from "@/app/api/connector/v1/hello/route";
import { GET as connectorJobs } from "@/app/api/connector/v1/jobs/route";
import { POST as connectorResult } from "@/app/api/connector/v1/jobs/[jobId]/result/route";
import { POST as webhookRoute } from "@/app/api/integrations/webhooks/[provider]/[integrationId]/route";
import { GET as integrationGet, PUT as integrationPut } from "@/app/api/shops/[id]/integration/route";
import { PUT as mappingPut } from "@/app/api/shops/[id]/integration/imports/[importId]/mapping/route";
import { POST as tokenCreate } from "@/app/api/shops/[id]/integration/tokens/route";
import { db } from "@/server/db";
import {
  domainEvents,
  integrationItemLinks,
  integrationJobs,
  orders,
  platformSettings,
  products,
  shopIntegrations,
  shopProducts,
  shops,
  taxInvoices,
  type ShopIntegration,
} from "@/server/db/schema";
import { voucherImportXml } from "@/server/integrations/adapters/tally";
import {
  assertIntegrationAccess,
  disconnectIntegration,
  issueWebhookSecret,
  saveIntegration,
  updateItemLink,
  type IntegrationActor,
} from "@/server/integrations/connections";
import { decryptCredentials, encryptCredentials } from "@/server/integrations/credentials";
import { createItemImport, exportDocuments, runItemImport, setImportMapping, startItemImport } from "@/server/integrations/file-sync";
import { BACKOFF_SECONDS, dispatchDueJobs, enqueueInvoicePush, retryJob } from "@/server/integrations/jobs";
import { assertPublicUrl, isPrivateAddress } from "@/server/integrations/net";
import { applyPulledItems } from "@/server/integrations/pull";
import { integrationSweep } from "@/server/integrations/sweep";
import { addToCart } from "@/server/services/cart";
import { checkout, updateOrderStatus } from "@/server/services/orders";
import { clearRuleCache } from "@/server/services/settings";
import { call } from "../helpers/http";
import {
  createCategory,
  createProduct,
  createShop,
  createShopProduct,
  createUser,
  createUserWithWallet,
  deliveryAddressId,
  resetDatabase,
} from "../helpers/fixtures";

let admin = { id: "", role: "ADMIN" as const };

beforeEach(async () => {
  await resetDatabase();
  gtinSeq = 0;
  await db.delete(platformSettings).where(inArray(platformSettings.key, ["invoicing", "mrp"]));
  clearRuleCache();
  admin = { id: (await createUser({ role: "ADMIN" })).id, role: "ADMIN" };
  state.session = null;
});

function signIn(user: { id: string; email: string; role: UserRole }) {
  state.session = { user: { id: user.id, email: user.email, name: "T", image: null, role: user.role, status: "ACTIVE" } };
}

let gtinSeq = 0;
async function shopWithMilk(opts: { gstin?: string } = {}) {
  const owner = await createUser({ role: "SHOP_OWNER" });
  const cat = await createCategory({ department: "DAIRY", name: "Milk" });
  const milk = await createProduct(cat.id, { name: "Amul Taaza Toned Milk 1L", unit: "L" });
  // GTINs are unique: the first shop of a test gets the barcode the tests pull with.
  const gtin = gtinSeq++ === 0 ? "8901262010017" : `89012620${String(gtinSeq).padStart(5, "0")}`;
  await db.update(products).set({ gstRateBp: 500, hsnCode: "0401", gtin }).where(eq(products.id, milk.id));
  const shop = await createShop(owner.id, { name: "Dairy One" });
  if (opts.gstin) await db.update(shops).set({ gstin: opts.gstin, gstStatus: "REGISTERED" }).where(eq(shops.id, shop.id));
  const sp = await createShopProduct(shop.id, milk.id, { onlinePricePaise: 10_500, onlineStock: 50 });
  return { owner, shop, sp, milk, cat };
}

const ownerActor = (ownerId: string): IntegrationActor => ({ id: ownerId, role: "SHOP_OWNER", via: "OWNER" });

async function connectOdoo(shopId: string, ownerId: string) {
  await saveIntegration(
    shopId,
    { provider: "ODOO", config: { url: "https://shop.example.com", database: "shopdb", stockLocationId: 8 }, credentials: { apiKey: "odoo-secret-key-123" } },
    ownerActor(ownerId),
  );
  const [row] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.shopId, shopId));
  // The initial pull queued on connect is not what these tests are about.
  await db.delete(integrationJobs).where(eq(integrationJobs.integrationId, row.id));
  return row;
}

async function deliveredOrder(spId: string, requestId: string) {
  const { user } = await createUserWithWallet({ balancePaise: 500_000 });
  await addToCart(user.id, spId, 1);
  const { orders: placed } = await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId });
  for (const s of ["ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"] as const) {
    await updateOrderStatus(placed[0].id, s, admin);
  }
  return placed[0];
}

/** A fake Odoo 19 JSON-2 server. `failNext` makes the next N calls fail at the network. */
function fakeOdoo() {
  const moves: { id: number; ref: string; move_type: string }[] = [];
  const quants = new Map<number, number>([[1, 40]]);
  const calls: string[] = [];
  const odoo = {
    moves,
    calls,
    failNext: 0,
    /** The reply to the next create is lost after Odoo saved it. */
    loseNextCreateReply: false,
    authFails: false,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const [, model, method] = /\/json\/2\/([^/]+)\/([^/?]+)/.exec(url) ?? [];
      calls.push(`${model}.${method}`);
      if (odoo.failNext > 0) {
        odoo.failNext -= 1;
        throw new TypeError("fetch failed");
      }
      if (odoo.authFails) return new Response(JSON.stringify({ name: "AccessDenied", message: "bad key" }), { status: 401 });
      expect((init?.headers as Record<string, string>).Authorization).toBe("bearer odoo-secret-key-123");
      const body = JSON.parse(String(init?.body ?? "{}"));
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (model === "account.move" && method === "search_read") {
        const ref = body.domain.find((d: unknown[]) => d[0] === "ref")[2];
        return json(moves.filter((m) => m.ref === ref).map((m) => ({ id: m.id })));
      }
      if (model === "account.move" && method === "create") {
        const vals = body.vals_list[0];
        const id = moves.length + 100;
        moves.push({ id, ref: vals.ref, move_type: vals.move_type });
        if (odoo.loseNextCreateReply) {
          odoo.loseNextCreateReply = false;
          throw new TypeError("fetch failed"); // saved in Odoo, reply lost on the way back
        }
        return json([id]);
      }
      if (model === "res.partner" && method === "search_read") return json([{ id: 7 }]);
      if (model === "account.tax" && method === "search_read") return json([{ id: 3, name: "GST 5%", amount: 5, type_tax_use: "sale", price_include: false }]);
      if (model === "stock.quant" && method === "search_read") return json([{ id: 1, quantity: quants.get(1) }]);
      if (model === "stock.quant" && method === "write") {
        quants.set(1, body.vals.inventory_quantity);
        return json(true);
      }
      return json(true);
    }) as typeof fetch,
  };
  return odoo;
}

/* ================================================================ secrets */

describe("credentials", () => {
  it("are encrypted at rest (AES-256-GCM, versioned) and tampering is detected", () => {
    const stored = encryptCredentials({ apiKey: "abc-123-secret" });
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain("abc-123-secret");
    expect(decryptCredentials(stored)).toEqual({ apiKey: "abc-123-secret" });
    const raw = Buffer.from(stored.slice(3), "base64");
    raw[raw.length - 1] ^= 1;
    expect(() => decryptCredentials(`v1:${raw.toString("base64")}`)).toThrow();
  });

  it("are write-only through the API, and only the owner may change the connection", async () => {
    const { owner, shop } = await shopWithMilk();
    const ownerUser = { id: owner.id, email: owner.email, role: "SHOP_OWNER" as const };
    signIn(ownerUser);
    const saved = await call(integrationPut as never, `/api/shops/${shop.id}/integration`, {
      method: "PUT",
      params: { id: shop.id },
      body: { provider: "ODOO", config: { url: "https://shop.example.com", database: "shopdb" }, credentials: { apiKey: "odoo-secret-key-123" } },
    });
    expect(saved.status).toBe(200);
    const got = await call(integrationGet as never, `/api/shops/${shop.id}/integration`, { params: { id: shop.id } });
    expect(got.status).toBe(200);
    expect(got.body.integration.hasCredentials).toBe(true);
    expect(JSON.stringify(got.body)).not.toContain("odoo-secret-key-123");
    const [row] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.shopId, shop.id));
    expect(row.credentialsEncrypted).not.toContain("odoo-secret-key-123");

    // Another shop's owner, and the shop's own catalogue staff, are refused.
    const other = await createUser({ role: "SHOP_OWNER" });
    signIn({ id: other.id, email: other.email, role: "SHOP_OWNER" });
    expect((await call(integrationGet as never, `/api/shops/${shop.id}/integration`, { params: { id: shop.id } })).status).toBe(403);
    // Operators may look (support) but not change it.
    const operator = await createUser({ role: "OPERATOR" });
    await expect(assertIntegrationAccess(shop.id, operator, "view")).resolves.toMatchObject({ via: "SUPPORT" });
    await expect(assertIntegrationAccess(shop.id, operator, "manage")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assertIntegrationAccess(shop.id, { id: admin.id, role: "ADMIN" }, "manage")).resolves.toMatchObject({ via: "SUPPORT" });
  });

  it("keeps one live connection per shop: switching software needs a disconnect", async () => {
    const { owner, shop } = await shopWithMilk();
    await connectOdoo(shop.id, owner.id);
    await expect(saveIntegration(shop.id, { provider: "TALLY", config: { company: "Dairy One" } }, ownerActor(owner.id))).rejects.toMatchObject({ code: "CONFLICT" });
    await disconnectIntegration(shop.id, ownerActor(owner.id));
    const [gone] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.shopId, shop.id));
    expect(gone).toMatchObject({ status: "DISCONNECTED", credentialsEncrypted: null });
    await expect(saveIntegration(shop.id, { provider: "TALLY", config: { company: "Dairy One" } }, ownerActor(owner.id))).resolves.toMatchObject({ provider: "TALLY" });
  });

  it("refuses software addresses inside GoKesari's own network (SSRF)", async () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.10", "172.20.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    const lookup = (async (host: string) => [{ address: host === "evil.example" ? "10.1.2.3" : "93.184.216.34", family: 4 }]) as never;
    await expect(assertPublicUrl("http://shop.example.com", lookup)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(assertPublicUrl("https://169.254.169.254/latest", lookup)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(assertPublicUrl("https://evil.example/json/2", lookup)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    await expect(assertPublicUrl("https://shop.example.com/json/2", lookup)).resolves.toBeUndefined();
  });
});

/* ======================================================= push: API software */

describe("invoice push (Odoo)", () => {
  it("queues the invoice once when the order is delivered (complete on delivery OTP), even with invoicing off", async () => {
    const { owner, shop, sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    const integration = await connectOdoo(shop.id, owner.id);
    const order = await deliveredOrder(sp.id, "push-once");
    const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.orderId, order.id));
    expect(invoice).toBeTruthy(); // forced: the connection needs a numbered invoice
    const jobs = await db.select().from(integrationJobs).where(eq(integrationJobs.integrationId, integration.id));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "PUSH_INVOICE", subjectId: invoice.id, status: "PENDING" });
    // Queuing the same invoice again (a retried delivery, the safety net) is a no-op.
    await enqueueInvoicePush(invoice);
    await integrationSweep();
    expect(await db.select().from(integrationJobs).where(eq(integrationJobs.integrationId, integration.id))).toHaveLength(1);
  });

  it("retries a network failure with backoff, then sends; a lost reply never makes a second invoice", async () => {
    const { owner, shop, sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    const integration = await connectOdoo(shop.id, owner.id);
    await db.insert(integrationItemLinks).values({
      integrationId: integration.id,
      shopId: shop.id,
      externalId: "1",
      externalName: "Milk",
      productId: sp.productId,
      shopProductId: sp.id,
      matchStatus: "MATCHED",
      matchMethod: "MANUAL",
    });
    await deliveredOrder(sp.id, "push-retry");
    const odoo = fakeOdoo();

    // 1. Odoo unreachable → FAILED, retried after the first backoff step.
    odoo.failNext = 1;
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ ran: 1, failed: 1 });
    let [job] = await db.select().from(integrationJobs).where(eq(integrationJobs.integrationId, integration.id));
    expect(job).toMatchObject({ status: "FAILED", attempts: 1, errorCode: "UNREACHABLE" });
    expect(job.errorMessage).toContain("could not be reached");
    const wait = (job.nextAttemptAt.getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(BACKOFF_SECONDS[0] - 5);
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ ran: 0 }); // not due yet

    // 2. Due again; Odoo saves the invoice but the reply is lost → still FAILED.
    await db.update(integrationJobs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(integrationJobs.id, job.id));
    odoo.loseNextCreateReply = true;
    await dispatchDueJobs({ fetch: odoo.fetch });
    expect(odoo.moves).toHaveLength(1);

    // 3. The retry finds it by GoKesari's number and creates nothing new.
    await db.update(integrationJobs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(integrationJobs.id, job.id));
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ succeeded: 1 });
    [job] = await db.select().from(integrationJobs).where(eq(integrationJobs.id, job.id));
    expect(job).toMatchObject({ status: "SUCCEEDED", externalRef: "100", attempts: 3 });
    expect(odoo.moves).toHaveLength(1);
    expect(odoo.moves[0].move_type).toBe("out_invoice");
    // The stock reduction ran once.
    expect(odoo.calls.filter((c) => c === "stock.quant.action_apply_inventory")).toHaveLength(1);
  });

  it("stops at once and tells the owner when the key is refused; Retry sends it again after the fix", async () => {
    const { owner, shop, sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    const integration = await connectOdoo(shop.id, owner.id);
    await deliveredOrder(sp.id, "push-auth");
    const odoo = fakeOdoo();
    odoo.authFails = true;
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ dead: 1 });
    const [job] = await db.select().from(integrationJobs).where(eq(integrationJobs.integrationId, integration.id));
    expect(job).toMatchObject({ status: "DEAD", errorCode: "AUTH_FAILED" });
    const [row] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.id, integration.id));
    expect(row).toMatchObject({ status: "ERROR", lastErrorCode: "AUTH_FAILED" });
    const events = await db.select().from(domainEvents).where(eq(domainEvents.type, "integration.job_dead"));
    expect(events).toHaveLength(1);

    odoo.authFails = false;
    await retryJob(shop.id, job.id, { id: owner.id, role: "SHOP_OWNER" });
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ succeeded: 1 });
    const [after] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.id, integration.id));
    expect(after.status).toBe("ACTIVE");
    await expect(retryJob(shop.id, job.id, { id: owner.id, role: "SHOP_OWNER" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("gives up after the last attempt (DEAD) and the owner is told once", async () => {
    const { owner, shop, sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    const integration = await connectOdoo(shop.id, owner.id);
    await deliveredOrder(sp.id, "push-dead");
    await db.update(integrationJobs).set({ maxAttempts: 2 }).where(eq(integrationJobs.integrationId, integration.id));
    const odoo = fakeOdoo();
    odoo.failNext = 10;
    await dispatchDueJobs({ fetch: odoo.fetch });
    await db.update(integrationJobs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(integrationJobs.integrationId, integration.id));
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ dead: 1 });
    const [job] = await db.select().from(integrationJobs).where(eq(integrationJobs.integrationId, integration.id));
    expect(job).toMatchObject({ status: "DEAD", attempts: 2 });
    expect(await dispatchDueJobs({ fetch: odoo.fetch })).toMatchObject({ ran: 0 });
    expect(await db.select().from(domainEvents).where(eq(domainEvents.type, "integration.job_dead"))).toHaveLength(1);
  });
});

/* ============================================================ the connector */

describe("Tally connector", () => {
  async function tallyShop(name: string) {
    const setup = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    await db.update(shops).set({ name }).where(eq(shops.id, setup.shop.id));
    await saveIntegration(setup.shop.id, { provider: "TALLY", config: { company: name, unmappedItems: "ACCOUNTING_ONLY" } }, ownerActor(setup.owner.id));
    signIn({ id: setup.owner.id, email: setup.owner.email, role: "SHOP_OWNER" });
    const token = await call(tokenCreate as never, `/api/shops/${setup.shop.id}/integration/tokens`, { method: "POST", params: { id: setup.shop.id }, body: { label: "Counter" } });
    expect(token.status).toBe(201);
    state.session = null;
    const [integration] = await db.select().from(shopIntegrations).where(eq(shopIntegrations.shopId, setup.shop.id));
    return { ...setup, integration, token: token.body.token as string };
  }

  const req = (path: string, token: string, body?: unknown) =>
    new NextRequest(`http://localhost${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-connector-version": "1.0.0" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("runs lookup → create through the connector; a retry after a lost reply finds the voucher instead of duplicating it", async () => {
    const a = await tallyShop("Dairy A");
    const hello = await connectorHello(req("/api/connector/v1/hello", a.token, { version: "1.0.0", tallyRunning: true, companies: ["Dairy A"] }));
    expect(hello.status).toBe(200);
    const helloBody = await hello.json();
    expect(helloBody.company).toBe("Dairy A");
    expect(helloBody.itemsRequest).toContain("Dairy A");

    await deliveredOrder(a.sp.id, "tally-1");
    const polled = await (await connectorJobs(req("/api/connector/v1/jobs?wait=0", a.token))).json();
    expect(polled.jobs).toHaveLength(1);
    const work = polled.jobs[0];
    expect(work).toMatchObject({ kind: "PUSH_INVOICE", stepId: "LOOKUP" });
    const [invoice] = await db.select().from(taxInvoices).where(eq(taxInvoices.shopId, a.shop.id));
    expect(work.body).toContain(invoice.invoiceNumber);

    // Not in Tally yet → the next step is the voucher import.
    const step2 = await (await connectorResult(req(`/api/connector/v1/jobs/${work.jobId}/result`, a.token, { ok: true, stepId: "LOOKUP", response: "<ENVELOPE><BODY><DATA><COLLECTION></COLLECTION></DATA></BODY></ENVELOPE>" }), { params: Promise.resolve({ jobId: work.jobId }) })).json();
    expect(step2.done).toBe(false);
    expect(step2.next.stepId).toBe("CREATE");
    expect(step2.next.body).toContain("<VOUCHERNUMBER>");

    // Tally answered, but the reply was lost: the connector reports a failure.
    await connectorResult(req(`/api/connector/v1/jobs/${work.jobId}/result`, a.token, { ok: false, stepId: "CREATE", errorCode: "UNREACHABLE", detail: "socket hang up" }), { params: Promise.resolve({ jobId: work.jobId }) });
    let [job] = await db.select().from(integrationJobs).where(eq(integrationJobs.id, work.jobId));
    expect(job.status).toBe("FAILED");

    // Retry: the lookup now finds the voucher → done, nothing created twice.
    await db.update(integrationJobs).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(integrationJobs.id, job.id));
    const again = await (await connectorJobs(req("/api/connector/v1/jobs?wait=0", a.token))).json();
    expect(again.jobs[0].stepId).toBe("LOOKUP");
    const found = `<ENVELOPE><BODY><DATA><COLLECTION><VOUCHER><VOUCHERNUMBER>${invoice.invoiceNumber}</VOUCHERNUMBER><MASTERID>555</MASTERID></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
    const done = await (await connectorResult(req(`/api/connector/v1/jobs/${work.jobId}/result`, a.token, { ok: true, stepId: "LOOKUP", response: found }), { params: Promise.resolve({ jobId: work.jobId }) })).json();
    expect(done.done).toBe(true);
    [job] = await db.select().from(integrationJobs).where(eq(integrationJobs.id, work.jobId));
    expect(job).toMatchObject({ status: "SUCCEEDED", externalRef: "555" });
  });

  it("keeps shops apart: a connector sees and answers only its own shop's jobs; revoked or disconnected tokens are refused", async () => {
    const a = await tallyShop("Dairy A");
    const b = await tallyShop("Dairy B");
    await deliveredOrder(b.sp.id, "tally-b");
    const polledA = await (await connectorJobs(req("/api/connector/v1/jobs?wait=0", a.token))).json();
    expect(polledA.jobs).toHaveLength(0);
    const polledB = await (await connectorJobs(req("/api/connector/v1/jobs?wait=0", b.token))).json();
    expect(polledB.jobs).toHaveLength(1);
    const jobB = polledB.jobs[0].jobId;
    const forged = await connectorResult(req(`/api/connector/v1/jobs/${jobB}/result`, a.token, { ok: true, stepId: "LOOKUP", response: "<x/>" }), { params: Promise.resolve({ jobId: jobB }) });
    expect(forged.status).toBe(404);

    expect((await connectorJobs(req("/api/connector/v1/jobs?wait=0", "gkc_not-a-real-token-at-all-000000"))).status).toBe(401);
    await disconnectIntegration(a.shop.id, ownerActor(a.owner.id));
    expect((await connectorJobs(req("/api/connector/v1/jobs?wait=0", a.token))).status).toBe(401);
  });

  it("builds a Tally voucher whose ledgers balance (sales, taxes and party)", () => {
    const doc = {
      id: "x",
      number: "GK2627-000001",
      date: "2026-10-08",
      seller: { name: "S", gstin: "27ABCDE1234F1Z5", stateCode: "27" },
      buyer: { name: "B", gstin: null, stateCode: "27" },
      placeOfSupply: "27",
      supplyType: "INTRA" as const,
      kind: "TAX_INVOICE" as const,
      reverseCharge: false,
      lines: [{ lineNo: 1, name: "Milk", externalItemId: "Milk 1L", hsn: "0401", quantity: 2, unit: "Nos", uqc: "NOS", ratePaise: 5000, taxablePaise: 10_000, gstRateBp: 500, cgstPaise: 250, sgstPaise: 250, igstPaise: 0, cessPaise: 0, totalPaise: 10_500 }],
      totals: { taxablePaise: 10_000, cgstPaise: 250, sgstPaise: 250, igstPaise: 0, cessPaise: 0, roundOffPaise: 0, totalPaise: 10_500 },
      orderNumber: "O-1",
    };
    const config = { company: "C", salesVoucherType: "Sales", creditNoteVoucherType: "Credit Note", partyLedger: "Online", salesLedger: "Sales", cgstLedger: "CGST", sgstLedger: "SGST", igstLedger: "IGST", roundOffLedger: "Round Off", unmappedItems: "FAIL" as const };
    const xml = voucherImportXml(config, doc, "SALES", (l) => l.unit, true);
    // Ledger lines plus the sales allocation under each stock line (Tally's double entry).
    const ledgerAmounts = [...xml.matchAll(/<(?:LEDGERENTRIES|ACCOUNTINGALLOCATIONS)\.LIST>[\s\S]*?<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    expect(ledgerAmounts).toHaveLength(4); // party, CGST, SGST, sales allocation
    expect(ledgerAmounts.reduce((s, a) => s + a, 0)).toBeCloseTo(0, 2);
    expect(xml).toContain("<VOUCHERNUMBER>GK2627-000001</VOUCHERNUMBER>");
    expect(xml).toContain("Milk 1L");
  });
});

/* ================================================================== pull */

describe("pull: the shop's software decides stock and price", () => {
  async function connected() {
    const setup = await shopWithMilk();
    const integration = await connectOdoo(setup.shop.id, setup.owner.id);
    return { ...setup, integration: integration as ShopIntegration };
  }

  it("matches by barcode, takes price, HSN and rate, and keeps units sold online out of online stock", async () => {
    const { shop, sp, integration } = await connected();
    // 3 units are in an open online order: checkout already took them off online stock.
    const { user } = await createUserWithWallet({ balancePaise: 500_000 });
    await addToCart(user.id, sp.id, 3);
    await checkout({ userId: user.id, addressId: await deliveryAddressId(user.id), requestId: "open-order" });

    const summary = await applyPulledItems(integration, [
      { externalId: "1", name: "Toned milk 1 litre", barcode: "8901262010017", stock: 20, pricePaise: 11_000, hsn: "04012000", gstRateBp: 0 },
    ]);
    expect(summary).toMatchObject({ seen: 1, matched: 1, applied: 1 });
    const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, sp.id));
    expect(listing.onlineStock).toBe(17); // 20 in the software − 3 sold online, not yet in the software
    expect(listing).toMatchObject({ onlinePricePaise: 11_000, offlinePricePaise: 11_000, hsnCode: "04012000", gstRateBp: 0 });
    const [link] = await db.select().from(integrationItemLinks).where(eq(integrationItemLinks.integrationId, integration.id));
    expect(link).toMatchObject({ matchStatus: "MATCHED", matchMethod: "BARCODE", shopProductId: sp.id, lastIssue: null });

    // The same list again changes nothing.
    expect(await applyPulledItems(integration, [{ externalId: "1", name: "Toned milk 1 litre", barcode: "8901262010017", stock: 20, pricePaise: 11_000, hsn: "04012000", gstRateBp: 0 }])).toMatchObject({ unchanged: 1, applied: 0 });
    expect(shop.id).toBeTruthy();
  });

  it("never applies a price above the verified MRP: stock is still taken, the price is reported", async () => {
    const { sp, milk, integration } = await connected();
    await db.update(products).set({ kind: "PACKAGED", mrpPaise: 10_800, mrpVerificationStatus: "VERIFIED" }).where(eq(products.id, milk.id));
    const summary = await applyPulledItems(integration, [{ externalId: "1", name: "Milk", barcode: "8901262010017", stock: 30, pricePaise: 12_000, mrpPaise: 12_000 }]);
    expect(summary.issues).toBe(1);
    const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, sp.id));
    expect(listing.onlinePricePaise).toBe(10_500); // unchanged
    expect(listing.onlineStock).toBe(30);
    const [link] = await db.select().from(integrationItemLinks).where(eq(integrationItemLinks.integrationId, integration.id));
    expect(link.lastIssue).toMatch(/not applied/i);
    expect(link.lastIssue).toMatch(/MRP/);
  });

  it("only suggests a name match; the owner confirms, and a loose item gets its first price and goes on sale", async () => {
    const { shop, owner, cat, integration } = await connected();
    const paneer = await createProduct(cat.id, { name: "Fresh Paneer Loose", unit: "kg" });
    const loose = await createShopProduct(shop.id, paneer.id, { onlinePricePaise: null, onlineSaleEnabled: false, onlineStock: 0 });
    const summary = await applyPulledItems(integration, [{ externalId: "P-9", name: "Paneer fresh loose", stock: 12, pricePaise: 42_000 }]);
    expect(summary.suggested + summary.unmatched).toBe(1);
    const [link] = await db.select().from(integrationItemLinks).where(eq(integrationItemLinks.externalId, "P-9"));
    expect(link.matchStatus).toBe("SUGGESTED");
    expect(link.suggestions[0].productId).toBe(paneer.id);
    let [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, loose.id));
    expect(listing.onlinePricePaise).toBeNull(); // nothing applied before the owner confirms

    const result = await updateItemLink(shop.id, link.id, { action: "match", productId: paneer.id }, ownerActor(owner.id));
    expect(result).toMatchObject({ status: "MATCHED", applied: "applied" });
    [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, loose.id));
    expect(listing).toMatchObject({ onlinePricePaise: 42_000, onlineSaleEnabled: true, onlineStock: 12 });

    // Ignored items stay ignored on the next pull.
    await updateItemLink(shop.id, link.id, { action: "ignore" }, ownerActor(owner.id));
    expect(await applyPulledItems(integration, [{ externalId: "P-9", name: "Paneer fresh loose", stock: 1, pricePaise: 1 }])).toMatchObject({ ignored: 1 });
  });
});

/* ============================================================ file adapters */

describe("file sync (myBillBook / Vyapar / other)", () => {
  it("reads an export with the preset columns, applies it, and downloads new invoices exactly once", async () => {
    const { owner, shop, sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    await saveIntegration(shop.id, { provider: "MYBILLBOOK", config: {} }, ownerActor(owner.id));
    const actor = ownerActor(owner.id);
    const csv = Buffer.from("Item Name,Item Code,Barcode,Current Stock,Sales Price,MRP,HSN Code,GST %\nToned Milk,TM1,8901262010017,25,108.00,110,0401,5\nUnknown thing,X1,,4,10,,,\n");
    const upload = await createItemImport(shop.id, { name: "items.csv", bytes: csv }, actor);
    expect(upload).toMatchObject({ rowCount: 2, status: "UPLOADED" });
    expect(upload.mapping).toMatchObject({ name: "Item Name", sku: "Item Code", barcode: "Barcode", stock: "Current Stock", price: "Sales Price", mrp: "MRP", hsn: "HSN Code", gstRate: "GST %" });
    // The owner confirms a partial mapping through the route (only some fields are in most files).
    signIn({ id: owner.id, email: owner.email, role: "SHOP_OWNER" });
    const partial = await call(mappingPut as never, `/api/shops/${shop.id}/integration/imports/${upload.id}/mapping`, {
      method: "PUT",
      params: { id: shop.id, importId: upload.id },
      body: { mapping: { name: "Item Name", stock: "Current Stock" } },
    });
    expect(partial.status).toBe(200);
    const unknownColumn = await call(mappingPut as never, `/api/shops/${shop.id}/integration/imports/${upload.id}/mapping`, {
      method: "PUT",
      params: { id: shop.id, importId: upload.id },
      body: { mapping: { name: "No such column" } },
    });
    expect(unknownColumn.status).toBe(422);
    await setImportMapping(shop.id, upload.id, upload.mapping as Record<string, string>, actor);
    await startItemImport(shop.id, upload.id, actor);
    await expect(startItemImport(shop.id, upload.id, actor)).rejects.toMatchObject({ code: "CONFLICT" });
    const summary = await runItemImport(upload.id);
    expect(summary).toMatchObject({ seen: 2, matched: 1, applied: 1 });
    const [listing] = await db.select().from(shopProducts).where(eq(shopProducts.id, sp.id));
    expect(listing).toMatchObject({ onlineStock: 25, onlinePricePaise: 10_800, gstRateBp: 500 });

    // Two delivered orders wait as "ready to export".
    await deliveredOrder(sp.id, "file-1");
    await deliveredOrder(sp.id, "file-2");
    const first = await exportDocuments(shop.id, { kind: "invoices", scope: "new", format: "csv" }, actor);
    expect(first.count).toBe(2);
    const text = first.body.toString("utf8");
    const invoices = await db.select().from(taxInvoices).where(eq(taxInvoices.shopId, shop.id));
    for (const inv of invoices) expect(text).toContain(inv.invoiceNumber);
    expect(text).toContain("TM1"); // the software's own item code on each line
    const second = await exportDocuments(shop.id, { kind: "invoices", scope: "new", format: "csv" }, actor);
    expect(second.count).toBe(0);
    const again = await exportDocuments(shop.id, { kind: "invoices", scope: "range", from: "2020-01-01", to: "2099-12-31", format: "xlsx" }, actor);
    expect(again.count).toBe(2);
  });
});

/* =============================================================== webhooks */

describe("change webhook", () => {
  it("needs the shop's secret, and queues one pull at a time", async () => {
    const { owner, shop } = await shopWithMilk();
    const integration = await connectOdoo(shop.id, owner.id);
    const { secret } = await issueWebhookSecret(shop.id, "https://test.gokesari.com", ownerActor(owner.id));
    const post = (key: string) =>
      webhookRoute(new NextRequest(`http://localhost/api/integrations/webhooks/odoo/${integration.id}?key=${key}`, { method: "POST", body: "{}" }), {
        params: Promise.resolve({ provider: "odoo", integrationId: integration.id }),
      });
    expect((await post("wrong-secret-value")).status).toBe(401);
    expect((await post(secret)).status).toBe(202);
    expect((await post(secret)).status).toBe(202);
    const pulls = await db.select().from(integrationJobs).where(and(eq(integrationJobs.integrationId, integration.id), eq(integrationJobs.kind, "PULL_ITEMS")));
    expect(pulls).toHaveLength(1);
  });
});

/* ======================================================== refunds (credit) */

describe("refund after delivery", () => {
  it("issues a credit note against the invoice and queues it for the shop's software", async () => {
    const { owner, shop, sp } = await shopWithMilk({ gstin: "27ABCDE1234F1Z5" });
    const integration = await connectOdoo(shop.id, owner.id);
    const order = await deliveredOrder(sp.id, "refund-1");
    const { refundDeliveredOrder } = await import("@/server/services/finance");
    const adjustment = await refundDeliveredOrder(
      { orderNumber: order.orderNumber, amountPaise: 5_000, reason: "Leaking pack", chargeTo: "SHOP", requestId: "r-1" },
      { id: admin.id, role: "ADMIN" },
    );
    const { creditNotes } = await import("@/server/db/schema");
    const [note] = await db.select().from(creditNotes).where(eq(creditNotes.orderId, order.id));
    expect(note).toMatchObject({ sourceRef: adjustment.id, totalPaise: 5_000, reason: "REFUND", restock: false });
    const pushes = await db.select().from(integrationJobs).where(and(eq(integrationJobs.integrationId, integration.id), eq(integrationJobs.kind, "PUSH_CREDIT_NOTE")));
    expect(pushes).toHaveLength(1);
    // The same refund request again: no second credit note.
    await refundDeliveredOrder({ orderNumber: order.orderNumber, amountPaise: 5_000, reason: "Leaking pack", chargeTo: "SHOP", requestId: "r-1" }, { id: admin.id, role: "ADMIN" });
    expect(await db.select().from(creditNotes).where(eq(creditNotes.orderId, order.id))).toHaveLength(1);
    const [o] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(o.refundedPaise).toBe(5_000);
  });
});
