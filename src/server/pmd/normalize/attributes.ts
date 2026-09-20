/**
 * Colour, size, country, boolean and money normalisers.
 */
import { cleanDisplay, isNullLike, normalizeText } from "./text";

/* ---------------------------------------------------------------- colour */

const COLOR_FAMILIES: Array<[string, RegExp]> = [
  ["black", /\b(black|jet|onyx|charcoal|ebony|midnight)\b/],
  ["white", /\b(white|ivory|pearl|snow)\b/],
  ["grey", /\b(grey|gray|graphite|slate|ash)\b/],
  ["silver", /\b(silver|platinum|titanium|steel)\b/],
  ["gold", /\b(gold|golden|champagne)\b/],
  ["red", /\b(red|maroon|crimson|scarlet|burgundy|wine)\b/],
  ["blue", /\b(blue|navy|teal|cyan|sky|indigo|aqua)\b/],
  ["green", /\b(green|olive|mint|emerald|lime)\b/],
  ["yellow", /\b(yellow|lemon|mustard)\b/],
  ["orange", /\b(orange|coral|peach)\b/],
  ["pink", /\b(pink|rose|magenta|blush)\b/],
  ["purple", /\b(purple|violet|lavender|lilac|plum)\b/],
  ["brown", /\b(brown|tan|coffee|chocolate|bronze|copper)\b/],
  ["beige", /\b(beige|cream|nude|sand|khaki)\b/],
  ["multicolor", /\b(multi|multicolou?r|assorted|mixed)\b/],
];

/** Full normalised phrase is the identity ("phantom black" != "phantom silver"); family is for filtering. */
export function normalizeColor(raw: string | null | undefined): { key: string; display: string; family: string | null } | null {
  if (raw == null || isNullLike(raw)) return null;
  const key = normalizeText(raw)
    .replace(/\bcolou?rs?\b/g, "")
    .replace(/\bgray\b/g, "grey")
    .replace(/\s+/g, " ")
    .trim();
  if (!key) return null;
  const family = COLOR_FAMILIES.find(([, re]) => re.test(key))?.[0] ?? null;
  const display = key.replace(/\b\w/g, (c) => c.toUpperCase());
  return { key, display, family };
}

/* ------------------------------------------------------------------ size */

const LETTER_SIZES: Record<string, string> = {
  "extra small": "XS", xs: "XS", "x small": "XS",
  small: "S", s: "S",
  medium: "M", m: "M", med: "M",
  large: "L", l: "L",
  "extra large": "XL", xl: "XL", "x large": "XL",
  "double extra large": "XXL", xxl: "XXL", "2xl": "XXL", "xx large": "XXL",
  "triple extra large": "3XL", xxxl: "3XL", "3xl": "3XL",
  "4xl": "4XL", xxxxl: "4XL",
  "free size": "FREE SIZE", freesize: "FREE SIZE", "one size": "FREE SIZE", onesize: "FREE SIZE", os: "FREE SIZE",
};

/** Apparel letter sizes fold to S/M/L/XL...; numeric sizes ("32", "8 uk") keep their number and unit tag. */
export function normalizeSize(raw: string | null | undefined): { key: string; display: string } | null {
  if (raw == null || isNullLike(raw)) return null;
  const full = normalizeText(raw);
  if (!full) return null;
  // Look up before stripping the word "size": "free size" is itself a size name.
  const direct = LETTER_SIZES[full];
  if (direct) return { key: direct.toLowerCase(), display: direct };
  const n = full.replace(/\bsize\b/g, "").replace(/\s+/g, " ").trim();
  if (!n) return null;
  const letter = LETTER_SIZES[n];
  if (letter) return { key: letter.toLowerCase(), display: letter };
  return { key: n, display: n.toUpperCase() };
}

/* --------------------------------------------------------------- country */

