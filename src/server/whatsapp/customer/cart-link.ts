/**
 * The checkout link of a WhatsApp chat cart (docs/customer-whatsapp-2026-11/README.md).
 *
 *   /wa/cart?t=<id>.<expiry>.<signature>
 *
 * The signature is an HMAC-SHA256 (AUTH_SECRET) over the link id and its
 * expiry, so a link cannot be guessed, edited or extended. The cart snapshot
 * itself is in whatsapp_cart_links; a link works once, until it expires (rule
 * whatsappCustomer.checkoutLinkTtlMinutes).
 *
 * Using it: /wa/cart shows the lines (no sign-in needed to look), and "Add to
 * my cart" — after sign-in — puts them into the customer's server cart with the
 * normal addToCart checks (live price, stock, online sale). A link made from a
 * known customer's number works only for that customer's account.
 *
 * Guest checkout later: loadCartLink() gives the lines without a user, so a
 * guest cart can be filled from the same link without changing this file.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";

import { AppError, forbidden, notFound } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { db } from "@/server/db";
import { whatsappCartLinks, type WhatsAppCartLine, type WhatsappCartLink } from "@/server/db/schema";
import { addToCart } from "@/server/services/cart";
import { siteUrl } from "@/server/whatsapp/shop-orders/render";

export const CART_LINK_PATH = "/wa/cart";

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`wa-cart:${payload}`).digest("base64url");
}

export function signCartToken(id: string, expiresAt: Date, secret: string = getEnv().AUTH_SECRET): string {
  const payload = `${id}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${payload}.${signature(payload, secret)}`;
}

export type TokenCheck = { ok: true; id: string; expiresAt: Date } | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

export function verifyCartToken(token: string | null | undefined, now: Date = new Date(), secret: string = getEnv().AUTH_SECRET): TokenCheck {
  const m = /^([0-9a-f-]{36})\.(\d{9,11})\.([A-Za-z0-9_-]{20,100})$/i.exec((token ?? "").trim());
  if (!m) return { ok: false, reason: "MALFORMED" };
  const expected = Buffer.from(signature(`${m[1]}.${m[2]}`, secret));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "BAD_SIGNATURE" };
  const expiresAt = new Date(Number(m[2]) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "EXPIRED" };
  return { ok: true, id: m[1].toLowerCase(), expiresAt };
}

export function cartLinkUrl(token: string): string {
  return siteUrl(`${CART_LINK_PATH}?t=${encodeURIComponent(token)}`);
}

export async function createCartLink(input: {
  sessionId: string | null;
  phone: string;
  userId: string | null;
  lines: WhatsAppCartLine[];
  ttlMinutes: number;
}): Promise<{ url: string; token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
  const [row] = await db
    .insert(whatsappCartLinks)
    .values({ sessionId: input.sessionId, phoneE164: input.phone, userId: input.userId, lines: input.lines, expiresAt })
    .returning({ id: whatsappCartLinks.id });
  const token = signCartToken(row.id, expiresAt);
  return { url: cartLinkUrl(token), token, expiresAt };
}

export type CartLinkProblem = "INVALID" | "EXPIRED" | "USED";

/** The link behind a token, or why it cannot be used. */
export async function loadCartLink(token: string | null | undefined): Promise<{ link: WhatsappCartLink | null; problem: CartLinkProblem | null }> {
  const check = verifyCartToken(token);
  if (!check.ok) return { link: null, problem: check.reason === "EXPIRED" ? "EXPIRED" : "INVALID" };
  const [link] = await db.select().from(whatsappCartLinks).where(eq(whatsappCartLinks.id, check.id));
  if (!link) return { link: null, problem: "INVALID" };
  if (link.usedAt) return { link, problem: "USED" };
  if (link.expiresAt.getTime() <= Date.now()) return { link, problem: "EXPIRED" };
  return { link, problem: null };
}

export interface ClaimResult {
  added: { name: string; quantity: number }[];
  skipped: { name: string; reason: string }[];
}

/** Puts the link's lines into the signed-in customer's cart. Single use; refused for another customer's link. */
export async function claimCartLink(token: string, user: { id: string }): Promise<ClaimResult> {
  const { link, problem } = await loadCartLink(token);
  if (!link || problem === "INVALID") throw notFound("Checkout link");
  if (problem === "EXPIRED") throw new AppError("CONFLICT", "This checkout link has expired. Send \"checkout\" on WhatsApp for a new one.");
  if (problem === "USED") throw new AppError("CONFLICT", "This checkout link was already used. Open your cart, or send \"checkout\" on WhatsApp for a new one.");
  if (link.userId && link.userId !== user.id) throw forbidden("This checkout link was made for another GoKesari account. Sign in with the mobile number you chatted from.");

  // Claimed first (one winner across double taps), then filled line by line with the normal cart checks.
  const [claimed] = await db
    .update(whatsappCartLinks)
    .set({ usedAt: new Date(), usedBy: user.id })
    .where(and(eq(whatsappCartLinks.id, link.id), isNull(whatsappCartLinks.usedAt), gt(whatsappCartLinks.expiresAt, new Date())))
    .returning({ id: whatsappCartLinks.id });
  if (!claimed) throw new AppError("CONFLICT", "This checkout link was already used.");

  const result: ClaimResult = { added: [], skipped: [] };
  for (const line of link.lines) {
    try {
      await addToCart(user.id, line.shopProductId, line.quantity);
      result.added.push({ name: line.name, quantity: line.quantity });
    } catch (error) {
      result.skipped.push({ name: line.name, reason: error instanceof AppError ? error.message : "Could not be added." });
      if (!(error instanceof AppError)) console.error("[whatsapp-customer] cart line failed", line.shopProductId, error);
    }
  }
  return result;
}
