/**
 * Add product by photo + voice (docs/smart-shopping-2026-11/FEATURE2_PRODUCT_BY_PHOTO.md): the
 * deterministic price / stock / unit reader for what a shop owner says or types, in English,
 * Hindi and Marathi, and its conversion to one sellable catalogue unit.
 */
import { describe, expect, it } from "vitest";

import {
  catalogueUnitFor,
  parsePriceStock,
  priceAboveMrp,
  readBack,
  sellingUnitFromWord,
  toListingQuantities,
} from "@/lib/price-stock-parse";

const p = (text: string) => {
  const r = parsePriceStock(text);
  return { price: r.pricePaise === null ? null : r.pricePaise / 100, priceUnit: r.priceUnit, stock: r.stock, stockUnit: r.stockUnit };
};

describe("the owner's brief examples", () => {
  it("₹60 per litre, 50 bottles", () => {
    expect(p("₹60 per litre, 50 bottles")).toEqual({ price: 60, priceUnit: "litre", stock: 50, stockUnit: "piece" });
    expect(parsePriceStock("₹60 per litre, 50 bottles").stockWord).toBe("bottles");
  });
  it("₹40 per nug, 100 — the stock is in the price's unit", () => {
    expect(p("₹40 per nug, 100")).toEqual({ price: 40, priceUnit: "piece", stock: 100, stockUnit: "piece" });
  });
  it("120 रुपये किलो, 20 किलो", () => {
    expect(p("120 रुपये किलो, 20 किलो")).toEqual({ price: 120, priceUnit: "kg", stock: 20, stockUnit: "kg" });
  });
  it("साठ रुपये लिटर पन्नास बाटल्या (Marathi number words)", () => {
    expect(p("साठ रुपये लिटर पन्नास बाटल्या")).toEqual({ price: 60, priceUnit: "litre", stock: 50, stockUnit: "piece" });
  });
});

describe("English", () => {
  it.each([
    ["Rs 25 per packet, 40 packets", { price: 25, priceUnit: "packet", stock: 40, stockUnit: "packet" }],
    ["rs.30/kg stock 15 kg", { price: 30, priceUnit: "kg", stock: 15, stockUnit: "kg" }],
    ["₹500/box 12 box", { price: 500, priceUnit: "box", stock: 12, stockUnit: "box" }],
    ["50 rupees a dozen, 10 dozen", { price: 50, priceUnit: "dozen", stock: 10, stockUnit: "dozen" }],
    ["twenty rupees per metre, hundred metre", { price: 20, priceUnit: "metre", stock: 100, stockUnit: "metre" }],
    ["one hundred and twenty rupees per kg, forty five kg", { price: 120, priceUnit: "kg", stock: 45, stockUnit: "kg" }],
    ["₹12.50 each, 200", { price: 12.5, priceUnit: "piece", stock: 200, stockUnit: "piece" }],
    ["₹1,200 per box, 3 boxes", { price: 1200, priceUnit: "box", stock: 3, stockUnit: "box" }],
    ["price 60 stock 50", { price: 60, priceUnit: "piece", stock: 50, stockUnit: "piece" }],
    ["stock 50 price 60", { price: 60, priceUnit: "piece", stock: 50, stockUnit: "piece" }],
    ["₹45 per litre, 30 litre", { price: 45, priceUnit: "litre", stock: 30, stockUnit: "litre" }],
    ["60rs/litre 50 bottles.", { price: 60, priceUnit: "litre", stock: 50, stockUnit: "piece" }],
    ["₹80 per kg 2kg", { price: 80, priceUnit: "kg", stock: 2, stockUnit: "kg" }],
  ])("%s", (text, want) => {
    expect(p(text)).toMatchObject(want);
  });
});

