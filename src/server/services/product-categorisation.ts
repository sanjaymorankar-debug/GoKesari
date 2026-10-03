/**
 * Rules for the one-time categorisation of existing products
 * (scripts/categorise-products.ts). Pure functions — no database — so the dry
 * run, the apply step and the unit tests all use exactly the same logic.
 *
 * How a product is scored against each target category:
 *   - a keyword in the product NAME            3 points (+1 if it is the last
 *     matched keyword: Indian product names end in the head noun —
 *     "Milk Bread" is bread, "Chocolate Milk" is milk)
 *   - a keyword in the DESCRIPTION             1 point (once per keyword)
 *   - a keyword in the OLD CATEGORY name       2 points, unless the old
 *     category is just a shop-type label ("Grocery / Kirana Store")
 *   - a known BRAND                            3 points
 *   - the old category's DEPARTMENT            3 points when it is a
 *     specialist shop type (a product filed under "Bookstore" is a book),
 *     1 point for Grocery/Kirana, nothing for mixed types (Supermarket…)
 *   - the UNIT (L/ml → liquids)                0.5 points
 * Keywords match on word boundaries, longest first, and a matched span is not
 * reused — so "peanut butter" counts for Grocery and not also for Dairy.
 * A product goes to its best category only when that scores at least 3 and
 * leads the runner-up by at least 1; otherwise it goes to General.
 */
import { SHOP_TYPES } from "@/lib/shop-types";
import type { Department } from "@/server/db/schema";

export interface TargetCategory {
  name: string;
  department: Department;
  description: string;
  keywords: readonly string[];
  brands?: readonly string[];
  /** Units that hint at this category (e.g. "l", "ml" for liquids). */
  units?: readonly string[];
}

export const GENERAL = "General";

