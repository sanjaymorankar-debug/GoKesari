/**
 * docs/guest-cart-2026-11 (owner, 23-Nov-2026): a shopper who is not signed in
 * fills a cart kept only in their browser (localStorage). Nothing is saved on
 * the server for a guest; prices come live from POST /api/cart/preview, and
 * "Place order" asks for sign-in, after which POST /api/cart/merge moves the
 * lines into the account cart (GuestCartMerge).
 *
 * The pure functions below (parse / add / set) carry the rules and are unit
 * tested; the read / write helpers only touch the browser.
 */
import { MAX_CART_LINE_QUANTITY, roundStock } from "@/lib/stock-quantity";

export const GUEST_CART_STORAGE_KEY = "gk_guest_cart_v1";
/** Fired on window whenever the guest cart changes (header badge, cart page). */
export const GUEST_CART_EVENT = "gk-guest-cart";
/** Owner default: up to 50 different items. */
export const GUEST_CART_MAX_LINES = 50;
/** Owner default: a guest cart left alone for 7 days is forgotten. */
export const GUEST_CART_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GuestCartLine {
  shopProductId: string;
  quantity: number;
}

export interface GuestCart {
  lines: GuestCartLine[];
  /** ms since epoch of the last change. */
  updatedAt: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function emptyGuestCart(now: number): GuestCart {
  return { lines: [], updatedAt: now };
}

function validQuantity(q: unknown): q is number {
  return typeof q === "number" && Number.isFinite(q) && q > 0;
}

/**
 * Reads a stored guest cart, dropping anything malformed, older than the TTL,
 * repeated (the first copy wins) or beyond the line limit. Never throws.
 */
export function parseGuestCart(raw: string | null | undefined, now: number): GuestCart {
  if (!raw) return emptyGuestCart(now);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyGuestCart(now);
  }
  if (!data || typeof data !== "object") return emptyGuestCart(now);
  const { lines, updatedAt } = data as { lines?: unknown; updatedAt?: unknown };
  if (typeof updatedAt !== "number" || !Array.isArray(lines)) return emptyGuestCart(now);
  if (now - updatedAt > GUEST_CART_TTL_MS) return emptyGuestCart(now);
  const seen = new Set<string>();
  const kept: GuestCartLine[] = [];
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const { shopProductId, quantity } = line as { shopProductId?: unknown; quantity?: unknown };
    if (typeof shopProductId !== "string" || !UUID.test(shopProductId) || seen.has(shopProductId)) continue;
    if (!validQuantity(quantity)) continue;
    seen.add(shopProductId);
    kept.push({ shopProductId, quantity: roundStock(Math.min(quantity, MAX_CART_LINE_QUANTITY)) });
    if (kept.length >= GUEST_CART_MAX_LINES) break;
  }
  return { lines: kept, updatedAt };
}

export type GuestCartChange = { ok: true; cart: GuestCart } | { ok: false; reason: "FULL" | "BAD_QUANTITY" };

/** Adds `quantity` to a line (capped at the per-line maximum), or a new line while there is room. */
export function addGuestCartLine(cart: GuestCart, shopProductId: string, quantity: number, now: number): GuestCartChange {
  if (!validQuantity(quantity) || !UUID.test(shopProductId)) return { ok: false, reason: "BAD_QUANTITY" };
  const existing = cart.lines.find((l) => l.shopProductId === shopProductId);
  if (!existing && cart.lines.length >= GUEST_CART_MAX_LINES) return { ok: false, reason: "FULL" };
  const lines = existing
    ? cart.lines.map((l) =>
        l.shopProductId === shopProductId ? { ...l, quantity: roundStock(Math.min(MAX_CART_LINE_QUANTITY, l.quantity + quantity)) } : l,
      )
    : [...cart.lines, { shopProductId, quantity: roundStock(Math.min(MAX_CART_LINE_QUANTITY, quantity)) }];
  return { ok: true, cart: { lines, updatedAt: now } };
}

/** Sets a line's quantity; 0 removes the line. Unknown lines are left alone. */
export function setGuestCartLine(cart: GuestCart, shopProductId: string, quantity: number, now: number): GuestCart {
  if (!(Number.isFinite(quantity) && quantity >= 0)) return cart;
  const lines =
    quantity === 0
      ? cart.lines.filter((l) => l.shopProductId !== shopProductId)
      : cart.lines.map((l) => (l.shopProductId === shopProductId ? { ...l, quantity: roundStock(Math.min(MAX_CART_LINE_QUANTITY, quantity)) } : l));
  return { lines, updatedAt: now };
}

/** Items for the header badge: a line counts its quantity, a part-unit (loose) line counts once. */
export function guestCartItemCount(cart: GuestCart): number {
  return cart.lines.reduce((n, l) => n + (Number.isInteger(l.quantity) ? l.quantity : 1), 0);
}

/* ------------------------------------------------------------- browser only */

export function readGuestCart(): GuestCart {
  const now = Date.now();
  try {
    return parseGuestCart(window.localStorage.getItem(GUEST_CART_STORAGE_KEY), now);
  } catch {
    return emptyGuestCart(now);
  }
}

export function writeGuestCart(cart: GuestCart): void {
  try {
    if (cart.lines.length === 0) window.localStorage.removeItem(GUEST_CART_STORAGE_KEY);
    else window.localStorage.setItem(GUEST_CART_STORAGE_KEY, JSON.stringify(cart));
  } catch {
    // Private mode or storage full: the cart simply is not kept.
  }
  try {
    window.dispatchEvent(new Event(GUEST_CART_EVENT));
  } catch {
    // no window (tests)
  }
}

export function clearGuestCart(): void {
  writeGuestCart(emptyGuestCart(Date.now()));
}

/** Adds to the browser's guest cart; false when it is full or the quantity is not valid. */
export function addToGuestCart(shopProductId: string, quantity: number): GuestCartChange {
  const change = addGuestCartLine(readGuestCart(), shopProductId, quantity, Date.now());
  if (change.ok) writeGuestCart(change.cart);
  return change;
}

export function setGuestCartQuantity(shopProductId: string, quantity: number): GuestCart {
  const next = setGuestCartLine(readGuestCart(), shopProductId, quantity, Date.now());
  writeGuestCart(next);
  return next;
}

/** Message shown when the guest cart refuses a line. */
export function guestCartRefusal(reason: "FULL" | "BAD_QUANTITY"): string {
  return reason === "FULL"
    ? `Your cart holds up to ${GUEST_CART_MAX_LINES} different items. Sign in to add more.`
    : "Could not add to cart.";
}