describe("Hindi", () => {
  it.each([
    ["60 रुपये प्रति लीटर, स्टॉक 50 बोतल", { price: 60, priceUnit: "litre", stock: 50, stockUnit: "piece" }],
    ["साठ रुपये लीटर, पचास बोतलें", { price: 60, priceUnit: "litre", stock: 50, stockUnit: "piece" }],
    ["एक सौ बीस रुपये किलो, बीस किलो", { price: 120, priceUnit: "kg", stock: 20, stockUnit: "kg" }],
    ["चालीस रुपये पैकेट, सौ पैकेट", { price: 40, priceUnit: "packet", stock: 100, stockUnit: "packet" }],
    ["अस्सी रुपये दर्जन, दस दर्जन", { price: 80, priceUnit: "dozen", stock: 10, stockUnit: "dozen" }],
    ["₹१५ प्रति पीस, २०० पीस", { price: 15, priceUnit: "piece", stock: 200, stockUnit: "piece" }],
    ["पच्चीस रुपए का एक पैकेट, तीस", { price: 25, priceUnit: "packet", stock: 30, stockUnit: "packet" }],
    ["नब्बे रुपये डिब्बा, बारह डिब्बे", { price: 90, priceUnit: "box", stock: 12, stockUnit: "box" }],
  ])("%s", (text, want) => {
    expect(p(text)).toMatchObject(want);
  });
});

describe("Marathi", () => {
  it.each([
    ["एकशे वीस रुपये किलो, वीस किलो", { price: 120, priceUnit: "kg", stock: 20, stockUnit: "kg" }],
    ["दीडशे रुपये किलो, पंधरा किलो", { price: 150, priceUnit: "kg", stock: 15, stockUnit: "kg" }],
    ["चाळीस रुपये नग, शंभर नग", { price: 40, priceUnit: "piece", stock: 100, stockUnit: "piece" }],
    ["साठ रुपये लिटरला, पन्नास बाटल्या", { price: 60, priceUnit: "litre", stock: 50, stockUnit: "piece" }],
    ["पंचवीस रुपये पाकीट, चाळीस पाकिटे", { price: 25, priceUnit: "packet", stock: 40, stockUnit: "packet" }],
    ["सत्तर रुपये डझन, दहा डझन", { price: 70, priceUnit: "dozen", stock: 10, stockUnit: "dozen" }],
    ["दहा रुपये प्रति मीटर, शंभर मीटर", { price: 10, priceUnit: "metre", stock: 100, stockUnit: "metre" }],
    ["₹४० प्रति नग, साठा १००", { price: 40, priceUnit: "piece", stock: 100, stockUnit: "piece" }],
    ["दोनशे रुपये डबा, बारा डबे", { price: 200, priceUnit: "box", stock: 12, stockUnit: "box" }],
    ["तीस रुपये ग्रॅम, पाचशे ग्रॅम", { price: 30, priceUnit: "g", stock: 500, stockUnit: "g" }],
  ])("%s", (text, want) => {
    expect(p(text)).toMatchObject(want);
  });

  it("a word after 'per' that is no unit is the owner's own unit", () => {
    const r = parsePriceStock("₹10 प्रति जुडी, 30");
    expect(r).toMatchObject({ pricePaise: 1000, priceUnit: "custom", customUnit: "जुडी", stock: 30, stockUnit: "custom" });
    expect(readBack(r, "mr")).toBe("किंमत ₹10 प्रति जुडी, साठा 30 जुडी");
  });
});

describe("incomplete input", () => {
  it("says what is missing", () => {
    expect(parsePriceStock("₹60 per litre")).toMatchObject({ pricePaise: 6000, stock: null, complete: false, missing: ["stock"] });
    expect(parsePriceStock("stock 50")).toMatchObject({ pricePaise: null, stock: 50, complete: false, missing: ["price"] });
    expect(parsePriceStock("")).toMatchObject({ complete: false, missing: ["price", "stock"] });
    expect(parsePriceStock("अच्छा माल है")).toMatchObject({ complete: false });
  });
});

