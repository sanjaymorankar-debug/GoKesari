import { describe, expect, it } from "vitest";

import { asciiDigits, packInBase, parseQuantity, planPacks } from "@/lib/qty-words";

describe("asciiDigits", () => {
  it("turns regional digits into 0–9", () => {
    expect(asciiDigits("दूध २ लिटर")).toBe("दूध 2 लिटर");
    expect(asciiDigits("૧૨ ইংরেজি ২৫ ௩")).toBe("12 ইংরেজি 25 3");
  });
});

describe("parseQuantity", () => {
  const q = (s: string) => {
    const p = parseQuantity(s);
    return p ? `${p.amount} ${p.unit}` : null;
  };
  it("reads Marathi lists", () => {
    expect(q("साखर १ किलो")).toBe("1000 g");
    expect(q("तांदूळ ५ किलो")).toBe("5000 g");
    expect(q("दूध २ लिटर")).toBe("2000 ml");
    expect(q("साबण ४ नग")).toBe("4 piece");
    expect(q("अर्धा किलो कांदा")).toBe("500 g");
    expect(q("पाव किलो तूप")).toBe("250 g");
    expect(q("तूप पाव")).toBe("250 g");
    expect(q("दोन पाव")).toBe("500 g");
    expect(q("अंडी १ डझन")).toBe("12 piece");
    expect(q("अंडी डझन")).toBe("12 piece");
    expect(q("बिस्किट २ पाकीट")).toBe("2 pack");
    expect(q("पावणे दोन किलो")).toBe("1750 g");
    expect(q("दीड लिटर")).toBe("1500 ml");
  });
  it("reads Hindi and English", () => {
    expect(q("चीनी १ किलो")).toBe("1000 g");
    expect(q("आधा किलो")).toBe("500 g");
    expect(q("Milk 2 litres")).toBe("2000 ml");
    expect(q("butter 500 gm")).toBe("500 g");
    expect(q("rice 2kg")).toBe("2000 g");
    expect(q("12 eggs")).toBe("12 piece");
    expect(q("₹60 per litre, 50 bottles")).toBe("50 piece");
  });
  it("is null with no quantity", () => {
    expect(parseQuantity("साखर")).toBeNull();
  });
});

describe("planPacks", () => {
  const req = (s: string) => parseQuantity(s)!;
  it("divides evenly", () => {
    const plan = planPacks(req("2 kg"), packInBase("kg", 1000)!);
    expect(plan).toMatchObject({ packs: 2, difference: 0 });
  });
  it("takes the nearest pack count and shows the difference", () => {
    const plan = planPacks(req("1.25 kg"), packInBase("g", 500_000)!);
    expect(plan?.packs).toBe(3);
    expect(plan?.difference).toBe(250);
  });
  it("never orders zero packs", () => {
    expect(planPacks(req("100 g"), packInBase("kg", 1000)!)?.packs).toBe(1);
  });
  it("refuses litres against kilos", () => {
    expect(planPacks(req("2 L"), packInBase("kg", 1000)!)).toBeNull();
  });
  it("takes packets as packs of anything", () => {
    expect(planPacks(req("2 packet"), packInBase("g", 200_000)!)?.packs).toBe(2);
  });
  it("dozen eggs against 6-piece trays", () => {
    expect(planPacks(req("1 dozen"), packInBase("piece", 6000)!)?.packs).toBe(2);
  });
});
