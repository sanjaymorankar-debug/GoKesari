/**
 * The Gokesari standard category taxonomy (CATEGORY_MASTER), five levels deep.
 *
 * Authored as an indented outline: two spaces per level, an optional [DEPARTMENT]
 * tag on a top-level line naming the closest GoKesari shop type (informational -
 * it guides promotion into the live catalogue, it is not a foreign key).
 *
 *   Grocery [GROCERY_KIRANA]
 *     Staples
 *       Rice
 *         Basmati Rice
 *           Premium Basmati Rice
 *
 * Every source's own categories are mapped onto these nodes (pmd.category_mapping);
 * products always carry the *standard* category, never a source's.
 */

export interface CategoryRow {
  /** Slug path: grocery/staples/rice/basmati-rice/premium-basmati-rice */
  code: string;
  parentCode: string | null;
  level: 1 | 2 | 3 | 4 | 5;
  name: string;
  slug: string;
  pathNames: string[];
  department: string | null;
  sortOrder: number;
}

export const TAXONOMY_OUTLINE = `
Grocery [GROCERY_KIRANA]
  Staples
    Rice
      Basmati Rice
        Premium Basmati Rice
        Regular Basmati Rice
      Non-Basmati Rice
      Poha & Rice Flakes
    Flours & Grains
      Wheat Flour (Atta)
      Maida & Sooji
      Besan & Other Flours
      Millets & Grains
    Pulses & Lentils
      Toor Dal
      Moong Dal
      Chana & Chickpeas
      Urad Dal
      Masoor Dal
      Rajma & Beans
    Edible Oils
      Sunflower Oil
      Mustard Oil
      Groundnut Oil
      Olive Oil
      Coconut Oil
      Blended & Other Oils
    Sugar, Jaggery & Salt
      Sugar
      Jaggery
      Salt
    Spices & Masalas
      Whole Spices
      Powdered Spices
      Blended Masalas
    Dry Fruits & Nuts
      Almonds
      Cashews
      Raisins
      Dates
      Walnuts & Others
  Fresh Produce
    Fruits
    Vegetables
    Herbs & Leafy Greens
Food [SUPERMARKET]
  Snacks
    Chips & Crisps
    Namkeen & Bhujia
    Popcorn & Puffs
    Nuts & Trail Mixes
  Biscuits & Cookies
    Cream Biscuits
    Glucose & Marie Biscuits
    Cookies
    Rusks & Cakes
  Confectionery
    Chocolates
    Candies & Toffees
    Chewing Gum
  Sweets & Mithai
    Indian Sweets
    Dry Fruit Sweets
  Breakfast & Cereals
    Cornflakes & Muesli
    Oats
    Instant Porridge
  Instant & Ready-to-Eat
    Noodles
    Pasta & Macaroni
    Soups
    Ready Meals
  Sauces, Spreads & Condiments
    Ketchup & Sauces
    Mayonnaise & Dressings
    Jams & Spreads
    Peanut Butter
    Pickles & Chutneys
    Vinegar
  Bakery
    Bread
    Buns & Pav
    Cakes & Pastries
  Frozen Foods
    Frozen Snacks
    Frozen Vegetables
    Frozen Meat & Seafood
  Eggs, Meat & Seafood
    Eggs
    Meat
    Fish & Seafood
Beverages [SUPERMARKET]
  Tea
    Black Tea
    Green Tea
    Herbal & Flavoured Tea
  Coffee
    Instant Coffee
    Ground Coffee
  Soft Drinks
    Cola
    Lemon & Lime
    Orange & Fruit Flavours
    Soda & Mixers
  Juices
    Fruit Juices
    Coconut Water
    Vegetable Juices
  Water
    Packaged Drinking Water
    Mineral Water
    Sparkling Water
  Energy & Health Drinks
    Malt & Health Drinks
    Energy Drinks
    Protein & Sports Drinks
  Squash & Syrups
Dairy [DAIRY]
  Milk
    Toned Milk
    Full Cream Milk
    Double Toned Milk
    Skimmed Milk
    Flavoured Milk
    UHT & Long-Life Milk
  Curd & Yogurt
    Curd
    Greek Yogurt
    Flavoured Yogurt
    Lassi & Buttermilk
  Butter & Margarine
  Cheese
    Processed Cheese
    Mozzarella & Pizza Cheese
    Cheese Spreads
  Paneer & Tofu
  Ghee
  Cream & Whipped Toppings
  Ice Cream & Frozen Desserts
  Milk Powder & Condensed Milk
Health & Wellness [PHARMACY]
  Vitamins & Supplements
  Protein & Nutrition
  Ayurvedic & Herbal
Electronics [ELECTRONICS_STORE]
  TVs & Audio
    Televisions
      Smart TVs
      LED TVs
    Speakers & Soundbars
    Headphones & Earphones
  Cameras
    Digital Cameras
    Action Cameras
    Security Cameras
  Wearables
    Smartwatches
    Fitness Bands
  Power & Accessories
    Chargers & Adapters
    Cables
    Power Banks
    Batteries
  Gaming
    Consoles
    Controllers
  Mobiles [MOBILE_PHONE_STORE]
    Smartphones
      Android Phones
      iPhones
    Feature Phones
    Tablets
    Mobile Accessories
      Cases & Covers
      Screen Protectors
      Mobile Chargers
      Mobile Cables
      Earbuds
  Computers [COMPUTER_STORE]
    Laptops
      Gaming Laptops
        15-inch Gaming Laptop
        17-inch Gaming Laptop
      Business Laptops
      Student Laptops
      2-in-1 Laptops
    Desktops
      All-in-One PCs
      Tower PCs
      Mini PCs
    Monitors
    Printers & Scanners
      Inkjet Printers
      Laser Printers
      Ink & Toner
    Peripherals
      Keyboards
      Mice
      Webcams
      Headsets
    Storage
      Pen Drives
      External Hard Drives
      SSDs
      Memory Cards
    Networking
      Routers & Modems
      Switches
      Wi-Fi Extenders
    Components
      RAM
      Graphics Cards
      Processors
      Motherboards
Apparel [CLOTHING_STORE]
  Men
    Topwear
      T-Shirts
      Shirts
      Sweatshirts & Hoodies
    Bottomwear
      Jeans
      Trousers
      Shorts
    Ethnic Wear
  Women
    Ethnic Wear
      Sarees
      Kurtas & Kurtis
      Salwar Suits
    Western Wear
      Dresses
      Tops
      Jeans & Jeggings
    Innerwear & Loungewear
  Kids
    Boys
    Girls
    Infants
  Footwear
    Men's Footwear
    Women's Footwear
    Kids' Footwear
    Sports Shoes
    Sandals & Slippers
  Fashion Accessories
    Bags & Wallets
    Belts
    Caps & Hats
Home & Kitchen [HOME_APPLIANCE_STORE]
  Kitchenware
    Cookware
    Storage & Containers
    Dinnerware
    Bakeware
    Kitchen Tools & Gadgets
  Kitchen Appliances
    Mixer Grinders
    Pressure Cookers
    Induction Cooktops
    Electric Kettles
    Microwave Ovens
  Home Appliances
    Refrigerators
    Washing Machines
    Air Conditioners
    Water Purifiers
    Fans
    Vacuum Cleaners
  Cleaning & Household
    Laundry Detergents
    Dishwash
    Floor & Surface Cleaners
    Toilet Cleaners
    Air Fresheners
    Tissues & Paper Products
    Pest Control
    Garbage Bags
  Furniture
  Home Furnishing
    Bedsheets
    Curtains
    Towels
    Mattresses
  Home Decor & Lighting
Beauty [COSMETICS_BEAUTY]
  Makeup
    Face Makeup
    Eye Makeup
    Lip Makeup
    Nail Care
  Skincare
    Moisturisers & Creams
    Face Wash & Cleansers
    Sunscreen
    Serums & Treatments
    Face Masks
  Fragrances
    Perfumes
    Body Mists
Personal Care [COSMETICS_BEAUTY]
  Bath & Body
    Soaps
    Body Wash
    Body Lotions
    Talcum Powder
  Hair Care
    Shampoo
    Conditioner
    Hair Oil
    Hair Colour
    Hair Styling
  Oral Care
    Toothpaste
    Toothbrushes
    Mouthwash
  Men's Grooming
    Shaving
    Beard Care
  Deodorants
  Feminine Hygiene
  Baby Care
    Diapers
    Baby Skincare
    Baby Wipes
  Hand Wash & Sanitisers
Stationery [STATIONERY_STORE]
  Writing Instruments
    Pens
    Pencils
    Markers & Highlighters
    Erasers & Sharpeners
  Paper Products
    Notebooks
    Diaries & Planners
    Sticky Notes
    Printer Paper
  Office Supplies
    Files & Folders
    Staplers & Punches
    Adhesives & Tapes
    Calculators
  Art & Craft
    Colours & Paints
    Craft Supplies
  School Supplies
Toys [TOY_STORE]
  Games & Puzzles
    Board Games
    Puzzles
    Card Games
  Dolls & Playsets
  Action Figures & Vehicles
    Die-cast & Toy Cars
    Remote Control Toys
  Educational Toys
  Soft Toys
  Building Blocks
  Outdoor & Sports Toys
Automotive [AUTO_ACCESSORIES]
  Car Accessories
    Seat Covers
    Floor Mats
    Dash Cameras
    Car Air Fresheners
  Bike Accessories
    Helmets
    Riding Gear
  Lubricants & Fluids
    Engine Oil
    Coolants
    Brake Fluids
  Batteries & Electricals
  Tyres & Wheels
  Car Care
    Cleaners & Polish
    Wax & Coatings
  Spare Parts
    Filters
    Brake Parts
    Bulbs & Lights
Tools [HARDWARE_STORE]
  Hand Tools
    Screwdrivers
    Spanners & Wrenches
    Pliers
    Hammers
  Power Tools
    Drills
    Grinders
    Saws
  Measuring & Layout
  Fasteners & Hardware
    Screws & Bolts
    Locks & Hinges
  Safety & Workwear
  Garden Tools
Pet Supplies [PET_STORE]
  Pet Food
    Dog Food
    Cat Food
    Fish & Bird Food
  Pet Accessories
Books [BOOKSTORE]
  Fiction
  Non-Fiction
  Academic & Reference
  Children's Books
Uncategorised
  Unmapped
`.trim();

