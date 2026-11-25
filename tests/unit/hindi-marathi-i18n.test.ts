/**
 * Module 6 — Hindi and Marathi for inner pages (docs/hindi-marathi-2026-11/).
 *
 *  1. Every `L(en, hi, mr)` in src has all three texts, and none is blank.
 *  2. The customer error map: English untouched, known messages translated,
 *     names / amounts kept, unknown messages left as they are.
 *  3. Notification wording: English unless a language is asked for and every
 *     variable is there.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CODE_TEXT, ERROR_TEXT, errorText } from "@/lib/board/error-text";
import { L, tr } from "@/lib/board/i18n";
import {
  hasTranslation,
  renderEmail,
  renderTranslated,
  TEMPLATE_TRANSLATIONS,
  TEMPLATES,
} from "@/server/notifications/templates";
import { NOTIFICATION_TYPES as T } from "@/server/notifications/types";

const SRC = path.resolve(__dirname, "../../src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** A JS string literal: "…", '…' or `…` (a template may hold ${name}). */
const STR = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`;
const L_START = /(?<![\w.$])L\(\s*["'\x60]/g;
const L_CALL = new RegExp(String.raw`^L\(\s*${STR}\s*,\s*${STR}\s*,\s*${STR}\s*,?\s*\)`);

function unquote(literal: string): string {
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

interface LCall {
  file: string;
  line: number;
  en: string;
  hi: string;
  mr: string;
}

function collectLCalls(): { calls: LCall[]; unparsed: string[] } {
  const calls: LCall[] = [];
  const unparsed: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("L(")) continue;
    for (const m of text.matchAll(L_START)) {
      const at = m.index ?? 0;
      const line = text.slice(0, at).split("\n").length;
      const rel = `${path.relative(SRC, file)}:${line}`;
      const call = L_CALL.exec(text.slice(at, at + 4000));
      if (!call) {
        unparsed.push(rel);
        continue;
      }
      calls.push({ file: rel, line, en: unquote(call[1]), hi: unquote(call[2]), mr: unquote(call[3]) });
    }
  }
  return { calls, unparsed };
}

describe("L(en, hi, mr) labels across src", () => {
  const { calls, unparsed } = collectLCalls();

  it("finds the labels (sanity)", () => {
    expect(calls.length).toBeGreaterThan(900);
  });

  it("every L(...) call is three plain string literals", () => {
    expect(unparsed).toEqual([]);
  });

  it("no Hindi or Marathi text is empty", () => {
    const blank = calls.filter((c) => !c.en.trim() || !c.hi.trim() || !c.mr.trim()).map((c) => c.file);
    expect(blank).toEqual([]);
  });

  it("Hindi and Marathi are written in Devanagari (or are a brand / number kept as is)", () => {
    // A translation identical to the English is allowed only when it has no letters to translate
    // or is a name kept as is (brands, codes) — flag whole English sentences copied over.
    const copied = calls
      .filter((c) => /[a-z]{3,}\s+[a-z]{3,}\s+[a-z]{3,}/i.test(c.en))
      .filter((c) => !/[ऀ-ॿ]/.test(c.hi) || !/[ऀ-ॿ]/.test(c.mr))
      .map((c) => c.file);
    expect(copied).toEqual([]);
  });
});

describe("tr()", () => {
  it("falls back to English per string", () => {
    expect(tr({ en: "Pay", hi: "", mr: "पैसे द्या" }, "hi")).toBe("Pay");
    expect(tr(L("Pay", "भुगतान करें", "पैसे द्या"), "mr")).toBe("पैसे द्या");
  });
});

describe("customer error messages", () => {
  it("has about thirty messages, every one complete", () => {
    const entries = Object.entries(ERROR_TEXT);
    expect(entries.length).toBeGreaterThanOrEqual(30);
    for (const [key, text] of entries) {
      expect(text.en).toBe(key);
      expect(text.hi.trim()).not.toBe("");
      expect(text.mr.trim()).not.toBe("");
      expect(text.hi).toMatch(/[ऀ-ॿ]/);
      expect(text.mr).toMatch(/[ऀ-ॿ]/);
    }
    for (const text of Object.values(ERROR_CODE_TEXT)) {
      expect(text.hi).toMatch(/[ऀ-ॿ]/);
      expect(text.mr).toMatch(/[ऀ-ॿ]/);
    }
  });

  it("returns English exactly as received", () => {
    expect(errorText("That coupon has expired.", "en")).toBe("That coupon has expired.");
    expect(errorText("Some brand-new server message.", "en", "RATE_LIMITED")).toBe("Some brand-new server message.");
    expect(errorText(undefined, "en")).toBe("");
  });

  it("translates a known message", () => {
    expect(errorText("That coupon has expired.", "hi")).toBe("इस कूपन की अवधि खत्म हो गई है।");
    expect(errorText("Your cart is empty.", "mr")).toBe("तुमचे कार्ट रिकामे आहे.");
    expect(errorText("  Out of stock. ", "hi")).toBe("स्टॉक में नहीं है।");
  });

  it("keeps the shop name and amounts inside a message", () => {
    expect(errorText("Kesari Dairy needs a minimum order of ₹150 — add ₹40 more.", "hi")).toBe(
      "Kesari Dairy में कम से कम ₹150 का ऑर्डर ज़रूरी है — ₹40 और जोड़ें।",
    );
    expect(errorText("Kesari Dairy does not deliver to Home. Too far (8.2 km).", "mr")).toBe(
      "Kesari Dairy Home येथे डिलिव्हरी करत नाही.",
    );
    expect(errorText("Please wait 42 seconds before requesting another code.", "mr")).toBe(
      "नवीन कोड मागण्यापूर्वी 42 सेकंद थांबा.",
    );
  });

  it("uses a general line for a code whose meaning is the whole story", () => {
    expect(errorText("Too many document checks in the last hour.", "hi", "RATE_LIMITED")).toBe(
      tr(ERROR_CODE_TEXT.RATE_LIMITED, "hi"),
    );
  });

  it("leaves an unknown message in English rather than guessing", () => {
    expect(errorText("GSTIN checksum does not match.", "hi", "VALIDATION_FAILED")).toBe("GSTIN checksum does not match.");
    expect(errorText("GSTIN checksum does not match.", "mr")).toBe("GSTIN checksum does not match.");
  });
});

describe("notification wording in Hindi and Marathi", () => {
  const vars = { orderNumber: "GK-1042", shopName: "Kesari Dairy" };

  it("covers the main customer events, every one in both languages", () => {
    for (const type of [T.ORDER_CONFIRMED, T.ORDER_OUT_FOR_DELIVERY, T.ORDER_DELIVERED, T.ORDER_CANCELLED, T.RETURN_REFUND_COMPLETED]) {
      expect(hasTranslation(type)).toBe(true);
      expect(TEMPLATES[type]).toBeDefined();
    }
    for (const wording of Object.values(TEMPLATE_TRANSLATIONS)) {
      for (const lang of ["hi", "mr"] as const) {
        expect(wording[lang].title).toMatch(/[ऀ-ॿ]/);
        expect(wording[lang].body).toMatch(/[ऀ-ॿ]/);
      }
    }
  });

  it("is English (null) without a language, for English, or for an event without wording", () => {
    expect(renderTranslated(T.ORDER_DELIVERED, vars, undefined)).toBeNull();
    expect(renderTranslated(T.ORDER_DELIVERED, vars, "en")).toBeNull();
    expect(renderTranslated(T.SHOP_ORDER_DELIVERED, vars, "hi")).toBeNull();
  });

  it("keeps English when a variable the translation needs is missing", () => {
    expect(renderTranslated(T.ORDER_CONFIRMED, { orderNumber: "GK-1042", shopName: null }, "hi")).toBeNull();
    expect(renderTranslated(T.ORDER_CONFIRMED, undefined, "mr")).toBeNull();
  });

  it("fills the order number and shop name", () => {
    expect(renderTranslated(T.ORDER_CONFIRMED, vars, "hi")).toEqual({
      title: "ऑर्डर की पुष्टि हुई",
      body: "Kesari Dairy से आपका ऑर्डर GK-1042 पक्का हो गया है।",
    });
    expect(renderTranslated(T.ORDER_DELIVERED, vars, "mr")?.body).toBe("तुमची ऑर्डर GK-1042 पोहोचली आहे. धन्यवाद!");
    // A blank cancel reason is allowed, as in English.
    expect(renderTranslated(T.ORDER_CANCELLED, { ...vars, reason: "" }, "hi")?.body).toBe("आपका ऑर्डर GK-1042 रद्द हो गया।");
  });

  it("e-mail chrome stays English by default and follows the language when asked", () => {
    const en = renderEmail({ title: "Order delivered", body: "Done.", actionUrl: "/orders", baseUrl: "https://gokesari.com" });
    expect(en.text).toContain("You receive this because of your notification settings on Gokesari.");
    expect(en.html).toContain(">Open in Gokesari</a>");
    const hi = renderEmail({ title: "ऑर्डर डिलीवर हुआ", body: "…", actionUrl: "/orders", baseUrl: "https://gokesari.com", lang: "hi" });
    expect(hi.html).toContain("Gokesari में खोलें");
    expect(hi.subject).toBe("ऑर्डर डिलीवर हुआ — Gokesari");
  });
});