const CURATED: TargetCategory[] = [
  {
    name: "Dairy",
    department: "DAIRY",
    description: "Milk, curd, paneer, butter, ghee, cheese and other milk products.",
    keywords: [
      "milk", "toned milk", "cow milk", "buffalo milk", "curd", "dahi", "paneer", "ghee", "butter", "cheese", "mozzarella",
      "buttermilk", "chaas", "chhaas", "lassi", "fresh cream", "malai", "khoa", "khova", "mawa", "shrikhand", "yogurt",
      "yoghurt", "flavoured milk", "milkshake", "dairy", "basundi", "rabdi", "milk powder", "cream",
    ],
    brands: ["amul", "gokul", "chitale", "mother dairy", "nandini", "warana", "katraj", "govardhan", "aarey", "milky mist", "nestle a+"],
    units: ["l", "ltr", "litre", "liter", "ml"],
  },
  {
    name: "Bakery",
    department: "BAKERY",
    description: "Bread, buns, cakes, pastries, cookies, khari and other baked goods.",
    keywords: [
      "bread", "milk bread", "brown bread", "multigrain bread", "bun", "buns", "pav", "cake", "cakes", "pastry", "pastries",
      "cookie", "cookies", "khari", "toast", "rusk", "muffin", "donut", "doughnut", "puff", "puffs", "croissant",
      "nankhatai", "bakery", "baked", "brownie", "sponge", "burger bun", "pizza base", "garlic bread",
    ],
    brands: ["modern", "harvest gold", "english oven", "monginis", "theobroma"],
  },
  {
    name: "Fruits & Vegetables",
    department: "FRUIT_VEGETABLE",
    description: "Fresh fruits, vegetables, leafy greens, herbs and sprouts.",
    keywords: [
      "fruit", "fruits", "vegetable", "vegetables", "fresh produce", "produce", "leafy", "greens", "herbs", "sprouts",
      "apple", "banana", "mango", "orange", "grapes", "papaya", "pomegranate", "guava", "watermelon", "pineapple",
      "chikoo", "sapota", "lemon", "onion", "onions", "potato", "potatoes", "tomato", "tomatoes", "carrot", "cabbage",
      "cauliflower", "brinjal", "spinach", "palak", "methi", "coriander", "kothimbir", "cucumber", "capsicum",
      "green chilli", "ginger", "garlic", "beans", "peas", "okra", "bhindi", "pumpkin", "gourd", "seasonal produce",
    ],
  },
  {
    name: "Grocery",
    department: "GROCERY_KIRANA",
    description: "Staples: rice, flour, pulses, oil, sugar, salt, spices and packaged foods.",
    keywords: [
      "rice", "basmati", "atta", "wheat", "wheat flour", "flour", "maida", "besan", "rava", "sooji", "suji", "poha",
      "dal", "daal", "pulses", "toor", "moong", "masoor", "chana", "rajma", "urad", "oil", "cooking oil",
      "sunflower oil", "mustard oil", "groundnut oil", "sugar", "salt", "jaggery", "gur", "spice", "spices", "masala",
      "turmeric", "haldi", "chilli powder", "jeera", "cumin", "mustard seeds", "dry fruits", "almond", "cashew",
      "raisins", "peanut butter", "jam", "honey", "ketchup", "sauce", "pickle", "papad", "vermicelli", "pasta",
      "oats", "cornflakes", "cereal", "packaged foods", "packaged food", "basic groceries", "grocery", "staples",
    ],
    brands: ["tata sampann", "fortune", "aashirvaad", "saffola", "india gate", "daawat", "everest", "mdh", "catch", "kissan"],
  },
  {
    name: "Snacks & Beverages",
    department: "CONVENIENCE_STORE",
    description: "Biscuits, chips, namkeen, chocolates, tea, coffee, juices and soft drinks.",
    keywords: [
      "biscuit", "biscuits", "milk biscuit", "chips", "namkeen", "snack", "snacks", "wafers", "chocolate", "chocolates",
      "candy", "toffee", "noodles", "instant noodles", "ready-to-eat", "ready to eat", "tea", "chai", "coffee",
      "juice", "soft drink", "soft drinks", "cola", "soda", "beverage", "beverages", "drink", "energy drink",
      "bottled water", "mineral water", "water bottle", "bhujia", "farsan", "chivda", "mixture", "popcorn", "nachos",
    ],
    brands: ["parle", "haldiram", "lays", "bingo", "kurkure", "britannia", "sunfeast", "cadbury", "nescafe", "bru",
      "red label", "tata tea", "coca cola", "pepsi", "frooti", "maggi", "bisleri", "kinley"],
    units: ["l", "ltr", "litre", "liter", "ml"],
  },
  {
    name: "Personal Care",
    department: "COSMETICS_BEAUTY",
    description: "Soap, shampoo, oral care, skin and hair care, and toiletries.",
    keywords: [
      "soap", "shampoo", "conditioner", "toothpaste", "toothbrush", "mouthwash", "face wash", "facewash",
      "face cream", "cold cream", "body lotion", "lotion", "moisturiser", "moisturizer", "sunscreen", "deodorant",
      "perfume", "talc", "talcum", "hair oil", "hair colour", "hair dye", "comb", "razor", "shaving", "sanitary pad",
      "sanitary pads", "diaper", "diapers", "toiletries", "personal care", "cosmetics", "lipstick", "kajal",
      "nail polish", "body wash", "hand wash", "handwash", "wipes",
    ],
    brands: ["colgate", "pepsodent", "dove", "lux", "lifebuoy", "pears", "himalaya", "nivea", "ponds", "dettol",
      "head and shoulders", "clinic plus", "parachute", "gillette", "whisper", "stayfree", "pampers", "vaseline"],
  },
  {
    name: "Household",
    department: "SUPERMARKET",
    description: "Cleaning products, detergents, kitchenware and home essentials.",
    keywords: [
      "detergent", "washing powder", "dishwash", "dish wash", "cleaner", "household cleaners", "cleaning products",
      "floor cleaner", "toilet cleaner", "phenyl", "bleach", "broom", "mop", "scrubber", "sponge wipe", "garbage bag",
      "kitchenware", "utensil", "utensils", "bucket", "mug", "container", "aluminium foil", "cling film", "matchbox",
      "agarbatti", "incense", "mosquito", "repellent", "air freshener", "napkin", "tissue", "tissues",
    ],
    brands: ["surf excel", "tide", "ariel", "rin", "wheel", "vim", "harpic", "lizol", "colin", "good knight",
      "all out", "odonil", "scotch-brite", "kleenex"],
  },
  {
    name: "Stationery",
    department: "STATIONERY_STORE",
    description: "Pens, pencils, notebooks, paper and office supplies.",
    keywords: [
      "pen", "pens", "pencil", "pencils", "notebook", "notebooks", "eraser", "sharpener", "stapler", "staples pin",
      "paper", "a4 paper", "file", "folder", "marker", "highlighter", "glue", "scissors", "ruler", "geometry box",
      "crayons", "sketch pens", "register", "envelope", "sticky notes", "stationery", "office supplies",
    ],
    brands: ["classmate", "reynolds", "camlin", "natraj", "apsara", "cello", "faber-castell", "doms", "fevicol"],
  },
  {
    name: "Electronics",
    department: "ELECTRONICS_STORE",
    description: "Chargers, cables, batteries, bulbs, small appliances and accessories.",
    keywords: [
      "charger", "cable", "usb", "earphone", "earphones", "headphone", "headphones", "earbuds", "speaker", "power bank",
      "battery", "batteries", "bulb", "led bulb", "led", "tube light", "extension board", "adapter", "mobile cover",
      "phone", "mobile", "smartphone", "television", "tv", "remote", "electronics", "electrical", "switch", "socket",
      "fan", "iron", "mixer", "grinder", "kettle", "torch", "memory card", "pen drive",
    ],
    brands: ["philips", "syska", "havells", "boat", "duracell", "eveready", "mi", "samsung", "jbl", "bajaj"],
  },
  {
    name: "Meat, Fish & Eggs",
    department: "MEAT_SHOP",
    description: "Fresh chicken, mutton, fish, seafood and eggs.",
    keywords: ["chicken", "mutton", "goat meat", "fish", "prawn", "prawns", "seafood", "egg", "eggs", "meat", "keema", "pomfret", "surmai"],
  },
  {
    name: "Sweets",
    department: "SWEET_SHOP",
    description: "Mithai and traditional sweets.",
    keywords: ["sweet", "sweets", "mithai", "ladoo", "laddu", "barfi", "burfi", "peda", "jalebi", "halwa", "gulab jamun", "rasgulla", "kaju katli", "modak", "chikki"],
  },
  {
    name: "Health & Pharmacy",
    department: "PHARMACY",
    description: "Medicines, health supplements and first aid.",
    keywords: ["medicine", "medicines", "tablet", "tablets", "capsule", "capsules", "syrup", "ointment", "bandage", "first aid",
      "thermometer", "sanitizer", "sanitiser", "pain relief", "vitamin", "supplement", "antiseptic", "ors", "pharmacy"],
  },
];

