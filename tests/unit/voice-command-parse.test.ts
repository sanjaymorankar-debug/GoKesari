import { describe, expect, it } from "vitest";

import { endOfIstDay, offerEndsAt, parseVoiceCommand, yesOrNo } from "@/lib/voice-command-parse";

describe("parseVoiceCommand — price", () => {
  it("English, pack size stays in the product", () => {
    const c = parseVoiceCommand("Amul Taaza 1 litre price 58 rupees");
    expect(c.newPricePaise).toBe(5800);
    expect(c.productText).toBe("amul taaza 1 litre");
    expect(c.offer).toBeNull();
    expect(c.hasChange).toBe(true);
  });
  it("Marathi number words and case ending", () => {
    const c = parseVoiceCommand("अमूल ताजाची किंमत अठ्ठावन्न रुपये करा");
    expect(c.newPricePaise).toBe(5800);
    expect(c.productText).toBe("अमूल ताजा");
  });
  it("Hindi, rupee sign and per kg", () => {
    const c = parseVoiceCommand("चीनी का भाव ₹45 प्रति किलो कर दो");
    expect(c.newPricePaise).toBe(4500);
    expect(c.productText).toBe("चीनी");
  });
  it("a bare number is the price", () => {
    expect(parseVoiceCommand("Parle G 5 kar do").newPricePaise).toBe(500);
  });
  it("Marathi hundreds", () => {
    expect(parseVoiceCommand("तेल दीडशे रुपये").newPricePaise).toBe(15000);
  });
  it("Devanagari digits", () => {
    expect(parseVoiceCommand("साखर ४५ रुपये किलो").newPricePaise).toBe(4500);
  });
});

describe("parseVoiceCommand — offers", () => {
  it("percent off until a weekday (Marathi)", () => {
    const c = parseVoiceCommand("साखर 10 टक्के सूट रविवार पर्यंत");
    expect(c.offer).toEqual({ type: "PERCENT", percent: 10 });
    expect(c.until).toEqual({ kind: "weekday", weekday: 0 });
    expect(c.newPricePaise).toBeNull();
    expect(c.productText).toBe("साखर");
  });
  it("rupees off for N days (English)", () => {
    const c = parseVoiceCommand("Parle G 2 rupees off for 3 days");
    expect(c.offer).toEqual({ type: "FLAT", flatPaise: 200 });
    expect(c.until).toEqual({ kind: "days", days: 3 });
    expect(c.productText).toBe("parle g");
  });
  it("price and offer together (Hindi), a week", () => {
    const c = parseVoiceCommand("तेल 150 रुपये और 5 प्रतिशत छूट एक हफ्ता");
    expect(c.newPricePaise).toBe(15000);
    expect(c.offer).toEqual({ type: "PERCENT", percent: 5 });
    expect(c.until).toEqual({ kind: "days", days: 7 });
    expect(c.productText).toBe("तेल");
  });
  it("10% with the sign, till tomorrow", () => {
    const c = parseVoiceCommand("Maggi 10% discount till tomorrow");
    expect(c.offer).toEqual({ type: "PERCENT", percent: 10 });
    expect(c.until).toEqual({ kind: "tomorrow" });
  });
  it("buy one get one is flagged, not turned into an offer", () => {
    const c = parseVoiceCommand("Colgate buy 1 get 1 free");
    expect(c.buyGetFree).toBe(true);
    expect(c.offer).toBeNull();
    expect(c.hasChange).toBe(true);
  });
  it("no change found", () => {
    const c = parseVoiceCommand("Amul butter 500 g");
    expect(c.hasChange).toBe(false);
    expect(c.productText).toBe("amul butter 500 g");
  });
});

describe("yes / no", () => {
  it.each(["हो", "होय", "हाँ", "हां ठीक है", "yes", "ok", "बरोबर", "हो करा"])("%s is yes", (t) => expect(yesOrNo(t)).toBe("YES"));
  it.each(["नाही", "नहीं", "no", "cancel", "नको"])("%s is no", (t) => expect(yesOrNo(t)).toBe("NO"));
  it("a command is neither", () => expect(yesOrNo("साखर 45 रुपये")).toBeNull());
  it("parse returns confirm", () => expect(parseVoiceCommand("हो").confirm).toBe("YES"));
});

describe("offer end dates (IST)", () => {
  // 23-Nov-2026 is a Monday; 10.00 IST = 04.30 UTC.
  const now = new Date("2026-11-23T04:30:00Z");
  it("end of the IST day", () => expect(endOfIstDay(now).toISOString()).toBe("2026-11-23T18:29:59.999Z"));
  it("till Sunday", () => expect(offerEndsAt({ kind: "weekday", weekday: 0 }, now, 7).toISOString()).toBe("2026-11-29T18:29:59.999Z"));
  it("till Monday (today)", () => expect(offerEndsAt({ kind: "weekday", weekday: 1 }, now, 7).toISOString()).toBe("2026-11-23T18:29:59.999Z"));
  it("3 days", () => expect(offerEndsAt({ kind: "days", days: 3 }, now, 7).toISOString()).toBe("2026-11-25T18:29:59.999Z"));
  it("default 7 days", () => expect(offerEndsAt(null, now, 7).toISOString()).toBe("2026-11-29T18:29:59.999Z"));
  it("late at night IST is still the IST day", () => {
    const late = new Date("2026-11-23T18:00:00Z"); // 23.30 IST Monday
    expect(offerEndsAt({ kind: "today" }, late, 7).toISOString()).toBe("2026-11-23T18:29:59.999Z");
  });
});

describe("Devanagari → Latin for matching", async () => {
  const { devanagariToLatin } = await import("@/lib/devanagari-latin");
  it.each([
    ["अमूल बटर", "amul batar"],
    ["पारले जी", "parale ji"],
    ["मॅगी", "megi"],
    ["ताजा", "taja"],
  ])("%s → %s", (d, l) => expect(devanagariToLatin(d)).toBe(l));
});

describe("buy-get-free counts are not prices", () => {
  it("buy 1 get 1 free", () => {
    const c = parseVoiceCommand("Amul Butter buy 1 get 1 free");
    expect(c.newPricePaise).toBeNull();
    expect(c.buyGetFree).toBe(true);
  });
  it("1 पर 1 फ्री", () => expect(parseVoiceCommand("साबण 1 पर 1 फ्री").newPricePaise).toBeNull());
  it("Hinglish words are not the product", () => expect(parseVoiceCommand("Amul Taaza ka rate 59 kar do").productText).toBe("amul taaza"));
});
