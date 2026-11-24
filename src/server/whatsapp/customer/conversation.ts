/**
 * Shopping by WhatsApp chat — the conversation itself, with no database or
 * network (docs/customer-whatsapp-2026-11/README.md). sessions.ts loads the
 * session, calls converse() with the real search and link makers, saves the
 * result and sends the replies.
 *
 *   IDLE        "milk" / "search milk"  → results near the saved PIN   → PICK
 *               (no PIN known yet)      → "send your PIN"              → AWAIT_PIN
 *   AWAIT_PIN   "411001"                → the waiting search runs      → PICK
 *   PICK        "2"                     → "how many?"                  → QTY
 *   QTY         "3"                     → added to the chat cart       → IDLE
 *   any state   "cart"                  → cart summary
 *               "checkout"              → signed checkout link, chat cart emptied
 *               "clear"                 → chat cart emptied
 *               "pin 411038" / "411038" → PIN changed
 *               "help" / "hi"           → what to send
 *
 * Every reply has a plain-text form with numbered choices (works on any
 * provider); where Meta allows, the same choices also go as a list or buttons.
 */
import { formatPaise } from "@/lib/money";
import type { WhatsAppCartLine, WhatsAppPickOption, WhatsAppSessionContext, WhatsAppSessionState } from "@/server/db/schema";

export interface BotReply {
  /** The full text (numbered choices included): plain-text sends and the mock outbox. */
  text: string;
  /** The text above an interactive list / buttons (the choices are in the list). */
  interactiveText?: string;
  buttons?: { id: string; title: string }[];
  list?: { button: string; rows: { id: string; title: string; description?: string }[] };
}

export interface SessionSnapshot {
  state: WhatsAppSessionState;
  context: WhatsAppSessionContext;
  cart: WhatsAppCartLine[];
  pincode: string | null;
}

export interface ConversationDeps {
  /** Buyable products near the PIN code, best first. */
  search(query: string, pincode: string): Promise<WhatsAppPickOption[]>;
  /** A signed checkout link for these lines. */
  checkoutLink(cart: WhatsAppCartLine[]): Promise<{ url: string; expiresInMinutes: number }>;
  maxResults: number;
  maxQuantity: number;
}

export interface ConversationResult {
  session: SessionSnapshot;
  replies: BotReply[];
}

const PIN = /^\d{6}$/;
const GREETING = /^(hi|hii|hello|hey|help|menu|namaste|namaskar|start shopping|\?)$/;

export const HELP_TEXT =
  "GoKesari on WhatsApp 🛒\n" +
  "• Send a product name (e.g. \"milk\" or \"search atta\") to see prices at shops near you.\n" +
  "• Reply with a number to pick, then the quantity.\n" +
  "• \"cart\" shows your cart, \"checkout\" sends a secure link to order on GoKesari, \"clear\" empties the cart.\n" +
  "• \"pin 411001\" changes your PIN code. \"STOP\" stops WhatsApp messages, \"START\" turns them back on.";

/** A list row / button reply id → the text the customer would have typed. */
export function inboundTextFromReplyId(id: string | null | undefined): string | null {
  const m = /^wa:(?:pick|qty):(\d{1,3})$/.exec((id ?? "").trim());
  return m ? m[1] : null;
}

export function cartTotalPaise(cart: WhatsAppCartLine[]): number {
  return cart.reduce((sum, line) => sum + line.unitPricePaise * line.quantity, 0);
}

export function cartSummary(cart: WhatsAppCartLine[]): string {
  if (cart.length === 0) return "Your cart is empty. Send a product name to start.";
  const lines = cart.map((l, i) => `${i + 1}. ${l.name} × ${l.quantity} — ${formatPaise(l.unitPricePaise * l.quantity)} (${l.shopName})`);
  return `Your cart:\n${lines.join("\n")}\nTotal ${formatPaise(cartTotalPaise(cart))} (before delivery fees).\nSend "checkout" to order, or another product name to add more.`;
}

/** Adds a quantity of an option to the cart, merging the same listing; the line never passes `max`. */
export function addToChatCart(cart: WhatsAppCartLine[], option: WhatsAppPickOption, quantity: number, max: number): WhatsAppCartLine[] {
  const existing = cart.find((l) => l.shopProductId === option.shopProductId);
  if (existing) {
    return cart.map((l) =>
      l.shopProductId === option.shopProductId ? { ...l, quantity: Math.min(max, l.quantity + quantity), unitPricePaise: option.unitPricePaise } : l,
    );
  }
  return [
    ...cart,
    { shopProductId: option.shopProductId, name: option.name, shopName: option.shopName, unitPricePaise: option.unitPricePaise, quantity: Math.min(max, quantity) },
  ];
}

function resultsReply(query: string, pincode: string, options: WhatsAppPickOption[]): BotReply {
  const lines = options.map((o, i) => `${i + 1}. ${o.name} — ${formatPaise(o.unitPricePaise)} — ${o.availability} — ${o.shopName}`);
  const head = `Results for "${query}" near ${pincode}:`;
  return {
    text: `${head}\n${lines.join("\n")}\nReply with the number to pick.`,
    interactiveText: `${head} pick one.`,
    list: {
      button: "Choose a product",
      rows: options.map((o, i) => ({
        id: `wa:pick:${i + 1}`,
        title: `${i + 1}. ${o.name}`,
        description: `${formatPaise(o.unitPricePaise)} · ${o.availability} · ${o.shopName}`,
      })),
    },
  };
}

