/**
 * Small presentation helpers for product cards (no data changes).
 */

/**
 * Price wording by unit, so "₹100 / ml" — which reads as a price per
 * millilitre — becomes "₹100 per pack". Loose goods priced per litre or
 * kilogram keep "/ L", "/ kg"; counted goods read "each".
 */
export function priceUnitLabel(unit: string | null | undefined): string {
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "l" || u === "litre" || u === "liter") return "/ L";
  if (u === "kg") return "/ kg";
  if (u === "" || u === "piece" || u === "pc" || u === "unit" || u === "each" || u === "dozen") return u === "dozen" ? "/ dozen" : "each";
  // g, ml and other pack sizes: the price is for the pack shown in the name.
  return "per pack";
}

const CATEGORY_EMOJI: [RegExp, string][] = [
  // First, so "Camphor Tablets" or "Diya oil" read as puja, not medicine or grocery (image audit 26-Nov-2026).
  [/puja|pooja|samagri|agarbatti|dhoop|diya|kapur|camphor|kumkum|havan/i, "🪔"],
  [/milk|dairy|curd|paneer|ghee|butter|cheese/i, "🥛"],
  [/bread|bakery|cake|biscuit|bun/i, "🍞"],
  [/fruit|vegetable|veg|sabzi/i, "🥬"],
  [/sweet|mithai|chocolate/i, "🍬"],
  [/pharma|medicine|health|tablet/i, "💊"],
  [/clean|household|detergent|soap|personal care/i, "🧴"],
  [/rice|atta|flour|dal|pulse|grain|grocery|kirana|oil|spice|masala|sugar/i, "🍚"],
  [/egg|meat|chicken|fish/i, "🥚"],
  [/stationery|book|pen/i, "📒"],
  // Image audit 26-Nov-2026: shop types that fell back to the shopping bag.
  [/hardware|building|cement|paint|tool/i, "🧰"],
  [/agri|seed|fertili[sz]er|pesticide/i, "🌱"],
  [/newspaper|magazine/i, "📰"],
  [/restaurant|meal|thali|food/i, "🍽️"],
];

/** A picture for a product with no photo yet, chosen from its category (instead of one grey placeholder for all). */
export function categoryEmoji(...names: (string | null | undefined)[]): string {
  const text = names.filter(Boolean).join(" ");
  return CATEGORY_EMOJI.find(([re]) => re.test(text))?.[1] ?? "🛍️";
}