/**
 * Specialist shop types and the category their goods belong in. Each listed
 * shop type's standard goods (src/lib/shop-types.ts) become keywords of that
 * category, and its products get the department hint. Mixed shop types
 * (Grocery/Kirana, Supermarket, Convenience, Wholesale, Online, General
 * Trading) are deliberately absent: their goods span many categories and are
 * covered by the curated keywords above.
 */
const SHOP_TYPE_TARGETS: Partial<Record<Department, string>> = {
  DAIRY: "Dairy",
  BAKERY: "Bakery",
  FRUIT_VEGETABLE: "Fruits & Vegetables",
  MEAT_SHOP: "Meat, Fish & Eggs",
  SWEET_SHOP: "Sweets",
  PHARMACY: "Health & Pharmacy",
  MEDICAL_EQUIPMENT: "Health & Pharmacy",
  COSMETICS_BEAUTY: "Personal Care",
  STATIONERY_STORE: "Stationery",
  PRINTING_PHOTOCOPY: "Stationery",
  ELECTRONICS_STORE: "Electronics",
  MOBILE_PHONE_STORE: "Electronics",
  COMPUTER_STORE: "Electronics",
  HOME_APPLIANCE_STORE: "Electronics",
  ELECTRICAL_SHOP: "Electronics",
  MOBILE_ELECTRONICS_REPAIR: "Electronics",
  CLOTHING_STORE: "Clothing",
  FOOTWEAR_STORE: "Footwear",
  JEWELLERY_STORE: "Jewellery & Watches",
  OPTICAL_STORE: "Optical",
  FURNITURE_STORE: "Furniture",
  HARDWARE_STORE: "Hardware & Building",
  BUILDING_MATERIALS: "Hardware & Building",
  PAINT_SANITARY_STORE: "Hardware & Building",
  BOOKSTORE: "Books",
  TOY_STORE: "Toys & Games",
  SPORTS_STORE: "Sports & Fitness",
  PET_STORE: "Pet Supplies",
  AUTO_SPARE_PARTS: "Automotive",
  AUTO_ACCESSORIES: "Automotive",
  GIFT_SHOP: "Gifts & Flowers",
  FLOWER_SHOP: "Gifts & Flowers",
  AGRICULTURAL_SUPPLY: "Agriculture & Poultry",
  POULTRY_SUPPLY: "Agriculture & Poultry",
  RESTAURANT: "Ready-to-Eat Food",
  FAST_FOOD: "Ready-to-Eat Food",
  CAFE: "Ready-to-Eat Food",
  PACKAGING_MATERIALS: "Packaging",
};

