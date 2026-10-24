/**
 * Helpers for the seller-side QA package (shop onboarding, KYC, fees and
 * suspension; catalogue, prices, MRP, stock and photos; the product master).
 *
 * - fresh accounts (local only): a new person who has not registered a shop,
 *   created in the local database exactly as a completed sign-up leaves it,
 *   and signed in by minting the Auth.js cookie with the local AUTH_SECRET
 *   (the same way lib/actors.ts signs the world's accounts in);
 * - test files made at run time (images of any size and type, PDFs with a
 *   text layer, spreadsheets and their bad variants) under test-results/;
 * - business rules changed for one check and always restored;
 * - shop and listing look-ups through the site's own APIs.
 *
 * Nothing here runs on production: every writer asserts the target is writable.
 */
import { request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { encode } from "next-auth/jwt";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

import { as } from "./actors";
import { db } from "./db";
import { call, expectStatus, RUN, type Answer } from "./http";
import { blocked, expect, need } from "./record";
import { assertWritable, BASE_URL, HOST, IS_LOCAL } from "./target";
import { world, type Role } from "./world";

/**
 * A stash key part that survives a worker restart: lib/http RUN is taken
 * when a worker loads, and Playwright starts a new worker after every failed
 * test, so a key built on RUN is lost by the checks that follow a failure.
 * The runner's pid is the same for all workers of one `playwright test` run
 * and differs for the next run.
 */
export const RUN_KEY = String(process.ppid);

/* -------------------------------------------------------------- accounts */

export interface Account {
  id: string;
  email: string;
  phone: string;
  label: string;
}

let accountSeq = 0;
const SECURE = BASE_URL.startsWith("https");
const COOKIE = SECURE ? "__Secure-authjs.session-token" : "authjs.session-token";

/** A 10-digit mobile number starting 9 that no other account of this run uses. */
export function uniqueMobile(): string {
  accountSeq += 1;
  return `9${String(Date.now()).slice(-6)}${String(accountSeq % 1000).padStart(3, "0")}`;
}

/**
 * A new signed-up person (local only): an ACTIVE account with a verified
 * email and mobile, profile completed and terms accepted — what the normal
 * sign-up leaves behind. `role` other than CUSTOMER is also granted.
 */
export async function freshAccount(label: string, role: "CUSTOMER" | "SHOP_OWNER" | "OPERATOR" | "ADMIN" = "CUSTOMER"): Promise<Account> {
  if (!IS_LOCAL) blocked("needs a fresh account created in the local database (local run only)");
  assertWritable("create an account");
  const phone = uniqueMobile();
  const email = `qa-sell-${label}-${RUN}-${accountSeq}@test.local`.toLowerCase().replace(/[^a-z0-9@.+-]/g, "-");
  const [row] = await db()<{ id: string }[]>`
    insert into users (email, name, role, phone, phone_e164, email_verified, phone_verified_at, profile_completed_at)
    values (${email}, ${`QA ${label}`}, ${role}, ${phone}, ${`+91${phone}`}, now(), now(), now())
    returning id`;
  await db()`insert into user_consents (user_id, consent_type, version, granted) values (${row.id}, 'TERMS_AND_PRIVACY', '2026-08-21', true)`;
  if (role !== "CUSTOMER") {
    await db()`insert into user_role_grants (user_id, role, source) values (${row.id}, ${role}, 'ADMIN') on conflict do nothing`;
  }
  return { id: row.id, email, phone, label };
}

async function storageOf(account: { id: string; email: string }) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) blocked("AUTH_SECRET (the local server's) is not set");
  const value = await encode({ token: { sub: account.id, email: account.email, name: account.email }, secret, salt: COOKIE });
  const url = new URL(BASE_URL);
  return {
    cookies: [{ name: COOKIE, value, domain: url.hostname, path: "/", expires: -1, httpOnly: true, secure: SECURE, sameSite: "Lax" as const }],
    origins: [],
  };
}

const contexts = new Map<string, APIRequestContext>();

/** The API context signed in as a fresh account. */
export async function ctxFor(account: { id: string; email: string }): Promise<APIRequestContext> {
  const existing = contexts.get(account.id);
  if (existing) return existing;
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: await storageOf(account), timeout: 120_000 });
  contexts.set(account.id, ctx);
  return ctx;
}