// name|ISO2|ISO3|alias... - the countries that actually turn up in Indian retail data.
const COUNTRY_ROWS = `
India|IN|IND|Bharat|Republic of India
United States|US|USA|U.S.A|United States of America|America
United Kingdom|GB|GBR|UK|Great Britain|England|Scotland|Wales|Northern Ireland
China|CN|CHN|PRC|People's Republic of China|Peoples Republic of China
Japan|JP|JPN
South Korea|KR|KOR|Korea|Republic of Korea
North Korea|KP|PRK
Germany|DE|DEU|Deutschland
France|FR|FRA
Italy|IT|ITA
Spain|ES|ESP
Portugal|PT|PRT
Netherlands|NL|NLD|Holland
Belgium|BE|BEL
Switzerland|CH|CHE
Austria|AT|AUT
Sweden|SE|SWE
Norway|NO|NOR
Denmark|DK|DNK
Finland|FI|FIN
Iceland|IS|ISL
Ireland|IE|IRL
Poland|PL|POL
Czech Republic|CZ|CZE|Czechia
Slovakia|SK|SVK
Hungary|HU|HUN
Romania|RO|ROU
Bulgaria|BG|BGR
Greece|GR|GRC
Croatia|HR|HRV
Serbia|RS|SRB
Slovenia|SI|SVN
Lithuania|LT|LTU
Latvia|LV|LVA
Estonia|EE|EST
Luxembourg|LU|LUX
Malta|MT|MLT
Cyprus|CY|CYP
Russia|RU|RUS|Russian Federation
Ukraine|UA|UKR
Turkey|TR|TUR|Turkiye|Türkiye
United Arab Emirates|AE|ARE|UAE|U.A.E|Dubai|Abu Dhabi
Saudi Arabia|SA|SAU|KSA
Qatar|QA|QAT
Kuwait|KW|KWT
Oman|OM|OMN
Bahrain|BH|BHR
Israel|IL|ISR
Iran|IR|IRN
Iraq|IQ|IRQ
Egypt|EG|EGY
Morocco|MA|MAR
South Africa|ZA|ZAF
Kenya|KE|KEN
Nigeria|NG|NGA
Ethiopia|ET|ETH
Tanzania|TZ|TZA
Ghana|GH|GHA
Singapore|SG|SGP
Malaysia|MY|MYS
Indonesia|ID|IDN
Thailand|TH|THA
Vietnam|VN|VNM|Viet Nam
Philippines|PH|PHL
Cambodia|KH|KHM
Myanmar|MM|MMR|Burma
Bangladesh|BD|BGD
Sri Lanka|LK|LKA
Nepal|NP|NPL
Bhutan|BT|BTN
Pakistan|PK|PAK
Afghanistan|AF|AFG
Maldives|MV|MDV
Hong Kong|HK|HKG
Taiwan|TW|TWN
Kazakhstan|KZ|KAZ
Uzbekistan|UZ|UZB
Australia|AU|AUS
New Zealand|NZ|NZL
Canada|CA|CAN
Mexico|MX|MEX
Brazil|BR|BRA
Argentina|AR|ARG
Chile|CL|CHL
Peru|PE|PER
Colombia|CO|COL
`.trim();

const COUNTRY_LOOKUP: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const row of COUNTRY_ROWS.split("\n")) {
    const [name, ...aliases] = row.split("|");
    for (const label of [name, ...aliases]) {
      const key = normalizeText(label);
      if (key && !map.has(key)) map.set(key, name);
    }
  }
  return map;
})();

const ORIGIN_PREFIX = /^(?:made in|product of|produce of|manufactured in|origin|country of origin|imported from|packed in|assembled in)\s*:?\s*/;

export interface CountryResult {
  name: string;
  recognised: boolean;
}

/** "Made in India", "IN", "IND", "Bharat" -> "India". Unknown values are title-cased and marked unrecognised. */
export function normalizeCountry(raw: string | null | undefined): CountryResult | null {
  if (raw == null || isNullLike(raw)) return null;
  const key = normalizeText(raw).replace(ORIGIN_PREFIX, "").trim();
  if (!key) return null;
  const direct = COUNTRY_LOOKUP.get(key);
  if (direct) return { name: direct, recognised: true };
  // "Gujarat, India" / "Mumbai India": try the trailing word groups as a country.
  const words = key.split(" ");
  for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
    const tail = COUNTRY_LOOKUP.get(words.slice(-n).join(" "));
    if (tail) return { name: tail, recognised: true };
  }
  const title = (cleanDisplay(raw) ?? raw).replace(ORIGIN_PREFIX, "").replace(/\b\w/g, (c) => c.toUpperCase());
  return { name: title, recognised: false };
}

/** Last comma-separated place segment of "Gujarat, India" as a country candidate. */
export function countryFromPlace(place: string | null | undefined): CountryResult | null {
  if (!place) return null;
  const parts = place.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const r = normalizeCountry(parts[i]);
    if (r?.recognised) return r;
  }
  return null;
}

/* --------------------------------------------------------------- booleans */

const TRUE_WORDS = new Set(["yes", "y", "true", "1", "t", "available", "present"]);
const FALSE_WORDS = new Set(["no", "n", "false", "0", "f", "absent"]);

export function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

/* ----------------------------------------------------------------- money */

/**
 * "Rs. 1,299.00", "₹99", 117.5, "99" -> integer minor units (129900, 9900, 11750).
 * Returns null for anything that is not a plain non-negative amount. Never guesses:
 * a range ("99-120") or free text is unusable, not "99".
 */
export function toMinorUnits(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
  }
  // Peel currency decoration first ("Rs. 99/-", "INR 99", "₹99") so its dot is not mistaken for a decimal point.
  const s = raw
    .trim()
    .replace(/^\s*(?:rs\.?|inr|rupees?|₹)\s*/i, "")
    .replace(/\s*\/-\s*$/, "");
  if (!s || /\d\s*[-–]+\s*\d|\d\s+to\s+\d/i.test(s.replace(/,/g, ""))) return null;
  const cleaned = s.replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}

export type StockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "LIMITED" | "UNKNOWN";

export function parseStockStatus(raw: unknown): StockStatus {
  if (raw == null) return "UNKNOWN";
  if (typeof raw === "boolean") return raw ? "IN_STOCK" : "OUT_OF_STOCK";
  const s = String(raw).trim().toLowerCase();
  if (!s) return "UNKNOWN";
  if (/(out of stock|sold out|unavailable|not available|currently unavailable|no stock|oos)/.test(s)) return "OUT_OF_STOCK";
  if (/(limited|low stock|only \d+|few left|last \d+)/.test(s)) return "LIMITED";
  if (/(in stock|available|instock|yes|ready to ship)/.test(s)) return "IN_STOCK";
  return "UNKNOWN";
}