/**
 * Mixed shop types whose goods lean one way: a weak hint only. Supermarket,
 * Convenience, Wholesale, Online and General Trading give no hint at all.
 */
const WEAK_DEPARTMENT_HINTS: Partial<Record<Department, string>> = {
  GROCERY_KIRANA: "Grocery",
};

/** Categories that exist only for specialist shop types (no curated keywords). */
const DERIVED_DESCRIPTIONS: Record<string, string> = {
  Clothing: "Apparel for men, women and children.",
  Footwear: "Shoes, sandals, slippers and footwear care.",
  "Jewellery & Watches": "Gold, silver and imitation jewellery, and watches.",
  Optical: "Spectacles, sunglasses, contact lenses and accessories.",
  Furniture: "Home and office furniture.",
  "Hardware & Building": "Tools, fittings, building materials, paint and sanitaryware.",
  Books: "Books and reading material.",
  "Toys & Games": "Toys, games and puzzles.",
  "Sports & Fitness": "Sports equipment, fitness gear and sportswear.",
  "Pet Supplies": "Pet food and accessories.",
  Automotive: "Vehicle spare parts and accessories.",
  "Gifts & Flowers": "Gift items, flowers and bouquets.",
  "Agriculture & Poultry": "Seeds, fertilisers, farm tools and poultry supplies.",
  "Ready-to-Eat Food": "Prepared meals, fast food and café items.",
  Packaging: "Packaging and carry materials.",
};

/** Generic words that clearly name a category, beyond the shop types' goods. */
const EXTRA_KEYWORDS: Record<string, readonly string[]> = {
  Grocery: ["groceries", "bulk groceries", "dates", "peanuts", "roasted peanuts", "tofu", "glucose"],
  "Fruits & Vegetables": ["bhendi"],
  "Health & Pharmacy": ["condoms", "condom", "protein", "protein shake", "roll-on balm", "balm", "ayurvedic"],
  "Pet Supplies": ["dog food", "cat food", "kitten", "puppy", "pet food"],
  Household: ["household items", "home goods"],
  "Personal Care": ["beauty products", "teeth", "nail enamel", "attar", "fragrance"],
  Clothing: ["garments", "apparel", "clothing", "shirt", "t-shirt", "saree", "kurta", "vest", "brief", "trunk"],
  Footwear: ["footwear", "shoe"],
  Books: ["books", "book"],
  "Hardware & Building": ["hardware"],
  Packaging: ["packaging materials", "packaging"],
};