describe("unit words", () => {
  it.each([
    ["nug", "piece"], ["नग", "piece"], ["kg", "kg"], ["किलोला", "kg"], ["ग्रॅम", "g"], ["litre", "litre"], ["लिटरला", "litre"],
    ["मि.ली.", "ml"], ["dozen", "dozen"], ["डझन", "dozen"], ["पाकिटे", "packet"], ["पैकेट", "packet"], ["box", "box"], ["डबे", "box"],
    ["metre", "metre"], ["मीटर", "metre"], ["bottles", "piece"], ["बाटल्या", "piece"],
  ])("%s → %s", (word, unit) => {
    expect(sellingUnitFromWord(word)).toBe(unit);
  });
  it("leaves numbers and other words alone", () => {
    expect(sellingUnitFromWord("पन्नास")).toBeNull();
    expect(sellingUnitFromWord("60")).toBeNull();
    expect(sellingUnitFromWord("जुडी")).toBeNull();
  });
  it("maps every selling unit to a catalogue unit", () => {
    expect(catalogueUnitFor("litre")).toBe("L");
    expect(catalogueUnitFor("box")).toBe("pack");
    expect(catalogueUnitFor("metre")).toBe("piece");
    expect(catalogueUnitFor("custom")).toBe("piece");
    expect(catalogueUnitFor("dozen")).toBe("dozen");
  });
});

describe("read-back", () => {
  it("in English, Hindi and Marathi", () => {
    const r = parsePriceStock("₹60 per litre, 50 bottles");
    expect(readBack(r, "en")).toBe("Price ₹60 per litre, stock 50 bottles");
    expect(readBack(r, "hi")).toBe("कीमत ₹60 प्रति लीटर, स्टॉक 50 पीस");
    expect(readBack(r, "mr")).toBe("किंमत ₹60 प्रति लिटर, साठा 50 नग");
    expect(readBack(parsePriceStock("₹60 per litre"), "en")).toBe("Price ₹60 per litre, stock not given");
  });
});

describe("one sellable unit", () => {
  const said = (text: string) => parsePriceStock(text);
  it("a 1 L bottle sold at ₹60 a litre: ₹60 a bottle, 50 bottles", () => {
    expect(toListingQuantities(said("₹60 per litre, 50 bottles"), { size: 1, unit: "litre" })).toMatchObject({ unit: "L", unitSizeMilli: 1000, loose: false, pricePaise: 6000, stock: 50 });
  });
  it("a 500 ml bottle at ₹60 a litre is ₹30", () => {
    expect(toListingQuantities(said("₹60 per litre, 50 bottles"), { size: 500, unit: "ml" })).toMatchObject({ unit: "ml", unitSizeMilli: 500_000, pricePaise: 3000, stock: 50 });
  });
  it("loose goods by the kilo keep decimals", () => {
    expect(toListingQuantities(said("120 रुपये किलो, 20.5 किलो"), { size: null, unit: null })).toMatchObject({ unit: "kg", unitSizeMilli: 1000, loose: true, pricePaise: 12000, stock: 20.5 });
  });
  it("a 500 g pack with stock said in kilos", () => {
    expect(toListingQuantities(said("₹40 per packet, 10 kg"), { size: 500, unit: "g" })).toMatchObject({ unit: "g", pricePaise: 4000, stock: 20 });
  });
  it("pieces, metres and custom units", () => {
    expect(toListingQuantities(said("₹40 per nug, 100"), { size: null, unit: null })).toMatchObject({ unit: "piece", pricePaise: 4000, stock: 100, loose: false });
    const metre = toListingQuantities(said("₹10 per metre, 100 metre"), { size: null, unit: null });
    expect(metre).toMatchObject({ unit: "piece", pricePaise: 1000, stock: 100 });
    expect(metre.notes[0]).toMatch(/one piece = one metre/);
    expect(toListingQuantities(said("₹10 प्रति जुडी, 30"), { size: null, unit: null }).notes[0]).toMatch(/जुडी/);
  });
  it("a dozen price for a product listed per piece", () => {
    expect(toListingQuantities(said("₹60 per dozen, 10 dozen"), { size: null, unit: null }, { amount: 1, unit: "piece" })).toMatchObject({ pricePaise: 500, stock: 120 });
  });
});

describe("MRP check", () => {
  it("warns only when the price is above a known MRP", () => {
    expect(priceAboveMrp(6500, 6000)).toBe(true);
    expect(priceAboveMrp(6000, 6000)).toBe(false);
    expect(priceAboveMrp(6500, null)).toBe(false);
    expect(priceAboveMrp(null, 6000)).toBe(false);
  });
});