export const UNCATEGORISED_CODE = "uncategorised/unmapped";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parses the outline into flat rows, parents before children. Throws on malformed indentation. */
export function parseTaxonomy(outline: string = TAXONOMY_OUTLINE): CategoryRow[] {
  const rows: CategoryRow[] = [];
  const stack: CategoryRow[] = [];
  const seen = new Set<string>();
  let order = 0;

  for (const rawLine of outline.split("\n")) {
    if (!rawLine.trim()) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent % 2 !== 0) throw new Error(`taxonomy: odd indentation on "${rawLine}"`);
    const depth = indent / 2;
    if (depth > 4) throw new Error(`taxonomy: more than 5 levels at "${rawLine.trim()}"`);
    if (depth > stack.length) throw new Error(`taxonomy: skipped a level at "${rawLine.trim()}"`);

    let text = rawLine.trim();
    let department: string | null = null;
    const tag = text.match(/^(.*?)\s*\[([A-Z_]+)\]$/);
    if (tag) {
      text = tag[1];
      department = tag[2];
    }

    stack.length = depth;
    const parent = stack[depth - 1] ?? null;
    const slug = slugify(text);
    const code = parent ? `${parent.code}/${slug}` : slug;
    if (seen.has(code)) throw new Error(`taxonomy: duplicate category ${code}`);
    seen.add(code);

    const row: CategoryRow = {
      code,
      parentCode: parent?.code ?? null,
      level: (depth + 1) as CategoryRow["level"],
      name: text,
      slug,
      pathNames: [...(parent?.pathNames ?? []), text],
      // Children inherit the department of their top-level ancestor.
      department: department ?? parent?.department ?? null,
      sortOrder: order++,
    };
    rows.push(row);
    stack.push(row);
  }
  return rows;
}

let cached: CategoryRow[] | null = null;
export function getTaxonomy(): CategoryRow[] {
  return (cached ??= parseTaxonomy());
}

const byCode = () => new Map(getTaxonomy().map((r) => [r.code, r]));
let codeIndex: Map<string, CategoryRow> | null = null;

export function getCategoryByCode(code: string): CategoryRow | undefined {
  return (codeIndex ??= byCode()).get(code);
}