/** Brands seen in the catalogue that clearly name a category. */
const EXTRA_BRANDS: Record<string, readonly string[]> = {
  // Only brands that are not also everyday words ("Real", "Polo", "Boost" are left out).
  "Snacks & Beverages": ["campa", "mountain dew", "horlicks", "bournvita", "paper boat", "doritos", "cheetos",
    "chupa chups", "tiggle", "sprite", "thums up", "limca", "tropicana", "lahori zeera"],
  "Personal Care": ["sensodyne", "sunsilk", "dove", "nail trend", "lakme", "garnier", "loreal", "l'oreal", "mamaearth"],
  "Pet Supplies": ["pedigree", "whiskas", "drools", "royal canin", "purepet"],
  Electronics: ["portronics", "asus", "lenovo", "logitech", "zebronics", "realme", "oneplus"],
  Clothing: ["jockey"],
  Books: ["penguin", "puffin", "harpercollins", "rupa", "wolters kluwer"],
};

function buildTargets(): TargetCategory[] {
  const curatedKeywords = new Set(CURATED.flatMap((c) => c.keywords));
  const byName = new Map<string, TargetCategory & { departments: Department[] }>(
    CURATED.map((c) => [c.name, { ...c, keywords: [...c.keywords], departments: [c.department] }]),
  );
  for (const type of SHOP_TYPES) {
    const target = SHOP_TYPE_TARGETS[type.key as Department];
    if (!target) continue;
    const entry =
      byName.get(target) ??
      { name: target, department: type.key as Department, description: DERIVED_DESCRIPTIONS[target] ?? "", keywords: [], departments: [] };
    // A shop type's goods never override a curated keyword (that would create ties).
    const goods = type.standardGoods.map((g) => g.toLowerCase().replace(/’/g, "'").trim()).filter((g) => g && !curatedKeywords.has(g));
    entry.keywords = [...new Set([...entry.keywords, ...goods])];
    if (!entry.departments.includes(type.key as Department)) entry.departments.push(type.key as Department);
    byName.set(target, entry);
  }
  for (const [name, list] of Object.entries(EXTRA_BRANDS)) {
    const entry = byName.get(name);
    if (entry) entry.brands = [...new Set([...(entry.brands ?? []), ...list])];
  }
  for (const [name, words] of Object.entries(EXTRA_KEYWORDS)) {
    const entry = byName.get(name);
    if (entry) entry.keywords = [...new Set([...entry.keywords, ...words])];
  }
  return [...byName.values()];
}

export const TARGET_CATEGORIES: readonly (TargetCategory & { departments?: Department[] })[] = buildTargets();

export interface ProductForCategorisation {
  name: string;
  description?: string | null;
  brand?: string | null;
  unit?: string | null;
  oldCategoryName?: string | null;
  oldDepartment?: string | null;
}

export interface CategorisationResult {
  category: string;
  score: number;
  runnerUp: { category: string; score: number } | null;
  /** True when the rules were sure enough; false means General by default. */
  confident: boolean;
  /** Human-readable evidence, for the report. */
  reason: string;
}

const MIN_SCORE = 3;
const MIN_LEAD = 1;

const SHOP_TYPE_LABELS = new Set(SHOP_TYPES.map((t) => t.label.toLowerCase()));

/** Every keyword of every category, longest first, compiled once. */
const KEYWORD_INDEX = TARGET_CATEGORIES.flatMap((c) =>
  c.keywords.map((k) => {
    // Keywords are normalised the same way as the text they are matched against.
    const keyword = normalise(k);
    return { category: c.name, keyword, re: new RegExp(`(^|[^a-z0-9])${escape(keyword)}(?=$|[^a-z0-9])`, "g") };
  }),
).sort((a, b) => b.keyword.length - a.keyword.length);

function escape(text: string): string {
  return text.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalise(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/’/g, "'").replace(/&/g, " and ").replace(/\s+/g, " ").trim();
}

/** Keyword hits in `text`, longest first, without reusing a matched span. Ordered by position. */
export function matchKeywords(text: string): { category: string; keyword: string; index: number }[] {
  const source = normalise(text);
  const used: boolean[] = new Array(source.length).fill(false);
  const hits: { category: string; keyword: string; index: number }[] = [];
  for (const entry of KEYWORD_INDEX) {
    entry.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entry.re.exec(source))) {
      const start = m.index + m[1].length;
      const end = start + entry.keyword.length;
      if (used.slice(start, end).some(Boolean)) continue;
      for (let i = start; i < end; i += 1) used[i] = true;
      hits.push({ category: entry.category, keyword: entry.keyword, index: start });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * An old category name without the " (Department)" / " (Department) 1a2b"
 * suffix migration 0038 added to make names unique — the suffix is not
 * evidence of what the product is.
 */
export function cleanCategoryName(name: string): string {
  return name.replace(/\s\([^)]*\)( [0-9a-f]{4})?$/i, "").trim();
}