function quantityReply(option: WhatsAppPickOption, max: number): BotReply {
  const head = `${option.name} at ${option.shopName}, ${formatPaise(option.unitPricePaise)} each. How many?`;
  return {
    text: `${head} Reply with a number from 1 to ${max}.`,
    interactiveText: head,
    buttons: [1, 2, 3].filter((n) => n <= max).map((n) => ({ id: `wa:qty:${n}`, title: String(n) })),
  };
}

/** "search milk", "Search: \"milk\"", "milk" → "milk". */
export function searchQueryOf(text: string): string {
  return text
    .replace(/^\s*(search|find|show|khoj|खोज)\s*:?\s*/i, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

async function runSearch(session: SessionSnapshot, query: string, deps: ConversationDeps): Promise<ConversationResult> {
  if (query.length < 2) return { session: { ...session, state: "IDLE", context: {} }, replies: [{ text: HELP_TEXT }] };
  if (!session.pincode) {
    return {
      session: { ...session, state: "AWAIT_PIN", context: { pendingQuery: query } },
      replies: [{ text: `Which area? Send your 6-digit PIN code and I will look for "${query}" in shops near you.` }],
    };
  }
  const options = (await deps.search(query, session.pincode)).slice(0, deps.maxResults);
  if (options.length === 0) {
    return {
      session: { ...session, state: "IDLE", context: {} },
      replies: [{ text: `No shop near ${session.pincode} sells "${query}" online right now. Try another name, or send "pin" and a new PIN code.` }],
    };
  }
  return { session: { ...session, state: "PICK", context: { options } }, replies: [resultsReply(query, session.pincode, options)] };
}

/** One inbound text → the next session and the replies. STOP / START are handled before this (consent). */
export async function converse(session: SessionSnapshot, rawText: string, deps: ConversationDeps): Promise<ConversationResult> {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  if (!text || GREETING.test(lower)) return { session: { ...session, state: "IDLE", context: {} }, replies: [{ text: HELP_TEXT }] };

  if (lower === "cart" || lower === "my cart" || lower === "basket") {
    return { session, replies: [{ text: cartSummary(session.cart) }] };
  }
  if (lower === "clear" || lower === "empty" || lower === "clear cart") {
    return { session: { ...session, cart: [], state: "IDLE", context: {} }, replies: [{ text: "Your cart is now empty." }] };
  }
  if (lower === "cancel") {
    return { session: { ...session, state: "IDLE", context: {} }, replies: [{ text: "OK. Send a product name to search again." }] };
  }
  if (lower === "checkout" || lower === "check out" || lower === "order") {
    if (session.cart.length === 0) return { session, replies: [{ text: "Your cart is empty. Send a product name to start." }] };
    const link = await deps.checkoutLink(session.cart);
    return {
      session: { ...session, cart: [], state: "IDLE", context: {} },
      replies: [
        {
          text:
            `${cartSummary(session.cart).split("\nSend")[0]}\n\nOpen this secure link to review and order on GoKesari ` +
            `(sign in with this mobile number). It works once, for ${link.expiresInMinutes} minutes:\n${link.url}`,
        },
      ],
    };
  }

  const pinCommand = /^pin\s*:?\s*(\d{6})$/i.exec(text);
  if (pinCommand || (PIN.test(text) && session.state !== "QTY")) {
    const pincode = pinCommand ? pinCommand[1] : text;
    const pending = session.state === "AWAIT_PIN" ? session.context.pendingQuery : null;
    const next = { ...session, pincode, state: "IDLE" as const, context: {} };
    if (pending) return runSearch(next, pending, deps);
    return { session: next, replies: [{ text: `PIN code set to ${pincode}. Send a product name to search shops near you.` }] };
  }
  if (/^pin$/i.test(text)) {
    return { session: { ...session, state: "AWAIT_PIN", context: {} }, replies: [{ text: "Send your 6-digit PIN code." }] };
  }

  if (session.state === "AWAIT_PIN" && /^\d+$/.test(text)) {
    return { session, replies: [{ text: "A PIN code has 6 digits, e.g. 411001. Please send it again." }] };
  }

  if (session.state === "PICK" && /^\d{1,2}$/.test(text)) {
    const options = session.context.options ?? [];
    const option = options[Number(text) - 1];
    if (!option) return { session, replies: [{ text: `Please reply with a number from 1 to ${options.length}.` }] };
    if (!option.buyable) return { session, replies: [{ text: `${option.name} is out of stock at ${option.shopName}. Please pick another number.` }] };
    return { session: { ...session, state: "QTY", context: { ...session.context, picked: option } }, replies: [quantityReply(option, deps.maxQuantity)] };
  }

  if (session.state === "QTY" && /^\d+$/.test(text)) {
    const picked = session.context.picked;
    if (!picked) return { session: { ...session, state: "IDLE", context: {} }, replies: [{ text: HELP_TEXT }] };
    const quantity = Number(text);
    if (quantity < 1 || quantity > deps.maxQuantity) {
      return { session, replies: [{ text: `Please send a quantity from 1 to ${deps.maxQuantity}.` }] };
    }
    const cart = addToChatCart(session.cart, picked, quantity, deps.maxQuantity);
    return {
      session: { ...session, cart, state: "IDLE", context: {} },
      replies: [
        {
          text:
            `Added ${quantity} × ${picked.name} (${picked.shopName}). Cart: ${cart.length} item${cart.length === 1 ? "" : "s"}, ${formatPaise(cartTotalPaise(cart))}.\n` +
            `Send another product name, "cart" or "checkout".`,
        },
      ],
    };
  }

  // Anything else is a search (it also ends a pick or quantity question that was left open).
  return runSearch(session, searchQueryOf(text), deps);
}
