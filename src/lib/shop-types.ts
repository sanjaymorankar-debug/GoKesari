/**
 * Canonical list of shop types this marketplace supports, and the standard
 * goods / product categories typically sold by each (requirement: shop
 * directory catalogue). This is the single source of truth — the database
 * enum (schema.ts), the shop registration form, shop cards, category
 * browsing pages and the catalogue seed script all derive from this file.
 *
 * Pure data, no server-only imports — safe to use from both client and
 * server code.
 */

export interface ShopTypeDefinition {
  /** Stable DB enum key. Never rename once shops exist with this value. */
  key: string;
  /** Human-readable label shown in the UI. */
  label: string;
  /** Typical goods / product categories a shop of this type sells. */
  standardGoods: readonly string[];
}

export const SHOP_TYPES = [
  {
    key: "GROCERY_KIRANA",
    label: "Grocery / Kirana Store",
    standardGoods: ["Rice", "wheat flour", "pulses", "cooking oil", "sugar", "salt", "spices", "tea", "coffee", "biscuits", "snacks", "packaged foods", "bottled water", "household cleaners"],
  },
  {
    key: "SUPERMARKET",
    label: "Supermarket",
    standardGoods: ["Fresh produce", "dairy", "meat", "bakery items", "packaged foods", "beverages", "personal care", "cleaning products", "kitchenware", "stationery"],
  },
  {
    key: "CONVENIENCE_STORE",
    label: "Convenience Store",
    standardGoods: ["Milk", "bread", "eggs", "snacks", "soft drinks", "ready-to-eat meals", "tobacco products", "toiletries", "batteries", "basic groceries"],
  },
  {
    key: "FRUIT_VEGETABLE",
    label: "Fruit and Vegetable Shop",
    standardGoods: ["Fruits", "vegetables", "leafy greens", "herbs", "sprouts", "potatoes", "onions", "tomatoes", "seasonal produce"],
  },
  {
    key: "DAIRY",
    label: "Dairy Shop",
    standardGoods: ["Milk", "curd", "yogurt", "paneer", "butter", "cheese", "ghee", "flavored milk", "lassi", "ice cream"],
  },
  {
    key: "BAKERY",
    label: "Bakery",
    standardGoods: ["Bread", "buns", "cakes", "pastries", "cookies", "rusks", "muffins", "sandwiches", "pizzas", "pies"],
  },
  {
    key: "MEAT_SHOP",
    label: "Meat Shop",
    standardGoods: ["Chicken", "mutton", "beef where legally permitted", "fish", "seafood", "eggs", "sausages", "marinated meat"],
  },
  {
    key: "SWEET_SHOP",
    label: "Sweet Shop",
    standardGoods: ["Indian sweets", "mithai", "chocolates", "dry-fruit sweets", "namkeen", "snacks", "gift boxes"],
  },
  {
    key: "PHARMACY",
    label: "Pharmacy / Medical Store",
    standardGoods: ["Prescription medicines", "OTC medicines", "vitamins", "first-aid supplies", "medical devices", "personal care", "baby care"],
  },
  {
    key: "OPTICAL_STORE",
    label: "Optical Store",
    standardGoods: ["Eyeglasses", "sunglasses", "contact lenses", "frames", "lens solutions", "cases", "cleaning cloths"],
  },
  {
    key: "CLOTHING_STORE",
    label: "Clothing Store",
    standardGoods: ["Shirts", "trousers", "jeans", "sarees", "kurtas", "dresses", "innerwear", "children’s wear", "seasonal apparel"],
  },
  {
    key: "FOOTWEAR_STORE",
    label: "Footwear Store",
    standardGoods: ["Shoes", "sandals", "slippers", "boots", "sports footwear", "socks", "shoe care products"],
  },
  {
    key: "JEWELLERY_STORE",
    label: "Jewellery Store",
    standardGoods: ["Gold jewellery", "silver jewellery", "diamond jewellery", "gemstones", "watches", "imitation jewellery"],
  },
  {
    key: "COSMETICS_BEAUTY",
    label: "Cosmetics and Beauty Store",
    standardGoods: ["Makeup", "skincare", "haircare", "perfumes", "deodorants", "grooming tools", "beauty accessories"],
  },
  {
    key: "MOBILE_PHONE_STORE",
    label: "Mobile Phone Store",
    standardGoods: ["Smartphones", "feature phones", "tablets", "chargers", "cables", "power banks", "cases", "screen protectors"],
  },
  {
    key: "ELECTRONICS_STORE",
    label: "Electronics Store",
    standardGoods: ["Televisions", "audio systems", "cameras", "headphones", "appliances", "batteries", "cables", "smart devices"],
  },
  {
    key: "COMPUTER_STORE",
    label: "Computer Store",
    standardGoods: ["Laptops", "desktops", "monitors", "printers", "keyboards", "mice", "storage drives", "networking equipment", "software"],
  },
  {
    key: "FURNITURE_STORE",
    label: "Furniture Store",
    standardGoods: ["Beds", "sofas", "tables", "chairs", "wardrobes", "cabinets", "mattresses", "office furniture", "home décor"],
  },
  {
    key: "HOME_APPLIANCE_STORE",
    label: "Home Appliance Store",
    standardGoods: ["Refrigerators", "washing machines", "air conditioners", "microwave ovens", "mixers", "vacuum cleaners", "water purifiers"],
  },
  {
    key: "HARDWARE_STORE",
    label: "Hardware Store",
    standardGoods: ["Tools", "fasteners", "locks", "hinges", "pipes", "fittings", "adhesives", "electrical accessories", "safety equipment"],
  },
  {
    key: "PAINT_SANITARY_STORE",
    label: "Paint and Sanitary Store",
    standardGoods: ["Interior paint", "exterior paint", "primers", "putty", "tiles", "bathroom fixtures", "faucets", "plumbing supplies"],
  },
  {
    key: "STATIONERY_STORE",
    label: "Stationery Store",
    standardGoods: ["Notebooks", "pens", "pencils", "files", "folders", "art supplies", "school bags", "office supplies", "printer paper"],
  },
  {
    key: "BOOKSTORE",
    label: "Bookstore",
    standardGoods: ["Textbooks", "reference books", "fiction", "non-fiction", "magazines", "newspapers", "educational materials"],
  },
  {
    key: "TOY_STORE",
    label: "Toy Store",
    standardGoods: ["Board games", "dolls", "puzzles", "remote-control toys", "educational toys", "outdoor toys", "baby toys"],
  },
  {
    key: "SPORTS_STORE",
    label: "Sports Store",
    standardGoods: ["Cricket equipment", "footballs", "badminton gear", "gym equipment", "sportswear", "shoes", "fitness accessories"],
  },
  {
    key: "PET_STORE",
    label: "Pet Store",
    standardGoods: ["Pet food", "treats", "cages", "leashes", "collars", "grooming products", "bedding", "toys", "aquariums"],
  },
  {
    key: "AUTO_SPARE_PARTS",
    label: "Automobile Spare Parts Shop",
    standardGoods: ["Filters", "batteries", "tyres", "lubricants", "brake parts", "lights", "belts", "wipers", "accessories"],
  },
  {
    key: "AUTO_ACCESSORIES",
    label: "Auto Accessories Shop",
    standardGoods: ["Seat covers", "floor mats", "car audio", "dash cameras", "chargers", "air fresheners", "cleaning products"],
  },
  {
    key: "MOBILE_ELECTRONICS_REPAIR",
    label: "Mobile and Electronics Repair Shop",
    standardGoods: ["Replacement screens", "batteries", "connectors", "chargers", "repair tools", "accessories"],
  },
  {
    key: "GIFT_SHOP",
    label: "Gift Shop",
    standardGoods: ["Greeting cards", "gifts", "flowers", "photo frames", "mugs", "souvenirs", "wrapping materials", "novelty items"],
  },
  {
    key: "FLOWER_SHOP",
    label: "Flower Shop",
    standardGoods: ["Cut flowers", "bouquets", "garlands", "plants", "pots", "floral arrangements", "ribbons", "decorative items"],
  },
  {
    key: "BUILDING_MATERIALS",
    label: "Hardware and Building Materials",
    standardGoods: ["Cement", "steel", "bricks", "sand", "aggregates", "blocks", "pipes", "roofing materials", "construction chemicals"],
  },
  {
    key: "ELECTRICAL_SHOP",
    label: "Electrical Shop",
    standardGoods: ["Wires", "cables", "switches", "sockets", "lights", "fans", "circuit breakers", "conduits", "inverters"],
  },
  {
    key: "AGRICULTURAL_SUPPLY",
    label: "Agricultural Supply Store",
    standardGoods: ["Seeds", "fertilizers", "pesticides", "farm tools", "irrigation equipment", "animal feed", "sprayers"],
  },
  {
    key: "POULTRY_SUPPLY",
    label: "Poultry Supply Store",
    standardGoods: ["Poultry feed", "chicks", "feeders", "drinkers", "cages", "vaccines", "supplements", "litter material", "farm equipment"],
  },
  {
    key: "RESTAURANT",
    label: "Restaurant",
    standardGoods: ["Prepared meals", "snacks", "beverages", "desserts", "takeaway food", "catering packages"],
  },
  {
    key: "FAST_FOOD",
    label: "Fast-Food Outlet",
    standardGoods: ["Burgers", "pizzas", "sandwiches", "fried chicken", "wraps", "fries", "soft drinks", "desserts"],
  },
  {
    key: "CAFE",
    label: "Café / Coffee Shop",
    standardGoods: ["Coffee", "tea", "cold beverages", "pastries", "sandwiches", "desserts", "light meals"],
  },
  {
    key: "MEDICAL_EQUIPMENT",
    label: "Medical Equipment Store",
    standardGoods: ["Wheelchairs", "hospital beds", "oxygen equipment", "BP monitors", "glucometers", "surgical supplies"],
  },
  {
    key: "PRINTING_PHOTOCOPY",
    label: "Printing and Photocopy Shop",
    standardGoods: ["Photocopies", "printouts", "scanning", "lamination", "binding", "business cards", "banners", "stationery"],
  },
  {
    key: "GENERAL_TRADING",
    label: "General Trading Store",
    standardGoods: ["Mixed consumer goods", "industrial supplies", "packaging materials", "office supplies", "household items"],
  },
  {
    key: "PACKAGING_MATERIALS",
    label: "Packaging Materials Shop",
    standardGoods: ["Cartons", "corrugated boxes", "bags", "stretch film", "tapes", "labels", "strapping", "bubble wrap", "pallets"],
  },
  {
    key: "WHOLESALE_STORE",
    label: "Wholesale Store",
    standardGoods: ["Bulk groceries", "beverages", "garments", "hardware", "packaging materials", "industrial and commercial supplies"],
  },
  {
    key: "ONLINE_STORE",
    label: "Online Store / E-commerce",
    standardGoods: ["Apparel", "electronics", "groceries", "home goods", "beauty products", "books", "toys", "accessories"],
  },
  /*
   * Professional practices and offices (owner request, 26 Oct 2026). They offer
   * services, not goods: the registration form hides delivery for them
   * (isProfessionalShopType). The specialities — CA, advocate, dentist, … —
   * are shop categories (admin-editable, grouped in the picker), seeded by
   * drizzle/0098_professional_registration.sql.
   */
  {
    key: "PROFESSIONAL_OFFICE",
    label: "Professional office — CA, CS, advocate, tax consultant",
    standardGoods: ["Accounting", "audit", "tax filing", "GST returns", "company law", "legal advice", "notary services"],
  },
  {
    key: "DOCTOR_CLINIC",
    label: "Doctor / clinic",
    standardGoods: ["Consultation", "diagnosis", "treatment", "dental care", "physiotherapy", "diagnostic tests"],
  },
  {
    key: "CONSULTING_SERVICES",
    label: "Consultancy and other services",
    standardGoods: ["Management consulting", "IT services", "recruitment", "coaching", "architecture", "interior design", "insurance", "financial advice"],
  },
] as const satisfies readonly ShopTypeDefinition[];