/** True when an old category name is only a shop-type label (no product meaning). */
export function isShopTypeLabel(name: string | null | undefined): boolean {
  return SHOP_TYPE_LABELS.has(normalise(name));
}

export function categoriseProduct(product: ProductForCategorisation): CategorisationResult {
  const scores = new Map<string, number>();
  const evidence = new Map<string, string[]>();
  const add = (category: string, points: number, why: string) => {
    scores.set(category, (scores.get(category) ?? 0) + points);
    evidence.set(category, [...(evidence.get(category) ?? []), why]);
  };

  const nameHits = matchKeywords(product.name);
  nameHits.forEach((hit, i) => add(hit.category, i === nameHits.length - 1 ? 4 : 3, `name "${hit.keyword}"`));

  const seenDescription = new Set<string>();
  for (const hit of matchKeywords(product.description ?? "")) {
    const key = `${hit.category}:${hit.keyword}`;
    if (seenDescription.has(key)) continue;
    seenDescription.add(key);
    add(hit.category, 1, `description "${hit.keyword}"`);
  }

  const oldCategory = product.oldCategoryName ? cleanCategoryName(product.oldCategoryName) : "";
  if (oldCategory && !isShopTypeLabel(oldCategory)) {
    for (const hit of matchKeywords(oldCategory)) add(hit.category, 2, `old category "${product.oldCategoryName}"`);
  }

  // A known brand, from the brand field or named in the product name ("Parle-G").
  const brand = normalise(product.brand);
  const name = normalise(product.name);
  for (const c of TARGET_CATEGORIES) {
    const hit = c.brands?.find(
      (b) => brand === b || brand.startsWith(`${b} `) || new RegExp(`(^|[^a-z0-9])${escape(b)}(?=$|[^a-z0-9])`).test(name),
    );
    if (hit) add(c.name, 3, `brand "${hit}"`);
  }

  if (product.oldDepartment) {
    const specialist = SHOP_TYPE_TARGETS[product.oldDepartment as Department];
    const weak = WEAK_DEPARTMENT_HINTS[product.oldDepartment as Department];
    if (specialist) add(specialist, 3, `filed under shop type ${product.oldDepartment}`);
    else if (weak) add(weak, 1, `department ${product.oldDepartment}`);
  }

  const unit = normalise(product.unit).replace(/[^a-z]/g, "");
  if (unit) {
    for (const c of TARGET_CATEGORIES) {
      if (c.units?.includes(unit) && scores.has(c.name)) add(c.name, 0.5, `unit "${product.unit}"`);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [best, second] = ranked;
  const runnerUp = second ? { category: second[0], score: second[1] } : null;
  if (!best) {
    return { category: GENERAL, score: 0, runnerUp: null, confident: false, reason: "no keyword, brand or department matched" };
  }
  const lead = best[1] - (second?.[1] ?? 0);
  if (best[1] < MIN_SCORE || lead < MIN_LEAD) {
    return {
      category: GENERAL,
      score: best[1],
      runnerUp: { category: best[0], score: best[1] },
      confident: false,
      reason:
        best[1] < MIN_SCORE
          ? `too little evidence (best: ${best[0]} ${best[1]} — ${evidence.get(best[0])!.join(", ")})`
          : `ambiguous: ${best[0]} ${best[1]} vs ${second![0]} ${second![1]}`,
    };
  }
  return { category: best[0], score: best[1], runnerUp, confident: true, reason: evidence.get(best[0])!.join(", ") };
}

export function targetFor(name: string): TargetCategory | undefined {
  return TARGET_CATEGORIES.find((c) => c.name.toLowerCase() === name.toLowerCase());
}
