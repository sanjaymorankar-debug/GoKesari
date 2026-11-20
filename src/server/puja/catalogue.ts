/**
 * Expands the Puja Samagri catalogue (catalogue-data.ts) into one row per SKU — the
 * shape the seed SQL, the CSV / Excel file and the tests use. Pure, no database.
 */
import {
  PUJA_BASES,
  PUJA_CATEGORIES,
  PUJA_SHOP_TYPE_KEY,
  PUJA_TYPES,
  type PujaBase,
  type PujaCategoryDef,
  type PujaTypeDef,
  type PujaUnit,
} from "./catalogue-data";

export { PUJA_CATEGORIES, PUJA_FESTIVALS, PUJA_SHOP_TYPE_KEY, PUJA_TYPES } from "./catalogue-data";

export interface PujaSku {
  /** Stable key: the products.slug the seed writes and later runs match on. */
  slug: string;
  categoryNo: number;
  categorySlug: string;
  categoryEn: string;
  typeKey: string;
  typeSlug: string;
  typeEn: string;
  nameEn: string;
  nameHi: string;
  nameMr: string;
  baseEn: string;
  variant: string;
  synonyms: string[];
  /** The unit as the brief states it (pcs, pack, box, dozen, g, kg, ml, L). */
  sellUnit: PujaUnit;
  /** products.unit (the catalogue's display unit; "pcs" is stored as "piece" like the rest of the site). */
  unit: string;
  netQuantity: number | null;
  netQuantityUnit: string | null;
  mrpPaise: number | null;
  loose: boolean;
  perishable: boolean;
  edible: boolean;
  hsnCode: string;
  gstRateBp: number;
  festivals: string[];
  variantAttrs: Record<string, string>;
  brand: string | null;
  /** Lower-cased names and synonyms, for one ILIKE / trigram match (product_local_names.search_text). */
  searchText: string;
  imageUrl: string;
  description: string;
}