/** A browser page signed in as a fresh account (close the context when done). */
export async function pageFor(browser: Browser, account: { id: string; email: string }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, storageState: await storageOf(account) });
  return { context, page: await context.newPage() };
}

/** The world's PENDING_APPROVAL shop owner (local world only; not a Role of lib/world.ts). */
export const PENDING_ROLE = "pending" as unknown as Role;

let panStorage: boolean | null = null;

/**
 * PANs, KYC files and bank details are stored encrypted with the server's
 * PAN_ENCRYPTION_KEY; a server started without one answers 500 to anything
 * that stores them. That is a set-up gap of the server under test, not a
 * defect of the case, so such cases are blocked with the reason.
 */
export async function needPanStorage(ctx?: APIRequestContext) {
  if (panStorage === null) {
    const res = await call(ctx ?? (await as("customer")), "POST", "/api/shops/duplicate-check", { panNumber: "ABCPE1234F" });
    panStorage = res.status !== 500;
  }
  if (!panStorage) blocked("the server under test has no PAN_ENCRYPTION_KEY, so it cannot store a PAN or a KYC file (500 on any such write)");
}

/* ------------------------------------------------------------ identifiers */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
let idSeq = 0;

function lettersFrom(n: number, length: number): string {
  let out = "";
  let v = Math.abs(Math.floor(n));
  for (let i = 0; i < length; i++) {
    out = LETTERS[v % 26] + out;
    v = Math.floor(v / 26);
  }
  return out;
}

function runNumber(): number {
  return parseInt(RUN, 36) % 1e9;
}

/** A PAN of the pattern AAAAA9999A that no other registration of this run uses (4th letter P: an individual). */
export function uniquePan(): string {
  idSeq += 1;
  const n = runNumber() * 37 + idSeq;
  const head = lettersFrom(n, 3);
  return `${head}P${lettersFrom(n * 7, 1)}${String((n * 13) % 10000).padStart(4, "0")}${lettersFrom(n * 3, 1)}`;
}

/** A Shop Act licence number unique to this run. */
export function uniqueShopAct(): string {
  idSeq += 1;
  return `MH-PUNE-${RUN.toUpperCase()}-${String(idSeq).padStart(4, "0")}`;
}

/** A Udyam number UDYAM-MH-26-0000000 unique to this run. */
export function uniqueUdyam(): string {
  idSeq += 1;
  return `UDYAM-MH-26-${String((runNumber() + idSeq * 7919) % 10_000_000).padStart(7, "0")}`;
}

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The GSTIN check character for its first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

/** A checksum-valid GSTIN for a PAN (state 27, Maharashtra). */
export function gstinFor(pan: string, state = "27"): string {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
}

/* --------------------------------------------------------------- files */

export const FILE_DIR = join("test-results", "qa", HOST.replace(/[^a-z0-9.-]/gi, "_"), "seller-files");

/** Writes a generated test file to test-results (kept for evidence) and returns its bytes. */
export function keep(name: string, data: Buffer): Buffer {
  mkdirSync(FILE_DIR, { recursive: true });
  writeFileSync(join(FILE_DIR, name), data);
  return data;
}

/** A solid-colour image of the given size and type. */
export async function image(width: number, height: number, type: "jpeg" | "png" | "webp" = "jpeg", colour = { r: 230, g: 120, b: 40 }): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: colour } });
  const out = type === "png" ? base.png() : type === "webp" ? base.webp() : base.jpeg({ quality: 85 });
  return keep(`img-${width}x${height}-${colour.r}.${type === "jpeg" ? "jpg" : type}`, await out.toBuffer());
}

/** A random-noise PNG — incompressible, so roughly width × height × 3 bytes (a file over a size limit). */
export async function noisePng(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24 ^ (i & 0xff);
  for (let i = 0; i < raw.length; i += 4096) raw[i] = Math.floor(Math.random() * 256);
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  return keep(`noise-${width}x${height}.png`, png);
}

