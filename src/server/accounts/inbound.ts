/**
 * Bills forwarded by email (docs/inventory-accounting-2026-10, Part 4).
 *
 * Each shop has a private address, bills+<shop id>-<signature>@<INBOUND_EMAIL_DOMAIN>;
 * the signature (HMAC of the shop id with INBOUND_EMAIL_SECRET) means nobody
 * can guess another shop's address. The inbound-mail provider (Postmark,
 * SendGrid Inbound Parse, Mailgun routes, Cloudflare Email Workers…) posts each
 * message as JSON to /api/inbound/bill-email with the same secret as a bearer
 * token; its attachments become a bill capture, read and queued for review
 * exactly like an upload.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";

import { forbidden, validationFailed } from "@/lib/errors";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { createCapture } from "./capture/service";

function secret(): string | null {
  return process.env.INBOUND_EMAIL_SECRET?.trim() || null;
}

function signature(shopId: string, key: string): string {
  return createHmac("sha256", key).update(`bills:${shopId}`).digest("hex").slice(0, 10);
}

/** The shop's forwarding address, or null when inbound email is not set up. */
export function billEmailAddress(shopId: string): string | null {
  const key = secret();
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim();
  if (!key || !domain) return null;
  return `bills+${shopId.replace(/-/g, "")}-${signature(shopId, key)}@${domain}`;
}

export function shopIdFromAddress(address: string): string | null {
  const key = secret();
  if (!key) return null;
  const m = /bills\+([0-9a-f]{32})-([0-9a-f]{10})@/i.exec(address);
  if (!m) return null;
  const hex = m[1].toLowerCase();
  const shopId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expected = Buffer.from(signature(shopId, key));
  const given = Buffer.from(m[2].toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given) ? shopId : null;
}

export function assertInboundAuthorized(request: Request): void {
  const key = secret();
  const header = request.headers.get("authorization") ?? "";
  const provided = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(key ?? "");
  if (!key || provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw forbidden("Invalid inbound credentials.");
}

export interface InboundMessage {
  to: string[];
  from: string | null;
  subject: string | null;
  attachments: { filename: string | null; contentType: string | null; contentBase64: string }[];
}

export async function receiveBillEmail(message: InboundMessage) {
  const shopId = message.to.map(shopIdFromAddress).find(Boolean) ?? null;
  if (!shopId) throw validationFailed("No shop bill address among the recipients.");
  const [shop] = await db.select({ id: shops.id, ownerId: shops.ownerId }).from(shops).where(eq(shops.id, shopId));
  if (!shop) throw validationFailed("Unknown shop.");
  const files = message.attachments
    .filter((a) => /pdf|image|json|sheet|excel|csv/i.test(a.contentType ?? "") || /\.(pdf|jpe?g|png|webp|json|xlsx|xls|csv)$/i.test(a.filename ?? ""))
    .slice(0, 10)
    .map((a) => ({ bytes: Buffer.from(a.contentBase64, "base64"), contentType: a.contentType, name: a.filename }));
  if (files.length === 0) throw validationFailed("The email has no bill attached (PDF, photo, Excel or e-invoice JSON).");
  return createCapture(shop.id, { files, kind: "SOFT", source: "EMAIL" }, shop.ownerId);
}