const UNIT_TO_PRODUCT_UNIT: Record<PujaUnit, string> = {
  pcs: "piece",
  pack: "pack",
  box: "box",
  dozen: "dozen",
  g: "g",
  kg: "kg",
  ml: "ml",
  L: "L",
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export const pujaTypeSlug = (key: string) => `puja-type-${key}`;
export const pujaCategoryImage = (slug: string) => `/images/puja/${slug}.svg`;

/* Variant labels are short English phrases ("Pack of 12", "Loose, per kg"); the common words
 * are put into Hindi and Marathi so the local-language name reads naturally. Numbers and
 * units (g, kg, ml, L, inch) stay as printed on packs. */
const VARIANT_WORDS: ReadonlyArray<[RegExp, string, string]> = [
  [/\bThali kit\b/g, "थाली किट", "ताट किट"],
  [/\bPocket size\b/g, "पॉकेट साइज़", "पॉकेट आकार"],
  [/\bLarge print\b/g, "बड़े अक्षर", "मोठी अक्षरे"],
  [/\bwith meaning\b/g, "अर्थ सहित", "अर्थासह"],
  [/\bdouble round\b/g, "दो फेरे", "दोन फेरे"],
  [/\bsingle round\b/g, "एक फेरा", "एक फेरा"],
  [/\bjap mala\b/g, "जप माला", "जपमाळ"],
  [/\bwith lock\b/g, "ताले सहित", "कुलूपासह"],
  [/\bwith handle\b/gi, "हैंडल सहित", "हँडलसह"],
  [/\bGota-patti design\b/g, "गोटा-पट्टी डिज़ाइन", "गोटा-पट्टी डिझाइन"],
  [/\bZipper pack\b/g, "ज़िपर पैक", "झिपर पॅक"],
  [/\bPack of\b/g, "पैक –", "पॅक –"],
  [/\bBox of\b/g, "डिब्बा –", "बॉक्स –"],
  [/\bSet of\b/g, "सेट –", "संच –"],
  [/\bBundle of\b/g, "बंडल –", "गठ्ठा –"],
  [/\bLoose\b/g, "खुला", "सुटे"],
  [/\bper kg\b/g, "प्रति किलो", "प्रति किलो"],
  [/\bper 100 g\b/g, "प्रति 100 ग्राम", "प्रति 100 ग्रॅम"],
  [/\bper piece\b/g, "प्रति नग", "प्रति नग"],
  [/\bper dozen\b/g, "प्रति दर्जन", "प्रति डझन"],
  [/\bper bunch\b/g, "प्रति गुच्छा", "प्रति जुडी"],
  [/\bper gajra\b/g, "प्रति गजरा", "प्रति गजरा"],
  [/\bper\b/g, "प्रति", "प्रति"],
  [/\bSize No\./g, "साइज़ नं.", "साईझ क्र."],
  [/\bSize\b/g, "साइज़", "साईझ"],
  [/\bBox\b/g, "डिब्बा", "बॉक्स"],
  [/\bPack\b/g, "पैक", "पॅक"],
  [/\bSet\b/g, "सेट", "संच"],
  [/\bBundle\b/g, "बंडल", "गठ्ठा"],
  [/\bKit\b/g, "किट", "किट"],
  [/\bsticks\b/g, "स्टिक", "काड्या"],
  [/\bcones\b/g, "कोन", "कोन"],
  [/\bcups\b/g, "कप", "कप"],
  [/\btikki\b/g, "टिक्की", "टिकल्या"],
  [/\btablets\b/g, "टिकिया", "वड्या"],
  [/\bboxes\b/g, "डिब्बे", "बॉक्स"],
  [/\bpieces\b/g, "पीस", "नग"],
  [/\bpcs\b/g, "पीस", "नग"],
  [/\brolls\b/g, "रोल", "रोल"],
  [/\broll\b/g, "रोल", "रोल"],
  [/\bwicks\b/g, "बत्ती", "वाती"],
  [/\bbeads\b/g, "मनके", "मणी"],
  [/\bbead\b/g, "मनका", "मणी"],
  [/\bleaves\b/g, "पत्ते", "पाने"],
  [/\bflowers\b/g, "फूल", "फुले"],
  [/\bblades\b/g, "तिनके", "काड्या"],
  [/\bjar\b/g, "जार", "जार"],
  [/\btin\b/g, "टिन", "डबा"],
  [/\bdozen\b/g, "दर्जन", "डझन"],
  [/\bmodak\b/g, "मोदक", "मोदक"],
  [/\bSmall\b/g, "छोटा", "लहान"],
  [/\bsmall\b/g, "छोटे", "लहान"],
  [/\bMedium\b/g, "मध्यम", "मध्यम"],
  [/\bmedium\b/g, "मध्यम", "मध्यम"],
  [/\bLarge\b/g, "बड़ा", "मोठा"],
  [/\bBig\b/g, "बड़ा", "मोठा"],
  [/\bSingle\b/g, "एक", "एक"],
  [/\bsingle\b/g, "एक", "एक"],
  [/\bStandard\b/g, "स्टैंडर्ड", "स्टँडर्ड"],
  [/\bBasic\b/g, "बेसिक", "बेसिक"],
  [/\bComplete\b/g, "संपूर्ण", "संपूर्ण"],
  [/\bDeluxe\b/g, "डीलक्स", "डीलक्स"],
  [/\bPlain\b/g, "सादा", "साधा"],
  [/\bDesigner\b/g, "डिज़ाइनर", "डिझायनर"],
  [/\bDecorative\b/g, "सजावटी", "सजावटी"],
  [/\bHindi\b/g, "हिंदी", "हिंदी"],
  [/\bMarathi\b/g, "मराठी", "मराठी"],
  [/\bEnglish\b/g, "अंग्रेज़ी", "इंग्रजी"],
  [/\bSanskrit\b/g, "संस्कृत", "संस्कृत"],
  [/\bpocket\b/g, "पॉकेट", "पॉकेट"],
  [/\bPocket\b/g, "पॉकेट", "पॉकेट"],
  [/\bYearly\b/g, "वार्षिक", "वार्षिक"],
  [/\bmonth\b/g, "महीना", "महिना"],
  [/\bWooden\b/g, "लकड़ी", "लाकडी"],
  [/\bwooden\b/g, "लकड़ी", "लाकडी"],
  [/\bBrass\b/g, "पीतल", "पितळी"],
  [/\bbrass\b/g, "पीतल", "पितळी"],
  [/\bCotton\b/g, "सूती", "सुती"],
  [/\bVelvet\b/g, "मखमल", "मखमली"],
  [/\bPlastic\b/g, "प्लास्टिक", "प्लास्टिक"],
  [/\bAluminium\b/g, "एल्युमिनियम", "ॲल्युमिनियम"],
  [/\bdecorated\b/g, "सजा हुआ", "सजवलेला"],
  [/\bRed\b/g, "लाल", "लाल"],
  [/\bGreen\b/g, "हरी", "हिरवी"],
  [/\bAssorted\b/g, "मिक्स", "मिक्स"],
  [/\bRound\b/g, "गोल", "गोल"],
  [/\bLong\b/g, "लंबी", "लांब"],
  [/\bKanthi\b/g, "कंठी", "कंठी"],
  [/\binch\b/g, "इंच", "इंच"],
  [/\btablet\b/g, "टिकिया", "वडी"],
];

export function translateVariant(label: string, lang: "hi" | "mr"): string {
  let out = label;
  for (const [re, hi, mr] of VARIANT_WORDS) out = out.replace(re, lang === "hi" ? hi : mr);
  return out.replace(/–\s*(\d)/g, "– $1").replace(/\s+/g, " ").trim();
}

/** "500 ml", "1 kg", "15 kg tin", "Zipper pack 100 g" → net quantity and unit (whole numbers only). */
export function parseNetQuantity(label: string): { qty: number; unit: string } | null {
  const m = label.match(/(\d+(?:\.\d+)?)\s*(g|kg|ml|L)\b/);
  if (!m) return null;
  const qty = Number(m[1]);
  if (!Number.isInteger(qty)) return null;
  return { qty, unit: m[2] };
}

function categoryOf(no: number): PujaCategoryDef {
  const c = PUJA_CATEGORIES.find((x) => x.no === no);
  if (!c) throw new Error(`Unknown puja category ${no}`);
  return c;
}

const TYPE_BY_KEY = new Map<string, PujaTypeDef>(PUJA_TYPES.map((t) => [t.key, t]));

function typeOf(key: string): PujaTypeDef {
  const t = TYPE_BY_KEY.get(key);
  if (!t) throw new Error(`Unknown puja product type ${key}`);
  return t;
}

function expandBase(base: PujaBase): PujaSku[] {
  const type = typeOf(base.t);
  const cat = categoryOf(type.cat);
  return base.v.map(([variant, mrp]) => {
    const net = parseNetQuantity(variant);
    const loose = Boolean(base.loose) || /^Loose\b/.test(variant);
    const nameEn = `${base.en} – ${variant}`;
    const nameHi = `${base.hi} – ${translateVariant(variant, "hi")}`;
    const nameMr = `${base.mr} – ${translateVariant(variant, "mr")}`;
    const synonyms = [...new Set(base.syn.map((s) => s.trim()).filter(Boolean))];
    const searchText = [nameEn, nameHi, nameMr, base.en, base.hi, base.mr, type.en, type.hi, type.mr, ...synonyms]
      .join(" | ")
      .toLowerCase();
    const loosePrice = loose ? null : mrp;
    return {
      slug: `puja-${slugify(base.en)}-${slugify(variant) || "std"}`,
      categoryNo: cat.no,
      categorySlug: cat.slug,
      categoryEn: cat.en,
      typeKey: type.key,
      typeSlug: pujaTypeSlug(type.key),
      typeEn: type.en,
      nameEn,
      nameHi,
      nameMr,
      baseEn: base.en,
      variant,
      synonyms,
      sellUnit: base.u,
      unit: UNIT_TO_PRODUCT_UNIT[base.u],
      netQuantity: net?.qty ?? null,
      netQuantityUnit: net?.unit ?? null,
      // Loose goods carry no printed MRP: their price stays empty until the shop sets it.
      mrpPaise: loosePrice == null ? null : Math.round(loosePrice * 100),
      loose,
      perishable: Boolean(base.perishable),
      edible: Boolean(base.edible),
      hsnCode: base.hsn,
      gstRateBp: Math.round(base.gst * 100),
      festivals: [...(base.fest ?? [])],
      variantAttrs: { variant, ...(base.attrs ?? {}), ...(base.brand ? { brand: base.brand } : {}) },
      brand: base.brand ?? null,
      searchText,
      imageUrl: pujaCategoryImage(cat.slug),
      description: `${base.en} (${base.hi} / ${base.mr}) — ${type.en}, ${cat.en}.`,
    };
  });
}

let cached: PujaSku[] | null = null;

/** Every SKU of the master catalogue, in category order. */
export function pujaCatalogue(): PujaSku[] {
  if (!cached) cached = PUJA_BASES.flatMap(expandBase).sort((a, b) => a.categoryNo - b.categoryNo);
  return cached;
}

export function isPujaShopType(key: string | null | undefined): boolean {
  return key === PUJA_SHOP_TYPE_KEY;
}