export type ShopTypeKey = (typeof SHOP_TYPES)[number]["key"];

/** Enum values for Drizzle's pgEnum — keep in sync with SHOP_TYPES above. */
export const SHOP_TYPE_KEYS = SHOP_TYPES.map((t) => t.key) as [
  ShopTypeKey,
  ...ShopTypeKey[],
];

export const SHOP_TYPE_LABELS: Record<ShopTypeKey, string> = Object.fromEntries(
  SHOP_TYPES.map((t) => [t.key, t.label]),
) as Record<ShopTypeKey, string>;

export function shopTypeLabel(key: string): string {
  return SHOP_TYPE_LABELS[key as ShopTypeKey] ?? key;
}

export function standardGoodsFor(key: string): readonly string[] {
  return SHOP_TYPES.find((t) => t.key === key)?.standardGoods ?? [];
}

/**
 * Shop types that manufacture, process, or sell food to consumers — these
 * require an FSSAI licence/registration under the Food Safety and Standards
 * Act 2006 (Part 58 compliance). Not every shop type is food-related
 * (e.g. PHARMACY sells drugs, not food), so this is a deliberate allowlist
 * rather than "everything except a few exclusions" — new shop types default
 * to NOT requiring FSSAI fields until explicitly added here.
 */
export const FOOD_SHOP_TYPE_KEYS: readonly ShopTypeKey[] = [
  "GROCERY_KIRANA",
  "SUPERMARKET",
  "CONVENIENCE_STORE",
  "FRUIT_VEGETABLE",
  "DAIRY",
  "BAKERY",
  "MEAT_SHOP",
  "SWEET_SHOP",
  "POULTRY_SUPPLY",
  "RESTAURANT",
  "FAST_FOOD",
  "CAFE",
];

/** Practices and offices that offer services rather than goods — no delivery, "practice" wording. */
export const PROFESSIONAL_SHOP_TYPE_KEYS: readonly ShopTypeKey[] = [
  "PROFESSIONAL_OFFICE",
  "DOCTOR_CLINIC",
  "CONSULTING_SERVICES",
];

export function isProfessionalShopType(key: string): boolean {
  return (PROFESSIONAL_SHOP_TYPE_KEYS as readonly string[]).includes(key);
}

export function isFoodBusinessShopType(key: string): boolean {
  return (FOOD_SHOP_TYPE_KEYS as readonly string[]).includes(key);
}
