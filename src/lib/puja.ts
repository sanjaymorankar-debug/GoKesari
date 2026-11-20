/**
 * Puja Samagri & Temple Supplies (docs/puja-samagri-2026-11): the constants pages on both the
 * client and the server need — the shop type key, the 15 catalogue categories with their
 * Hindi / Marathi names, the festivals, the units. The 500-SKU catalogue itself lives in
 * src/server/puja/catalogue-data.ts. Pure data, no server-only imports.
 */

export type PujaUnit = "pcs" | "pack" | "box" | "dozen" | "g" | "kg" | "ml" | "L";

export const PUJA_UNITS: readonly PujaUnit[] = ["pcs", "pack", "box", "dozen", "g", "kg", "ml", "L"];

export interface PujaCategoryDef {
  no: number;
  slug: string;
  en: string;
  hi: string;
  mr: string;
  emoji: string;
}

export const PUJA_SHOP_TYPE_KEY = "PUJA_SAMAGRI";

export const PUJA_CATEGORIES: readonly PujaCategoryDef[] = [
  { no: 1, slug: "puja-agarbatti-dhoop", en: "Agarbatti & Dhoop", hi: "अगरबत्ती और धूप", mr: "अगरबत्ती आणि धूप", emoji: "🪔" },
  { no: 2, slug: "puja-kapur", en: "Kapur (Camphor)", hi: "कपूर", mr: "कापूर", emoji: "🤍" },
  { no: 3, slug: "puja-mombatti-diye-batti", en: "Mombatti, Diye & Batti", hi: "मोमबत्ती, दीये और बत्ती", mr: "मेणबत्ती, दिवे आणि वाती", emoji: "🕯️" },
  { no: 4, slug: "puja-havan-samagri", en: "Havan Samagri", hi: "हवन सामग्री", mr: "हवन साहित्य", emoji: "🔥" },
  { no: 5, slug: "puja-kumkum-roli-tilak", en: "Kumkum, Roli, Tilak & Colours", hi: "कुमकुम, रोली, तिलक और रंग", mr: "कुंकू, रोली, टिळा आणि रंग", emoji: "🔴" },
  { no: 6, slug: "puja-thali-utensils", en: "Puja Thali & Utensils", hi: "पूजा थाली और बर्तन", mr: "पूजेचे ताट आणि भांडी", emoji: "🍽️" },
  { no: 7, slug: "puja-murti-photo-yantra", en: "Murti, Photos & Yantra", hi: "मूर्ति, फोटो और यंत्र", mr: "मूर्ती, फोटो आणि यंत्र", emoji: "🛕" },
  { no: 8, slug: "puja-vastra-shringar", en: "Vastra & Shringar", hi: "वस्त्र और श्रृंगार", mr: "वस्त्र आणि शृंगार", emoji: "🧣" },
  { no: 9, slug: "puja-phool-patte", en: "Phool & Patte", hi: "फूल और पत्ते", mr: "फुले आणि पाने", emoji: "🌼" },
  { no: 10, slug: "puja-prasad-dry-items", en: "Prasad & Puja Dry Items", hi: "प्रसाद और पूजा सूखी सामग्री", mr: "प्रसाद आणि पूजेचे सुके साहित्य", emoji: "🥥" },
  { no: 11, slug: "puja-mala-rudraksha", en: "Mala & Rudraksha", hi: "माला और रुद्राक्ष", mr: "माळ आणि रुद्राक्ष", emoji: "📿" },
  { no: 12, slug: "puja-ready-kits", en: "Ready Puja Kits", hi: "तैयार पूजा किट", mr: "तयार पूजा किट", emoji: "🧺" },
  { no: 13, slug: "puja-festival-items", en: "Festival & Utsav Items", hi: "त्योहार और उत्सव सामग्री", mr: "सण-उत्सव साहित्य", emoji: "🎉" },
  { no: 14, slug: "puja-books-stationery", en: "Religious Books & Puja Stationery", hi: "धार्मिक पुस्तकें और पूजा स्टेशनरी", mr: "धार्मिक पुस्तके आणि पूजा स्टेशनरी", emoji: "📖" },
  { no: 15, slug: "puja-temple-bulk", en: "Temple Bulk Supplies (B2B)", hi: "मंदिर थोक सामग्री", mr: "मंदिरासाठी घाऊक साहित्य", emoji: "🏛️" },
];

/** Festivals used for filters, collections and kit tags. */
export const PUJA_FESTIVALS = [
  { key: "diwali", en: "Diwali", hi: "दिवाली", mr: "दिवाळी" },
  { key: "ganesh-chaturthi", en: "Ganesh Chaturthi", hi: "गणेश चतुर्थी", mr: "गणेश चतुर्थी" },
  { key: "navratri", en: "Navratri", hi: "नवरात्रि", mr: "नवरात्र" },
  { key: "makar-sankranti", en: "Makar Sankranti", hi: "मकर संक्रांति", mr: "मकर संक्रांत" },
  { key: "raksha-bandhan", en: "Raksha Bandhan", hi: "रक्षा बंधन", mr: "रक्षाबंधन" },
  { key: "janmashtami", en: "Janmashtami", hi: "जन्माष्टमी", mr: "गोकुळाष्टमी" },
  { key: "mahashivratri", en: "Mahashivratri", hi: "महाशिवरात्रि", mr: "महाशिवरात्री" },
  { key: "karva-chauth", en: "Karva Chauth", hi: "करवा चौथ", mr: "करवा चौथ" },
  { key: "chhath", en: "Chhath Puja", hi: "छठ पूजा", mr: "छठ पूजा" },
  { key: "holi", en: "Holi", hi: "होली", mr: "होळी" },
  { key: "griha-pravesh", en: "Griha Pravesh", hi: "गृह प्रवेश", mr: "गृहप्रवेश" },
  { key: "satyanarayan", en: "Satyanarayan Puja", hi: "सत्यनारायण पूजा", mr: "सत्यनारायण पूजा" },
  { key: "shraddh", en: "Shraddh / Pitru Paksha", hi: "श्राद्ध / पितृ पक्ष", mr: "श्राद्ध / पितृपक्ष" },
  { key: "vivah", en: "Vivah (Wedding)", hi: "विवाह", mr: "विवाह" },
] as const;

export type PujaFestivalKey = (typeof PUJA_FESTIVALS)[number]["key"];

export function festivalLabel(key: string, lang: "en" | "hi" | "mr" = "en"): string {
  const f = PUJA_FESTIVALS.find((x) => x.key === key);
  return f ? f[lang] : key;
}

export function pujaCategoryBySlug(slug: string): PujaCategoryDef | undefined {
  return PUJA_CATEGORIES.find((c) => c.slug === slug);
}

/** IST (UTC+5:30) date-time for reports and screens: 20-Nov-2026 14.35 IST. */
export function formatIst(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  const ist = new Date(d.getTime() + 330 * 60_000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][ist.getUTCMonth()];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(ist.getUTCDate())}-${mon}-${ist.getUTCFullYear()} ${pad(ist.getUTCHours())}.${pad(ist.getUTCMinutes())} IST`;
}

/** "2026-11-20T10:30" typed in an IST datetime-local field → the instant. */
export function istInputToDate(value: string): Date {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 330 * 60_000);
}

/** The instant → "2026-11-20T10:30" for an IST datetime-local field. */
export function dateToIstInput(value: Date | string): string {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16);
}