/** A one-page PDF whose text layer holds `lines` (what a GST certificate or PAN e-copy carries). */
export function pdf(lines: string[], name = "doc.pdf"): Buffer {
  const escape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const text = lines.map((l, i) => `${i === 0 ? "" : "T* "}(${escape(l)}) Tj`).join(" ");
  const stream = `BT /F1 12 Tf 50 800 Td 16 TL ${text} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return keep(name, Buffer.from(body, "latin1"));
}

/** Files that only pretend to be what their name says. */
export const DISGUISED = {
  /** A Windows executable header. */
  exe: () => keep("program.exe", Buffer.concat([Buffer.from("MZ\x90\x00\x03\x00\x00\x00", "latin1"), Buffer.alloc(2048, 0x41)])),
  /** HTML with a script, to be uploaded as .pdf / .jpg. */
  html: () => keep("page.html", Buffer.from("<!doctype html><html><body><script>alert(1)</script>not a document</body></html>")),
  /** SVG with a script, to be uploaded as .jpg. */
  svg: () => keep("vector.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><script>alert(1)</script><rect width="400" height="400"/></svg>')),
  /** A real PDF, to be uploaded as .jpg. */
  pdfAsJpg: () => pdf(["Not a photo"], "pdf-as-jpg.pdf"),
};

/** An .xlsx workbook with one sheet of rows (first row = header). */
export async function xlsx(rows: (string | number | null)[][], name = "sheet.xlsx", sheetName = "Prices"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const row of rows) ws.addRow(row);
  return keep(name, Buffer.from(await wb.xlsx.writeBuffer()));
}

/** Reads the first sheet of an .xlsx into rows of cell texts. */
export async function readXlsx(data: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1).map((v) => (v == null ? "" : typeof v === "object" && v && "text" in v ? String((v as { text: unknown }).text) : String(v)));
    rows.push(values);
  });
  return rows;
}

/** A raw download (binary body). */
export async function download(ctx: APIRequestContext, path: string): Promise<{ status: number; type: string; body: Buffer }> {
  const res = await ctx.get(new URL(path, BASE_URL).toString(), { failOnStatusCode: false, maxRedirects: 0 });
  return { status: res.status(), type: res.headers()["content-type"] ?? "", body: await res.body() };
}

/** multipart file part for lib/http call(). */
export function filePart(name: string, data: Buffer, mimeType: string) {
  return { name, mimeType, buffer: data };
}

/* -------------------------------------------------------------- rules */

interface RuleRow {
  key: string;
  value: Record<string, unknown>;
  overridden: boolean;
}

export async function getRule(key: string): Promise<RuleRow> {
  const res = await call(await as("admin"), "GET", "/api/admin/settings");
  expectStatus(res, 200, "GET /api/admin/settings");
  const row = (res.body.rules as RuleRow[]).find((r) => r.key === key);
  return need(row, `business rule "${key}"`);
}

/**
 * Runs `body` with business rule `key` changed by `patch` (admin, through
 * /admin/settings' API), then restores exactly what was there.
 */
export async function withRule<T>(key: string, patch: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  if (!IS_LOCAL) blocked(`changes the business rule "${key}" (local run only)`);
  const before = await getRule(key);
  const admin = await as("admin");
  const put = await call(admin, "PUT", "/api/admin/settings", { key, value: { ...before.value, ...patch } });
  expectStatus(put, 200, `set rule ${key}`);
  try {
    return await body();
  } finally {
    const restore = before.overridden
      ? await call(admin, "PUT", "/api/admin/settings", { key, value: before.value })
      : await call(admin, "DELETE", `/api/admin/settings?key=${encodeURIComponent(key)}`);
    expectStatus(restore, 200, `restore rule ${key}`);
  }
}

/* ------------------------------------------------------------- shops */

/** The world shop each owner role runs. */
export const SHOP_OF: Partial<Record<string, "A" | "B" | "C" | "pending">> = { shop: "A", shopB: "B", shopC: "C", pending: "pending" };

export interface OwnerListing {
  id: string;
  shopId: string;
  productId: string;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  onlineSaleEnabled: boolean;
  offlineSaleEnabled: boolean;
  onlineStock: number;
  offlineStock: number;
  isActive: boolean;
  isAvailable: boolean;
  deletedAt: string | null;
  product: { id: string; code: string; name: string; kind: string; mrpPaise: number | null; mrpVerificationStatus: string; categoryId: string; unit: string };
}

/** The owner's own view of every listing of a shop. */
export async function ownerListings(ctx: APIRequestContext, shopId: string): Promise<OwnerListing[]> {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/products`);
  expectStatus(res, 200, "the owner's listings");
  return (Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as OwnerListing[];
}

export async function ownerListing(ctx: APIRequestContext, shopId: string, shopProductId: string): Promise<OwnerListing> {
  const row = (await ownerListings(ctx, shopId)).find((l) => l.id === shopProductId);
  return need(row, `listing ${shopProductId} in the owner's view`);
}

export interface InventoryRow {
  shopProductId: string;
  productId: string;
  productCode: string;
  productName: string;
  unit: string;
  onlinePricePaise: number | null;
  offlinePricePaise: number | null;
  available: number;
  reserved: number;
  onHand: number;
  offlineStock: number;
  status: string;
  thresholds: { lowStock: number; reorderLevel: number | null; reorderQuantity: number | null; source: Record<string, string>; alertsDisabled: boolean };
  openAlerts: { id: string; alertType: string }[];
}

export async function inventory(ctx: APIRequestContext, shopId: string): Promise<{ rows: InventoryRow[]; alerts: { id: string; shopProductId: string; alertType: string }[]; dashboard: Record<string, number> }> {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/inventory`);
  expectStatus(res, 200, "GET inventory");
  return res.body;
}

/** The public storefront rows of a shop (what a customer's API sees). */
export async function storefront(ctx: APIRequestContext, shopId: string) {
  const res = await call(ctx, "GET", `/api/shops/${shopId}/products?limit=100`);
  return { status: res.status, rows: (Array.isArray(res.body) ? res.body : (res.body?.products ?? [])) as { shopProductId: string; productId: string; productName: string; onlinePricePaise: number | null; onlineStock: number; isAvailable: boolean; onlineSaleEnabled: boolean }[] };
}

/** Shop-category (business kind) id by name, e.g. "Stationery Store". */
export async function shopCategoryId(name: string): Promise<string> {
  const res = await call(await as("customer"), "GET", "/api/shop-categories");
  expectStatus(res, 200, "GET /api/shop-categories");
  const list = (res.body?.categories ?? []) as { id: string; name: string }[];
  return need(list.find((c) => c.name.toLowerCase() === name.toLowerCase()), `shop category "${name}"`).id;
}

/** A valid self-service registration body (a stationery shop: no FSSAI needed) with unique identifiers. */
export async function registrationBody(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    name: `QA Sellers Shop ${RUN} ${++idSeq}`,
    ownerName: "QA Seller Owner",
    phone: uniqueMobile(),
    email: null,
    addressLine1: `${idSeq} QA Lane, Paud Road`,
    area: "Kothrud",
    city: "Pune",
    state: "Maharashtra",
    pincode: "411038",
    latitude: "18.5074",
    longitude: "73.8077",
    shopType: "STATIONERY_STORE",
    categoryIds: [await shopCategoryId("Stationery Store")],
    shopActNumber: uniqueShopAct(),
    deliveryAvailable: true,
    deliveryFeePaise: 2000,
    openingHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: "06:00", close: "22:00" })),
    ...overrides,
  };
}

export interface ShopView {
  id: string;
  name: string;
  status: string;
  registrationNumber?: string | null;
  ownerId: string;
  [key: string]: unknown;
}

/** Registers a shop as `ctx` (POST /api/shops); expects success. */
export async function registerShop(ctx: APIRequestContext, overrides: Record<string, unknown> = {}): Promise<{ shop: ShopView; body: Record<string, unknown>; res: Answer }> {
  assertWritable("register a shop");
  const body = await registrationBody(overrides);
  const res = await call(ctx, "POST", "/api/shops", body);
  expectStatus(res, [200, 201], "register a shop");
  return { shop: res.body as ShopView, body, res };
}

/**
 * Arranges what operations would have done before approval (local only):
 * every mandatory seller document VERIFIED. The approval itself is left to
 * the API under test.
 */
export async function markDocumentsVerified(shopId: string, docTypes = ["PAN", "GSTIN", "SHOP_ACT", "FSSAI"]) {
  for (const docType of docTypes) {
    await db()`
      insert into seller_verifications (shop_id, doc_type, status, verified_at)
      values (${shopId}, ${docType}, 'VERIFIED', now())
      on conflict (shop_id, doc_type) do update set status = 'VERIFIED', verified_at = now(), updated_at = now()`;
  }
}

/** A registered and approved shop of a fresh owner (local only). */
export async function approvedShopOfNewOwner(label: string, overrides: Record<string, unknown> = {}) {
  const owner = await freshAccount(label);
  const ctx = await ctxFor(owner);
  const { shop } = await registerShop(ctx, overrides);
  await markDocumentsVerified(shop.id);
  await db()`update shops set fee_payment_status = 'PAID', registration_fee_paise = 0 where id = ${shop.id} and fee_payment_status <> 'PAID'`;
  const approved = await call(await as("ops"), "POST", `/api/shops/${shop.id}/approve`, { classification: "GREEN" });
  expectStatus(approved, 200, "approve the new shop");
  return { owner, ctx, shop: approved.body as ShopView };
}

/**
 * An approved shop of a fresh owner that sells the world's QA catalogue
 * (local only): its location confirmed beside shop A (as the seed confirms
 * shop A's), and the world's QA category added by the owner, which lists
 * every product of it at stock 100 priced at the MRP.
 */
export async function sellingShop(label: string) {
  const made = await approvedShopOfNewOwner(label);
  const loc = need(world().location, "shop A's location in the world");
  await db()`
    update shops set latitude = ${String(loc.lat)}, longitude = ${String(loc.lng)}, location_verified = true,
      location_verified_at = now(), location_source = 'qa_seed', service_radius_km = 5, delivery_available = true
    where id = ${made.shop.id}`;
  const category = need((world() as unknown as { category?: { id: string } }).category, "the world's QA category");
  const added = await call(made.ctx, "POST", `/api/shops/${made.shop.id}/product-categories`, { categoryId: category.id });
  expectStatus(added, [200, 201], "the owner adds the QA category");
  const listings = (await ownerListings(made.ctx, made.shop.id)).filter((l) => l.onlineSaleEnabled && (l.onlinePricePaise ?? 0) > 0);
  listings.sort((a, b) => (a.onlinePricePaise ?? 0) - (b.onlinePricePaise ?? 0));
  const cheapest = need(listings[0], "a priced listing in the new shop");
  return {
    ...made,
    listings,
    /** The cheapest listing, in the shape lib/flows.ts placeOrder() takes. */
    listing: {
      shopProductId: cheapest.id,
      productId: cheapest.productId,
      name: cheapest.product.name,
      pricePaise: cheapest.onlinePricePaise,
      shopId: made.shop.id,
      shopName: made.shop.name,
    },
  };
}

/** A fulfilment action by a fresh shop owner. */
export async function ownerFulfil(ctx: APIRequestContext, orderId: string, action: "accept" | "start" | "ready" | "reject", extra: Record<string, unknown> = {}) {
  assertWritable("act on an order");
  return call(ctx, "POST", `/api/orders/${orderId}/fulfilment`, { action, ...extra });
}

/** The pickup code off a fresh owner's packing slip. */
export async function ownerPickupCode(ctx: APIRequestContext, orderId: string): Promise<string | null> {
  const res = await call(ctx, "GET", `/shop/orders/${orderId}/packing-slip`, undefined, { maxRedirects: 3 });
  expectStatus(res, 200, "packing slip");
  return res.text.match(/Pickup code:\s*(?:<!-- -->)?\s*<span[^>]*>(\d{4,8})<\/span>/)?.[1] ?? null;
}

/** Status of an order as stored (local only). */
export async function orderStatus(orderId: string): Promise<string> {
  const [row] = await db()<{ status: string }[]>`select status from orders where id = ${orderId}`;
  return need(row, `order ${orderId}`).status;
}

let productSeq = 0;

/**
 * A master product arranged in the catalogue (local only), as catalogue
 * staff would have entered it: approved and active, in `categoryId` (the
 * world's QA category by default), with a verified MRP for a packaged one.
 */
export async function newMasterProduct(opts: { name?: string; kind?: "PACKAGED" | "LOOSE"; mrpPaise?: number | null; unit?: string; categoryId?: string; approval?: "APPROVED" | "PENDING_APPROVAL" | "REJECTED"; active?: boolean; createdBy?: string | null } = {}) {
  if (!IS_LOCAL) blocked("arranges a master product in the local database (local run only)");
  productSeq += 1;
  const categoryId = opts.categoryId ?? need((world() as unknown as { category?: { id: string } }).category, "the world's QA category").id;
  const name = opts.name ?? `QA Product ${RUN} ${productSeq}`;
  const kind = opts.kind ?? "PACKAGED";
  const mrp = kind === "LOOSE" ? null : (opts.mrpPaise === undefined ? 5000 : opts.mrpPaise);
  const [row] = await db()<{ id: string; code: string; name: string }[]>`
    insert into products (category_id, name, slug, unit, unit_size_milli, kind, mrp_paise, mrp_source, mrp_verification_status, mrp_updated_at, approval_status, is_active, created_by)
    values (${categoryId}, ${name}, ${`${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${productSeq}`}, ${opts.unit ?? (kind === "LOOSE" ? "kg" : "piece")}, 1000, ${kind},
      ${mrp}, ${mrp == null ? null : "ADMIN"}, ${mrp == null ? "UNVERIFIED" : "VERIFIED"}, ${mrp == null ? null : new Date()},
      ${opts.approval ?? "APPROVED"}, ${opts.active ?? true}, ${opts.createdBy ?? null})
    returning id, code, name`;
  return row;
}

/** Price history rows of a listing (local only). */
export async function priceHistory(shopProductId: string) {
  return db()<{ price_type: string; previous_price_paise: string | null; new_price_paise: string; changed_by: string | null }[]>`
    select price_type, previous_price_paise, new_price_paise, changed_by from product_price_history where shop_product_id = ${shopProductId} order by created_at`;
}

/** A listing as stored (local only). */
export async function listingRow(shopProductId: string) {
  const [row] = await db()<{ online_price_paise: string | null; offline_price_paise: string | null; online_sale_enabled: boolean; online_stock: number; offline_stock: number; deleted_at: Date | null }[]>`
    select online_price_paise, offline_price_paise, online_sale_enabled, online_stock, offline_stock, deleted_at from shop_products where id = ${shopProductId}`;
  return need(row, `listing ${shopProductId}`);
}

/** Status and lifecycle of a shop as stored (local only). */
export async function shopRow(shopId: string) {
  const [row] = await db()<{ status: string; lifecycle_status: string; registration_number: string | null; owner_id: string; rejection_reason: string | null; fee_payment_status: string; registration_fee_paise: number | null; amount_paid_paise: number; classification: string | null; name: string }[]>`
    select status, lifecycle_status, registration_number, owner_id, rejection_reason, fee_payment_status, registration_fee_paise, amount_paid_paise, classification, name
    from shops where id = ${shopId}`;
  return need(row, `shop ${shopId} in the database`);
}

/** The newest audit rows for an entity (local only). */
export async function auditRows(entityId: string, actionLike = "%") {
  return db()<{ action: string; actor_id: string | null; previous_value: unknown; new_value: unknown; created_at: Date }[]>`
    select action, actor_id, previous_value, new_value, created_at from audit_logs
    where entity_id = ${entityId} and action like ${actionLike} order by created_at desc limit 50`;
}

/** Notifications a user received after `since` (local only). */
export async function notificationsOf(userId: string, since: Date) {
  return db()<{ type: string; title: string; body: string }[]>`
    select type, title, body from notifications where user_id = ${userId} and created_at >= ${since} order by created_at desc`;
}

/** A shop-world key's id (blocks when the world has no such shop). */
export function worldShopId(key: "A" | "B" | "C" | "pending"): string {
  return need(world().shops[key]?.id, `shop ${key} in this site's test data`);
}

export { expect };
