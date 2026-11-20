/**
 * Puja Samagri & Temple Supplies — master catalogue (owner brief, 20-Nov-2026).
 *
 * Pure data. One entry is a product "base" (one product type, one name in
 * English / Hindi / Marathi, its synonyms and flags) with one or more variants;
 * every variant becomes one master product (one SKU). `catalogue.ts` expands
 * this into rows; scripts/puja/build-catalogue.ts writes the CSV, the Excel
 * workbook and the seed SQL from those rows.
 *
 * MRP: typical retail MRP in rupees where one is common; `null` where it
 * varies by brand or is sold loose (the shop owner sets it). Every HSN code and
 * GST rate is a best reading of the GST schedules after the Sept 2025 rate
 * change and is marked "to verify with CA" in the admin view.
 */

import { PUJA_CATEGORIES, PUJA_FESTIVALS, PUJA_SHOP_TYPE_KEY, type PujaCategoryDef, type PujaUnit } from "@/lib/puja";

export { PUJA_CATEGORIES, PUJA_FESTIVALS, PUJA_SHOP_TYPE_KEY, type PujaCategoryDef, type PujaUnit };


export interface PujaTypeDef {
  key: string;
  cat: number;
  en: string;
  hi: string;
  mr: string;
}

/** [label, MRP in rupees or null] */
export type PujaVariant = readonly [label: string, mrp: number | null];

export interface PujaBase {
  t: string; // product type key
  en: string;
  hi: string;
  mr: string;
  syn: readonly string[];
  u: PujaUnit;
  v: readonly PujaVariant[];
  hsn: string;
  gst: number; // percent
  loose?: boolean;
  perishable?: boolean;
  edible?: boolean;
  fest?: readonly string[];
  attrs?: Readonly<Record<string, string>>;
  brand?: string;
}


export const PUJA_TYPES: readonly PujaTypeDef[] = [
  { key: "agarbatti", cat: 1, en: "Agarbatti", hi: "अगरबत्ती", mr: "अगरबत्ती" },
  { key: "dhoop-stick", cat: 1, en: "Dhoop Sticks", hi: "धूप बत्ती", mr: "धूप काडी" },
  { key: "dhoop-cone", cat: 1, en: "Dhoop Cones", hi: "धूप कोन", mr: "धूप कोन" },
  { key: "wet-dhoop", cat: 1, en: "Wet Dhoop", hi: "गीली धूप", mr: "ओली धूप" },
  { key: "sambrani", cat: 1, en: "Sambrani", hi: "सांब्रानी", mr: "सांब्राणी" },
  { key: "loban", cat: 1, en: "Loban & Guggal", hi: "लोबान और गुग्गल", mr: "लोबान आणि गुग्गुळ" },
  { key: "backflow", cat: 1, en: "Backflow Cones & Burners", hi: "बैकफ्लो कोन", mr: "बॅकफ्लो कोन" },
  { key: "holders", cat: 1, en: "Holders & Stands", hi: "स्टैंड और होल्डर", mr: "स्टँड आणि होल्डर" },
  { key: "kapur", cat: 2, en: "Kapur", hi: "कपूर", mr: "कापूर" },
  { key: "kapur-dani", cat: 2, en: "Kapur Dani", hi: "कपूरदानी", mr: "कापूरदाणी" },
  { key: "candle", cat: 3, en: "Candles", hi: "मोमबत्ती", mr: "मेणबत्ती" },
  { key: "tealight", cat: 3, en: "Tealights", hi: "टी-लाइट", mr: "टी-लाइट" },
  { key: "diya", cat: 3, en: "Diya", hi: "दीया", mr: "दिवा / पणती" },
  { key: "akhand-jyot", cat: 3, en: "Akhand Jyot", hi: "अखंड ज्योत", mr: "नंदादीप" },
  { key: "electric-diya", cat: 3, en: "Electric Diya", hi: "इलेक्ट्रिक दीया", mr: "इलेक्ट्रिक दिवा" },
  { key: "batti", cat: 3, en: "Cotton Batti", hi: "रुई की बत्ती", mr: "कापसाची वात" },
  { key: "puja-oil-ghee", cat: 3, en: "Puja Oil & Ghee", hi: "पूजा तेल और घी", mr: "पूजेचे तेल आणि तूप" },
  { key: "havan-samagri", cat: 4, en: "Havan Samagri", hi: "हवन सामग्री", mr: "हवन साहित्य" },
  { key: "havan-kund", cat: 4, en: "Havan Kund", hi: "हवन कुंड", mr: "होमकुंड" },
  { key: "samidha", cat: 4, en: "Samidha & Wood", hi: "समिधा और लकड़ी", mr: "समिधा आणि लाकूड" },
  { key: "havan-grain", cat: 4, en: "Havan Grains & Resins", hi: "हवन अनाज और गुग्गल", mr: "हवनाचे धान्य आणि गुग्गुळ" },
  { key: "havan-ghee", cat: 4, en: "Havan Ghee", hi: "हवन घी", mr: "हवनाचे तूप" },
  { key: "havan-tools", cat: 4, en: "Havan Tools", hi: "हवन उपकरण", mr: "हवन उपकरणे" },
  { key: "kumkum-roli", cat: 5, en: "Kumkum & Roli", hi: "कुमकुम और रोली", mr: "कुंकू आणि रोली" },
  { key: "sindoor", cat: 5, en: "Sindoor", hi: "सिंदूर", mr: "शेंदूर" },
  { key: "haldi", cat: 5, en: "Haldi", hi: "हल्दी", mr: "हळद" },
  { key: "chandan", cat: 5, en: "Chandan & Tilak", hi: "चंदन और तिलक", mr: "चंदन आणि टिळा" },
  { key: "vibhuti", cat: 5, en: "Vibhuti & Bhasma", hi: "विभूति और भस्म", mr: "विभूती आणि भस्म" },
  { key: "gulal", cat: 5, en: "Abir & Gulal", hi: "अबीर और गुलाल", mr: "अबीर आणि गुलाल" },
  { key: "akshat", cat: 5, en: "Akshat", hi: "अक्षत", mr: "अक्षता" },
  { key: "sacred-thread", cat: 5, en: "Moli & Janeu", hi: "मौली और जनेऊ", mr: "नाडापुडी आणि जानवे" },
  { key: "thali", cat: 6, en: "Puja Thali", hi: "पूजा थाली", mr: "पूजेचे ताट" },
  { key: "kalash-lota", cat: 6, en: "Kalash & Lota", hi: "कलश और लोटा", mr: "कलश आणि तांब्या" },
  { key: "panchpatra", cat: 6, en: "Panchpatra & Achmani", hi: "पंचपात्र और आचमनी", mr: "पंचपात्री आणि पळी" },
  { key: "aarti", cat: 6, en: "Aarti Diya & Stands", hi: "आरती दीया और स्टैंड", mr: "निरांजन आणि आरती स्टँड" },
  { key: "ghanti-shankh", cat: 6, en: "Ghanti & Shankh", hi: "घंटी और शंख", mr: "घंटा आणि शंख" },
  { key: "abhishek", cat: 6, en: "Abhishek Patra", hi: "अभिषेक पात्र", mr: "अभिषेक पात्र" },
  { key: "chowki-aasan", cat: 6, en: "Chowki & Aasan", hi: "चौकी और आसन", mr: "चौरंग आणि आसन" },
  { key: "puja-accessories", cat: 6, en: "Puja Accessories & Care", hi: "पूजा सामान और सफाई", mr: "पूजेचे साहित्य आणि स्वच्छता" },
  { key: "murti", cat: 7, en: "Murti", hi: "मूर्ति", mr: "मूर्ती" },
  { key: "photo", cat: 7, en: "Framed Photos", hi: "फ्रेम फोटो", mr: "फ्रेम केलेले फोटो" },
  { key: "yantra", cat: 7, en: "Yantra", hi: "यंत्र", mr: "यंत्र" },
  { key: "chunri-vastra", cat: 8, en: "Chunri & Vastra", hi: "चुनरी और वस्त्र", mr: "चुनरी आणि वस्त्र" },
  { key: "poshak", cat: 8, en: "Laddu Gopal Poshak & Mukut", hi: "लड्डू गोपाल पोशाक और मुकुट", mr: "लड्डू गोपाळ पोशाख आणि मुकुट" },
  { key: "puja-kapda", cat: 8, en: "Puja Cloth", hi: "पूजा कपड़ा", mr: "पूजेचे कापड" },
  { key: "shringar", cat: 8, en: "Shringar", hi: "श्रृंगार", mr: "शृंगार" },
  { key: "toran", cat: 8, en: "Toran", hi: "तोरण", mr: "तोरण" },
  { key: "fresh-flowers", cat: 9, en: "Fresh Flowers", hi: "ताज़े फूल", mr: "ताजी फुले" },
  { key: "garland", cat: 9, en: "Garlands", hi: "माला और हार", mr: "हार" },
  { key: "leaves", cat: 9, en: "Puja Leaves", hi: "पूजा के पत्ते", mr: "पूजेची पाने" },
  { key: "artificial-garland", cat: 9, en: "Artificial Garlands", hi: "कृत्रिम माला", mr: "कृत्रिम हार" },
  { key: "nariyal", cat: 10, en: "Nariyal", hi: "नारियल", mr: "नारळ" },
  { key: "supari-spices", cat: 10, en: "Supari, Laung & Elaichi", hi: "सुपारी, लौंग और इलायची", mr: "सुपारी, लवंग आणि वेलची" },
  { key: "mishri-batasha", cat: 10, en: "Mishri, Batasha & Prasad Sweets", hi: "मिश्री, बताशा और प्रसाद", mr: "खडीसाखर, बत्तासे आणि प्रसाद" },
  { key: "dry-fruits", cat: 10, en: "Dry Fruits & Makhana", hi: "मेवा और मखाना", mr: "सुका मेवा आणि मखाणा" },
  { key: "kesar-shahad", cat: 10, en: "Kesar & Shahad", hi: "केसर और शहद", mr: "केशर आणि मध" },
  { key: "gangajal-panchamrit", cat: 10, en: "Gangajal & Panchamrit", hi: "गंगाजल और पंचामृत", mr: "गंगाजल आणि पंचामृत" },
  { key: "paan", cat: 10, en: "Paan & Fresh Prasad Items", hi: "पान और ताज़ा प्रसाद", mr: "विड्याची पाने आणि ताजा प्रसाद" },
  { key: "rudraksha", cat: 11, en: "Rudraksha", hi: "रुद्राक्ष", mr: "रुद्राक्ष" },
  { key: "jap-mala", cat: 11, en: "Jap Mala", hi: "जप माला", mr: "जपमाळ" },
  { key: "gomukhi", cat: 11, en: "Gomukhi", hi: "गोमुखी", mr: "गोमुखी" },
  { key: "puja-kit", cat: 12, en: "Puja Kit", hi: "पूजा किट", mr: "पूजा किट" },
  { key: "rangoli", cat: 13, en: "Rangoli", hi: "रंगोली", mr: "रांगोळी" },
  { key: "kandil", cat: 13, en: "Kandil & Lanterns", hi: "कंदील", mr: "आकाशकंदील" },
  { key: "decor-diya", cat: 13, en: "Decorative Diyas", hi: "सजावटी दीये", mr: "सजावटीच्या पणत्या" },
  { key: "rakhi", cat: 13, en: "Rakhi", hi: "राखी", mr: "राखी" },
  { key: "til-items", cat: 13, en: "Sankranti Til Items", hi: "संक्रांति तिल सामग्री", mr: "संक्रांतीचे तिळगूळ" },
  { key: "ganesh-utsav", cat: 13, en: "Ganesh Utsav Items", hi: "गणेश उत्सव सामग्री", mr: "गणेशोत्सव साहित्य" },
  { key: "jhula", cat: 13, en: "Laddu Gopal Jhula", hi: "लड्डू गोपाल झूला", mr: "लड्डू गोपाळ पाळणा" },
  { key: "shubh-stickers", cat: 13, en: "Shubh Stickers", hi: "शुभ स्टिकर", mr: "शुभ स्टिकर" },
  { key: "religious-books", cat: 14, en: "Religious Books", hi: "धार्मिक पुस्तकें", mr: "धार्मिक पुस्तके" },
  { key: "panchang", cat: 14, en: "Panchang & Calendar", hi: "पंचांग और कैलेंडर", mr: "पंचांग आणि दिनदर्शिका" },
  { key: "bahi-khata", cat: 14, en: "Bahi-Khata & Pens", hi: "बही-खाता और पेन", mr: "वही-खाते आणि पेन" },
  { key: "matchbox-lighter", cat: 14, en: "Matchbox & Lighter", hi: "माचिस और लाइटर", mr: "काडेपेटी आणि लायटर" },
  { key: "mantra-booklets", cat: 14, en: "Mantra Cards & Puja Vidhi", hi: "मंत्र कार्ड और पूजा विधि", mr: "मंत्र कार्ड आणि पूजा विधी" },
  { key: "bulk-puja", cat: 15, en: "Bulk Puja Supplies", hi: "थोक पूजा सामग्री", mr: "घाऊक पूजा साहित्य" },
  { key: "bulk-ghee-oil", cat: 15, en: "Bulk Ghee & Oil", hi: "थोक घी और तेल", mr: "घाऊक तूप आणि तेल" },
  { key: "prasad-packing", cat: 15, en: "Prasad Packing & Serveware", hi: "प्रसाद पैकिंग और दोना-पत्तल", mr: "प्रसाद पॅकिंग आणि द्रोण-पत्रावळ" },
  { key: "temple-equipment", cat: 15, en: "Temple Equipment", hi: "मंदिर उपकरण", mr: "मंदिर साहित्य" },
  { key: "bulk-flowers", cat: 15, en: "Bulk Flowers", hi: "थोक फूल", mr: "घाऊक फुले" },
];


const FRAGRANCES: ReadonlyArray<[en: string, hi: string, mr: string, syn: string[]]> = [
  ["Rose", "गुलाब", "गुलाब", ["gulab", "rose incense"]],
  ["Chandan", "चंदन", "चंदन", ["sandal", "sandalwood", "chandan"]],
  ["Mogra", "मोगरा", "मोगरा", ["mogra", "jasmine sambac"]],
  ["Lavender", "लैवेंडर", "लॅव्हेंडर", ["lavender"]],
  ["Kewda", "केवड़ा", "केवडा", ["kewra", "kevda", "screwpine"]],
  ["Guggal", "गुग्गल", "गुग्गुळ", ["guggul", "gugal"]],
  ["Loban", "लोबान", "लोबान", ["loban", "benzoin", "lobaan"]],
  ["Mixed (3-in-1)", "मिक्स (3 इन 1)", "मिक्स (3 इन 1)", ["mix", "assorted", "3 in 1"]],
];

const AGARBATTI_SYN = ["agarbatti", "agarbathi", "agarbattee", "incense", "incense sticks", "अगरबत्ती", "अगरबत्ति", "धूपबत्ती"];
const DHOOP_SYN = ["dhoop", "dhup", "dhoopbatti", "धूप", "धुप"];
const KAPUR_SYN = ["kapur", "kapoor", "karpur", "camphor", "कपूर", "कापूर", "कर्पूर"];
const CANDLE_SYN = ["mombatti", "candle", "candles", "मोमबत्ती", "मेणबत्ती"];
const DIYA_SYN = ["diya", "deepak", "diva", "panti", "lamp", "दीया", "दिया", "दीपक", "दिवा", "पणती"];
const BATTI_SYN = ["batti", "bati", "wick", "cotton wick", "vaat", "बत्ती", "वात", "फुलवात"];

const AGARBATTI_VARIANTS: readonly PujaVariant[] = [
  ["Box, 20 sticks", 20],
  ["Zipper pack 100 g", 60],
  ["Zipper pack 250 g", 140],
];

function fragranceAgarbatti(): PujaBase[] {
  return FRAGRANCES.map(([en, hi, mr, syn]) => ({
    t: "agarbatti",
    en: `${en} Agarbatti`,
    hi: `${hi} अगरबत्ती`,
    mr: `${mr} अगरबत्ती`,
    syn: [...AGARBATTI_SYN, ...syn],
    u: "pack" as const,
    v: AGARBATTI_VARIANTS,
    hsn: "33074100",
    gst: 5,
    fest: ["diwali"],
    attrs: { fragrance: en },
  }));
}

function fragranceDhoop(kind: "stick" | "cone"): PujaBase[] {
  const pick = kind === "stick" ? ["Chandan", "Guggal", "Loban", "Mixed (3-in-1)"] : ["Chandan", "Guggal", "Rose", "Mogra"];
  return FRAGRANCES.filter(([en]) => pick.includes(en)).map(([en, hi, mr, syn]) =>
    kind === "stick"
      ? {
          t: "dhoop-stick",
          en: `${en} Dhoop Sticks`,
          hi: `${hi} धूप बत्ती`,
          mr: `${mr} धूप काडी`,
          syn: [...DHOOP_SYN, "dhoop stick", "dhoop batti", ...syn],
          u: "box" as const,
          v: [["Box, 20 sticks", 30], ["Pack, 50 sticks", 70]] as const,
          hsn: "33074100",
          gst: 5,
          attrs: { fragrance: en },
        }
      : {
          t: "dhoop-cone",
          en: `${en} Dhoop Cones`,
          hi: `${hi} धूप कोन`,
          mr: `${mr} धूप कोन`,
          syn: [...DHOOP_SYN, "cone", "dhoop cone", "कोन", ...syn],
          u: "box" as const,
          v: [["Box, 10 cones", 25], ["Box, 30 cones", 65]] as const,
          hsn: "33074100",
          gst: 5,
          attrs: { fragrance: en },
        },
  );
}

function backflowCones(): PujaBase[] {
  const pick = ["Chandan", "Rose", "Mixed (3-in-1)"];
  return FRAGRANCES.filter(([en]) => pick.includes(en)).map(([en, hi, mr, syn]) => ({
    t: "backflow",
    en: `${en} Backflow Cones`,
    hi: `${hi} बैकफ्लो कोन`,
    mr: `${mr} बॅकफ्लो कोन`,
    syn: ["backflow", "back flow", "smoke fountain cone", "बैकफ्लो", ...DHOOP_SYN, ...syn],
    u: "box" as const,
    v: [["Box, 10 cones", 60], ["Box, 40 cones", 199]] as const,
    hsn: "33074100",
    gst: 5,
    attrs: { fragrance: en },
  }));
}

const GULAL_COLOURS: ReadonlyArray<[en: string, hi: string, mr: string]> = [
  ["Red", "लाल", "लाल"],
  ["Pink", "गुलाबी", "गुलाबी"],
  ["Yellow", "पीला", "पिवळा"],
  ["Green", "हरा", "हिरवा"],
];

function gulal(): PujaBase[] {
  return GULAL_COLOURS.map(([en, hi, mr]) => ({
    t: "gulal",
    en: `Herbal Gulal ${en}`,
    hi: `हर्बल गुलाल ${hi}`,
    mr: `हर्बल गुलाल ${mr}`,
    syn: ["gulal", "holi colour", "colour powder", "rang", "गुलाल", "रंग", en.toLowerCase()],
    u: "pack" as const,
    v: [["100 g", 40]] as const,
    hsn: "32129090",
    gst: 18,
    fest: ["holi"],
    attrs: { colour: en },
  }));
}

type MurtiSpec = [god: string, hi: string, mr: string, syn: string[], variants: PujaVariant[]];

const MURTI_HSN: Record<string, [string, number]> = {
  Marble: ["68022190", 5],
  Brass: ["83062910", 5],
  Resin: ["39264049", 18],
  "Eco Clay": ["69139000", 5],
  Stone: ["68029900", 5],
};

function murtis(): PujaBase[] {
  const specs: Array<[material: string, hi: string, mr: string, list: MurtiSpec[]]> = [
    ["Marble", "संगमरमर", "संगमरवरी", [
      ["Ganesh", "गणेश", "गणपती", ["ganpati", "ganesha", "vinayak", "गणपति", "गणपती"], [["6 inch", 1200], ["9 inch", 2400]]],
      ["Lakshmi", "लक्ष्मी", "लक्ष्मी", ["laxmi", "lakshmi mata", "लक्ष्मी"], [["6 inch", 1200]]],
      ["Shivling", "शिवलिंग", "शिवलिंग", ["shivling", "shiv ling", "lingam", "शिवलिंग"], [["6 inch", 900]]],
      ["Hanuman", "हनुमान", "मारुती", ["hanuman", "bajrangbali", "maruti", "हनुमान", "मारुती"], [["6 inch", 1100]]],
      ["Durga", "दुर्गा", "दुर्गा", ["durga", "mata rani", "sherawali", "दुर्गा"], [["9 inch", 2600]]],
      ["Krishna", "कृष्ण", "कृष्ण", ["krishna", "kanha", "kanhaiya", "कृष्ण", "कान्हा"], [["6 inch", 1300]]],
      ["Sai Baba", "साईं बाबा", "साईबाबा", ["sai baba", "shirdi sai", "साई", "साईं"], [["6 inch", 1100]]],
    ]],
    ["Brass", "पीतल", "पितळी", [
      ["Ganesh", "गणेश", "गणपती", ["ganpati", "ganesha", "vinayak", "गणपति", "गणपती"], [["3 inch", 450], ["5 inch", 950]]],
      ["Lakshmi", "लक्ष्मी", "लक्ष्मी", ["laxmi", "lakshmi mata"], [["3 inch", 450], ["5 inch", 950]]],
      ["Lakshmi Ganesh Pair", "लक्ष्मी गणेश जोड़ी", "लक्ष्मी गणपती जोडी", ["laxmi ganesh", "diwali murti", "लक्ष्मी गणेश"], [["4 inch", 1400]]],
      ["Shivling with Jaladhari", "शिवलिंग जलाधारी सहित", "जलाधारीसह शिवलिंग", ["shivling", "jaladhari", "jalahari", "शिवलिंग"], [["3 inch", 650]]],
      ["Hanuman", "हनुमान", "मारुती", ["hanuman", "bajrangbali", "maruti"], [["4 inch", 750]]],
      ["Durga", "दुर्गा", "दुर्गा", ["durga", "mata rani"], [["4 inch", 850]]],
      ["Laddu Gopal", "लड्डू गोपाल", "लड्डू गोपाळ", ["laddu gopal", "bal gopal", "bal krishna", "kanha", "लड्डू गोपाल", "बाल गोपाल"], [["Size No. 1", 350], ["Size No. 2", 550], ["Size No. 4", 1250]]],
      ["Balaji", "बालाजी", "बालाजी", ["balaji", "venkateshwara", "tirupati", "बालाजी"], [["4 inch", 1100]]],
    ]],
    ["Resin", "रेज़िन", "रेझिन", [
      ["Ganesh", "गणेश", "गणपती", ["ganpati", "ganesha"], [["4 inch", 299], ["6 inch", 499]]],
      ["Lakshmi", "लक्ष्मी", "लक्ष्मी", ["laxmi"], [["4 inch", 299]]],
      ["Lakshmi Ganesh Pair", "लक्ष्मी गणेश जोड़ी", "लक्ष्मी गणपती जोडी", ["laxmi ganesh", "diwali murti"], [["6 inch", 599]]],
      ["Hanuman", "हनुमान", "मारुती", ["hanuman", "bajrangbali"], [["6 inch", 449]]],
      ["Durga", "दुर्गा", "दुर्गा", ["durga", "mata rani"], [["6 inch", 499]]],
      ["Radha Krishna", "राधा कृष्ण", "राधा कृष्ण", ["radha krishna", "radhe krishna", "राधा कृष्ण"], [["6 inch", 549]]],
    ]],
    ["Eco Clay", "इको मिट्टी (शाडू)", "शाडू माती", [
      ["Ganesh", "गणेश", "गणपती", ["ganpati", "eco friendly ganesh", "shadu ganpati", "शाडू गणपती"], [["6 inch", 450], ["12 inch", 1500]]],
    ]],
    ["Stone", "नर्मदेश्वर पत्थर", "नर्मदेश्वर दगडी", [
      ["Narmadeshwar Shivling", "नर्मदेश्वर शिवलिंग", "नर्मदेश्वर शिवलिंग", ["narmadeshwar", "baan ling", "shivling", "नर्मदेश्वर"], [["2 inch", 300], ["4 inch", 900]]],
    ]],
  ];
  const out: PujaBase[] = [];
  for (const [material, matHi, matMr, list] of specs) {
    const [hsn, gst] = MURTI_HSN[material];
    for (const [god, hi, mr, syn, variants] of list) {
      out.push({
        t: "murti",
        en: `${god} Murti – ${material}`,
        hi: `${hi} मूर्ति – ${matHi}`,
        mr: `${mr} मूर्ती – ${matMr}`,
        syn: ["murti", "idol", "statue", "moorti", "मूर्ति", "मूर्ती", material.toLowerCase(), ...syn],
        u: "pcs",
        v: variants,
        hsn,
        gst,
        attrs: { material, deity: god },
        fest: god.startsWith("Ganesh") ? ["ganesh-chaturthi"] : god.includes("Lakshmi") ? ["diwali"] : god.includes("Shiv") ? ["mahashivratri"] : god.includes("Laddu") || god.includes("Krishna") ? ["janmashtami"] : god === "Durga" ? ["navratri"] : undefined,
      });
    }
  }
  return out;
}

function framedPhotos(): PujaBase[] {
  const gods: Array<[string, string, string, string[]]> = [
    ["Ganesh", "गणेश", "गणपती", ["ganpati", "ganesha"]],
    ["Lakshmi", "लक्ष्मी", "लक्ष्मी", ["laxmi"]],
    ["Shiv Parivar", "शिव परिवार", "शिव परिवार", ["shiv", "shiva", "shankar", "parvati"]],
    ["Hanuman", "हनुमान", "मारुती", ["bajrangbali", "maruti"]],
    ["Durga", "दुर्गा", "दुर्गा", ["mata rani", "sherawali"]],
    ["Sai Baba", "साईं बाबा", "साईबाबा", ["shirdi sai"]],
    ["Balaji", "बालाजी", "बालाजी", ["venkateshwara", "tirupati"]],
    ["Radha Krishna", "राधा कृष्ण", "राधा कृष्ण", ["krishna", "kanha"]],
    ["Vitthal Rukmini", "विट्ठल रुक्मिणी", "विठ्ठल रखुमाई", ["vitthal", "vithoba", "pandurang", "विठ्ठल"]],
  ];
  return gods.map(([en, hi, mr, syn], i) => ({
    t: "photo",
    en: `${en} Framed Photo`,
    hi: `${hi} फ्रेम फोटो`,
    mr: `${mr} फ्रेम फोटो`,
    syn: ["photo", "frame", "tasveer", "picture", "फोटो", "तस्वीर", "फ्रेम", ...syn],
    u: "pcs" as const,
    v: i < 1 ? [["8 x 10 inch", 199], ["12 x 18 inch", 449]] as const : [["8 x 10 inch", 199]] as const,
    hsn: "49119100",
    gst: 5,
    attrs: { deity: en },
  }));
}

function yantras(): PujaBase[] {
  const list: Array<[string, string, string, string[]]> = [
    ["Shree Yantra", "श्री यंत्र", "श्री यंत्र", ["shri yantra", "sri yantra", "shree yantra", "श्रीयंत्र"]],
    ["Kuber Yantra", "कुबेर यंत्र", "कुबेर यंत्र", ["kuber", "kubera yantra"]],
    ["Navgrah Yantra", "नवग्रह यंत्र", "नवग्रह यंत्र", ["navgraha", "navagraha", "नवग्रह"]],
    ["Vastu Yantra", "वास्तु यंत्र", "वास्तु यंत्र", ["vastu", "vaastu"]],
  ];
  return list.map(([en, hi, mr, syn]) => ({
    t: "yantra",
    en: `${en} (Copper)`,
    hi: `${hi} (तांबा)`,
    mr: `${mr} (तांबे)`,
    syn: ["yantra", "yantram", "यंत्र", "copper", ...syn],
    u: "pcs" as const,
    v: [["3 x 3 inch", 199], ["6 x 6 inch", 499]] as const,
    hsn: "74199990",
    gst: 5,
    fest: en.startsWith("Shree") || en.startsWith("Kuber") ? ["diwali"] : undefined,
    attrs: { material: "Copper" },
  }));
}

function pujaKits(): PujaBase[] {
  const kits: Array<[en: string, hi: string, mr: string, syn: string[], fest: string[], v: PujaVariant[], edible: boolean]> = [
    ["Satyanarayan Puja Kit", "सत्यनारायण पूजा किट", "सत्यनारायण पूजा किट", ["satyanarayan", "satyanarayan katha", "सत्यनारायण"], ["satyanarayan"], [["Basic", 551], ["Complete", 1101]], true],
    ["Griha Pravesh Puja Kit", "गृह प्रवेश पूजा किट", "गृहप्रवेश पूजा किट", ["griha pravesh", "grah pravesh", "house warming", "vastu puja", "गृह प्रवेश"], ["griha-pravesh"], [["Basic", 1101], ["Complete", 2101]], false],
    ["Lakshmi Puja Kit (Diwali)", "लक्ष्मी पूजा किट (दिवाली)", "लक्ष्मीपूजन किट (दिवाळी)", ["diwali puja", "laxmi puja", "lakshmi pujan", "दिवाली पूजा", "लक्ष्मीपूजन"], ["diwali"], [["Basic", 751], ["Deluxe", 1501]], true],
    ["Ganesh Chaturthi Puja Kit", "गणेश चतुर्थी पूजा किट", "गणेश चतुर्थी पूजा किट", ["ganpati puja", "ganesh sthapana", "गणपती पूजा"], ["ganesh-chaturthi"], [["Basic", 651], ["Complete", 1251]], false],
    ["Navratri Kalash Sthapana Kit", "नवरात्रि कलश स्थापना किट", "नवरात्र घटस्थापना किट", ["navratri", "ghatasthapana", "kalash sthapana", "घटस्थापना"], ["navratri"], [["Standard", 851]], false],
    ["Karva Chauth Puja Kit", "करवा चौथ पूजा किट", "करवा चौथ पूजा किट", ["karwa chauth", "karva chauth", "करवा चौथ"], ["karva-chauth"], [["Thali kit", 699]], false],
    ["Chhath Puja Kit", "छठ पूजा किट", "छठ पूजा किट", ["chhath", "chhath puja", "छठ"], ["chhath"], [["Standard", 1101]], true],
    ["Mahashivratri Puja Kit", "महाशिवरात्रि पूजा किट", "महाशिवरात्री पूजा किट", ["shivratri", "shiv puja", "शिवरात्रि"], ["mahashivratri"], [["Standard", 551]], false],
    ["Janmashtami Puja Kit", "जन्माष्टमी पूजा किट", "गोकुळाष्टमी पूजा किट", ["janmashtami", "krishna janmashtami", "gokulashtami", "जन्माष्टमी"], ["janmashtami"], [["Standard", 651]], true],
    ["Shraddh / Pind Daan Kit", "श्राद्ध / पिंड दान किट", "श्राद्ध / पिंडदान किट", ["shraddh", "pind daan", "pitru paksha", "tarpan", "श्राद्ध"], ["shraddh"], [["Standard", 751]], true],
    ["Vivah Puja Kit", "विवाह पूजा किट", "विवाह पूजा किट", ["wedding puja", "shaadi puja", "vivah", "लग्न पूजा"], ["vivah"], [["Standard", 2101]], false],
    ["Rudrabhishek Puja Kit", "रुद्राभिषेक पूजा किट", "रुद्राभिषेक पूजा किट", ["rudrabhishek", "rudra abhishek", "रुद्राभिषेक"], ["mahashivratri"], [["Standard", 1101]], false],
    ["Vastu Shanti Puja Kit", "वास्तु शांति पूजा किट", "वास्तुशांती पूजा किट", ["vastu shanti", "vaastu shanti", "वास्तु शांति"], ["griha-pravesh"], [["Standard", 1501]], false],
    ["Daily Puja Kit", "दैनिक पूजा किट", "रोजच्या पूजेचे किट", ["daily puja", "nitya puja", "rozana puja"], [], [["1 month", 299]], false],
  ];
  return kits.map(([en, hi, mr, syn, fest, v, edible]) => ({
    t: "puja-kit",
    en,
    hi,
    mr,
    syn: ["puja kit", "pooja kit", "puja samagri kit", "पूजा किट", "पूजा सामग्री", ...syn],
    u: "pack" as const,
    v,
    hsn: "33074100",
    gst: 5,
    edible,
    fest,
  }));
}

/* ------------------------------------------------------------------ bases */

export const PUJA_BASES: readonly PujaBase[] = [
  /* ---------------------------------------------- 1. Agarbatti & Dhoop */
  ...fragranceAgarbatti(),
  { t: "agarbatti", en: "Cycle Pure Agarbatti (Three in One)", hi: "साइकिल प्योर अगरबत्ती (थ्री इन वन)", mr: "सायकल प्युअर अगरबत्ती (थ्री इन वन)", syn: [...AGARBATTI_SYN, "cycle", "cycle agarbatti"], u: "box", v: [["Box", null]], hsn: "33074100", gst: 5, brand: "Cycle" },
  { t: "agarbatti", en: "Zed Black Agarbatti (3-in-1)", hi: "ज़ेड ब्लैक अगरबत्ती (3 इन 1)", mr: "झेड ब्लॅक अगरबत्ती (3 इन 1)", syn: [...AGARBATTI_SYN, "zed black"], u: "pack", v: [["Pack", null]], hsn: "33074100", gst: 5, brand: "Zed Black" },
  { t: "agarbatti", en: "Mangaldeep Agarbatti (Sandal)", hi: "मंगलदीप अगरबत्ती (चंदन)", mr: "मंगलदीप अगरबत्ती (चंदन)", syn: [...AGARBATTI_SYN, "mangaldeep", "sandal"], u: "box", v: [["Box", null]], hsn: "33074100", gst: 5, brand: "Mangaldeep" },
  { t: "agarbatti", en: "Hem Agarbatti (Precious Chandan)", hi: "हेम अगरबत्ती (प्रेशियस चंदन)", mr: "हेम अगरबत्ती (प्रेशियस चंदन)", syn: [...AGARBATTI_SYN, "hem", "hem incense"], u: "box", v: [["Box", null]], hsn: "33074100", gst: 5, brand: "Hem" },
  { t: "agarbatti", en: "Satya Agarbatti (Nag Champa)", hi: "सत्य अगरबत्ती (नाग चंपा)", mr: "सत्य अगरबत्ती (नाग चंपा)", syn: [...AGARBATTI_SYN, "satya", "nag champa", "nagchampa"], u: "box", v: [["Box", null]], hsn: "33074100", gst: 5, brand: "Satya" },
  ...fragranceDhoop("stick"),
  ...fragranceDhoop("cone"),
  { t: "wet-dhoop", en: "Wet Dhoop (Gili Dhoop)", hi: "गीली धूप", mr: "ओली धूप", syn: [...DHOOP_SYN, "wet dhoop", "gili dhoop", "dhoop paste", "गीली धूप"], u: "pack", v: [["100 g", 60], ["200 g", 110]], hsn: "33074100", gst: 5 },
  { t: "sambrani", en: "Cup Sambrani", hi: "कप सांब्रानी", mr: "कप सांब्राणी", syn: ["sambrani", "sambrani cup", "cup sambrani", "dhoop cup", "सांब्रानी", "सांब्राणी", "loban cup"], u: "box", v: [["Box, 12 cups", 60], ["Box, 20 cups", 95]], hsn: "33074100", gst: 5 },
  { t: "sambrani", en: "Sambrani Dhoop Sticks", hi: "सांब्रानी धूप बत्ती", mr: "सांब्राणी धूप काडी", syn: ["sambrani", "sambrani sticks", ...DHOOP_SYN], u: "box", v: [["Box, 10 sticks", 45]], hsn: "33074100", gst: 5 },
  { t: "loban", en: "Loban Tikki", hi: "लोबान टिक्की", mr: "लोबान टिकली", syn: ["loban", "lobaan", "loban tablet", "loban tikki", "लोबान"], u: "pack", v: [["Pack, 10 tikki", 30], ["Pack, 25 tikki", 65]], hsn: "33074100", gst: 5 },
  { t: "loban", en: "Loban Powder", hi: "लोबान पाउडर", mr: "लोबान पावडर", syn: ["loban", "lobaan", "benzoin powder", "लोबान"], u: "pack", v: [["50 g", 40], ["100 g", 75]], hsn: "33074100", gst: 5 },
  { t: "loban", en: "Loban Resin (Loose)", hi: "लोबान खुला", mr: "लोबान सुटा", syn: ["loban", "raw loban", "benzoin", "sambrani resin", "लोबान"], u: "kg", v: [["Loose, per kg", null]], hsn: "13019099", gst: 5, loose: true },
  { t: "loban", en: "Guggal Dhoop Batti", hi: "गुग्गल धूप बत्ती", mr: "गुग्गुळ धूप काडी", syn: ["guggal", "guggul", "gugal dhoop", "गुग्गल", "गुग्गुळ", ...DHOOP_SYN], u: "box", v: [["Box, 10 sticks", 35], ["Box, 20 sticks", 65]], hsn: "33074100", gst: 5 },
  ...backflowCones(),
  { t: "backflow", en: "Backflow Burner (Ceramic)", hi: "बैकफ्लो बर्नर (सिरेमिक)", mr: "बॅकफ्लो बर्नर (सिरॅमिक)", syn: ["backflow burner", "smoke fountain", "waterfall burner", "बैकफ्लो"], u: "pcs", v: [["Small", 249], ["Medium", 449]], hsn: "69139000", gst: 5, attrs: { material: "Ceramic" } },
  { t: "holders", en: "Wooden Agarbatti Holder", hi: "लकड़ी का अगरबत्ती होल्डर", mr: "लाकडी अगरबत्ती होल्डर", syn: ["agarbatti stand", "incense holder", "agarbatti holder", "अगरबत्ती स्टैंड"], u: "pcs", v: [["Single", 49], ["Pack of 3", 129]], hsn: "44209090", gst: 5, attrs: { material: "Wood" } },
  { t: "holders", en: "Brass Dhoop Cone Holder", hi: "पीतल धूप कोन होल्डर", mr: "पितळी धूप कोन होल्डर", syn: ["dhoop stand", "cone holder", "dhoop holder", "धूप स्टैंड"], u: "pcs", v: [["Small", 149], ["Medium", 249]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "holders", en: "Dhoop Dani (Clay)", hi: "धूपदानी (मिट्टी)", mr: "धुपारणे (माती)", syn: ["dhoop dani", "dhoopdani", "dhuparne", "धूपदानी", "धुपारणे"], u: "pcs", v: [["Single", 60]], hsn: "69120040", gst: 0, attrs: { material: "Clay" } },
  { t: "holders", en: "Sambrani Burner (Brass)", hi: "सांब्रानी बर्नर (पीतल)", mr: "सांब्राणी धुपारणे (पितळी)", syn: ["sambrani stand", "loban dani", "dhoop dani brass", "लोबानदानी"], u: "pcs", v: [["With handle", 399]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },

  /* ---------------------------------------------------- 2. Kapur (Camphor) */
  { t: "kapur", en: "Bhimseni Kapur", hi: "भीमसेनी कपूर", mr: "भीमसेनी कापूर", syn: [...KAPUR_SYN, "bhimseni", "bheemseni", "edible camphor", "pachai karpooram", "भीमसेनी"], u: "pack", v: [["10 g", 60], ["25 g", 140], ["100 g", 520]], hsn: "29142910", gst: 18 },
  { t: "kapur", en: "Kapur Tablets", hi: "कपूर टिकिया", mr: "कापूर वडी", syn: [...KAPUR_SYN, "camphor tablets", "kapur tikki", "कपूर टिकिया", "कापूर वडी"], u: "pack", v: [["50 g", 75], ["100 g", 145], ["500 g", 680]], hsn: "29142910", gst: 18 },
  { t: "kapur", en: "Kapur Cubes", hi: "कपूर क्यूब", mr: "कापूर क्यूब", syn: [...KAPUR_SYN, "camphor cubes", "kapur cube"], u: "pack", v: [["25 g", 45], ["100 g", 160]], hsn: "29142910", gst: 18 },
  { t: "kapur", en: "Kapur Powder", hi: "कपूर पाउडर", mr: "कापूर पावडर", syn: [...KAPUR_SYN, "camphor powder"], u: "pack", v: [["50 g", 80], ["100 g", 150]], hsn: "29142910", gst: 18 },
  { t: "kapur", en: "Kapur (Loose)", hi: "कपूर खुला", mr: "कापूर सुटा", syn: [...KAPUR_SYN, "loose camphor", "khula kapur"], u: "kg", v: [["Loose, per kg", null]], hsn: "29142910", gst: 18, loose: true },
  { t: "kapur", en: "Mangalam Camphor Tablets", hi: "मंगलम कपूर टिकिया", mr: "मंगलम कापूर वडी", syn: [...KAPUR_SYN, "mangalam"], u: "pack", v: [["Pack", null]], hsn: "29142910", gst: 18, brand: "Mangalam" },
  { t: "kapur-dani", en: "Kapur Dani (Brass)", hi: "कपूरदानी (पीतल)", mr: "कापूरदाणी (पितळी)", syn: ["kapur dani", "camphor holder", "kapoor aarti", "कपूरदानी", "कापूर आरती"], u: "pcs", v: [["Small", 149], ["Medium", 249], ["Large", 399]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "kapur-dani", en: "Kapur Dani (Steel)", hi: "कपूरदानी (स्टील)", mr: "कापूरदाणी (स्टील)", syn: ["kapur dani", "camphor holder", "कपूरदानी"], u: "pcs", v: [["Standard", 99]], hsn: "73239390", gst: 5, attrs: { material: "Steel" } },

  /* ------------------------------------------ 3. Mombatti, Diye & Batti */
  { t: "candle", en: "White Candles (Plain)", hi: "सफ़ेद मोमबत्ती", mr: "पांढरी मेणबत्ती", syn: [...CANDLE_SYN, "white candle", "plain candle", "safed mombatti"], u: "pack", v: [["Pack of 6", 40], ["Pack of 12", 75]], hsn: "34060010", gst: 5 },
  { t: "candle", en: "Coloured Candles", hi: "रंगीन मोमबत्ती", mr: "रंगीत मेणबत्ती", syn: [...CANDLE_SYN, "colour candle", "rangeen mombatti"], u: "pack", v: [["Pack of 6", 60], ["Pack of 12", 110]], hsn: "34060010", gst: 5, fest: ["diwali"] },
  { t: "candle", en: "Pillar Candle (Long Burning)", hi: "पिलर मोमबत्ती", mr: "पिलर मेणबत्ती", syn: [...CANDLE_SYN, "pillar candle", "thick candle", "long candle"], u: "pcs", v: [["2 x 4 inch", 99], ["3 x 6 inch", 199]], hsn: "34060010", gst: 5 },
  { t: "candle", en: "Scented Jar Candle – Rose", hi: "सुगंधित जार मोमबत्ती – गुलाब", mr: "सुगंधी जार मेणबत्ती – गुलाब", syn: [...CANDLE_SYN, "scented candle", "aroma candle", "jar candle", "rose"], u: "pcs", v: [["100 g jar", 249]], hsn: "34060010", gst: 5, attrs: { fragrance: "Rose" } },
  { t: "candle", en: "Scented Jar Candle – Lavender", hi: "सुगंधित जार मोमबत्ती – लैवेंडर", mr: "सुगंधी जार मेणबत्ती – लॅव्हेंडर", syn: [...CANDLE_SYN, "scented candle", "aroma candle", "lavender"], u: "pcs", v: [["100 g jar", 249]], hsn: "34060010", gst: 5, attrs: { fragrance: "Lavender" } },
  { t: "candle", en: "Scented Jar Candle – Sandalwood", hi: "सुगंधित जार मोमबत्ती – चंदन", mr: "सुगंधी जार मेणबत्ती – चंदन", syn: [...CANDLE_SYN, "scented candle", "chandan", "sandal"], u: "pcs", v: [["100 g jar", 249]], hsn: "34060010", gst: 5, attrs: { fragrance: "Sandalwood" } },
  { t: "candle", en: "Gel Candle (Glass)", hi: "जेल मोमबत्ती (कांच)", mr: "जेल मेणबत्ती (काच)", syn: [...CANDLE_SYN, "gel candle", "glass candle"], u: "pcs", v: [["Small", 99], ["Medium", 179]], hsn: "34060090", gst: 5, fest: ["diwali"] },
  { t: "tealight", en: "Tealight Candles", hi: "टी-लाइट मोमबत्ती", mr: "टी-लाइट मेणबत्ती", syn: [...CANDLE_SYN, "tealight", "tea light", "tealight candle", "टी लाइट"], u: "pack", v: [["Pack of 10", 49], ["Pack of 50", 179], ["Pack of 100", 329]], hsn: "34060010", gst: 5, fest: ["diwali"] },
  { t: "diya", en: "Mitti Diya (Plain)", hi: "मिट्टी का दीया", mr: "मातीची पणती", syn: [...DIYA_SYN, "mitti diya", "clay diya", "earthen lamp", "मिट्टी का दीया", "मातीची पणती"], u: "pack", v: [["Pack of 12", 40], ["Pack of 50", 140], ["Pack of 100", 260]], hsn: "69120040", gst: 0, fest: ["diwali"], attrs: { material: "Clay" } },
  { t: "diya", en: "Mitti Diya (Hand-painted)", hi: "रंगीन मिट्टी का दीया", mr: "रंगवलेली मातीची पणती", syn: [...DIYA_SYN, "painted diya", "designer diya", "clay diya"], u: "pack", v: [["Pack of 6", 99], ["Pack of 12", 179]], hsn: "69120040", gst: 0, fest: ["diwali"], attrs: { material: "Clay" } },
  { t: "diya", en: "Brass Diya (Samai Style)", hi: "पीतल का दीया", mr: "पितळी दिवा (समई)", syn: [...DIYA_SYN, "brass diya", "pital diya", "samai", "समई", "पीतल दीया"], u: "pcs", v: [["Size No. 1", 199], ["Size No. 2", 299], ["Size No. 3", 449]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "diya", en: "Panchmukhi Diya (Brass)", hi: "पंचमुखी दीया (पीतल)", mr: "पंचमुखी दिवा (पितळी)", syn: [...DIYA_SYN, "panchmukhi", "five wick diya", "पंचमुखी"], u: "pcs", v: [["Standard", 349]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "akhand-jyot", en: "Akhand Jyot (Brass, with Glass Cover)", hi: "अखंड ज्योत (पीतल, कांच कवर)", mr: "नंदादीप (पितळी, काचेच्या आवरणासह)", syn: ["akhand jyot", "akhand jyoti", "nandadeep", "akhand diya", "अखंड ज्योत", "नंदादीप", ...DIYA_SYN], u: "pcs", v: [["Small", 349], ["Large", 849]], hsn: "94055010", gst: 5, fest: ["navratri"], attrs: { material: "Brass" } },
  { t: "electric-diya", en: "Electric LED Diya", hi: "इलेक्ट्रिक एलईडी दीया", mr: "इलेक्ट्रिक एलईडी दिवा", syn: [...DIYA_SYN, "led diya", "electric diya", "battery diya", "flameless diya"], u: "pack", v: [["Pack of 6", 199], ["Pack of 12", 349]], hsn: "94054900", gst: 18, fest: ["diwali"] },
  { t: "batti", en: "Round Cotton Batti (Phool Batti)", hi: "गोल रुई बत्ती (फूल बत्ती)", mr: "फुलवात", syn: [...BATTI_SYN, "phool batti", "round batti", "gol batti", "फूल बत्ती", "फुलवात"], u: "pack", v: [["Pack of 100", 30], ["Pack of 300", 80]], hsn: "56012100", gst: 5 },
  { t: "batti", en: "Long Cotton Batti (Lambi Batti)", hi: "लंबी रुई बत्ती", mr: "लांब वात", syn: [...BATTI_SYN, "long batti", "lambi batti", "लंबी बत्ती"], u: "pack", v: [["Pack of 100", 30], ["Pack of 500", 120]], hsn: "56012100", gst: 5 },
  { t: "batti", en: "Ready Ghee Batti", hi: "रेडी घी बत्ती", mr: "तयार तुपाची वात", syn: [...BATTI_SYN, "ghee batti", "ghee wick", "ready batti", "घी बत्ती", "तुपाची वात"], u: "box", v: [["Box of 25", 60], ["Box of 108", 210]], hsn: "56012100", gst: 5 },
  { t: "puja-oil-ghee", en: "Puja Oil (Deepam Oil)", hi: "पूजा तेल (दीपम तेल)", mr: "दिव्याचे तेल", syn: ["puja oil", "pooja oil", "deepam oil", "lamp oil", "diya oil", "पूजा तेल", "दिव्याचे तेल"], u: "L", v: [["1 L", 210], ["5 L", 990]], hsn: "15180039", gst: 5 },
  { t: "puja-oil-ghee", en: "Til Oil (Sesame) for Diya", hi: "तिल का तेल", mr: "तिळाचे तेल", syn: ["til oil", "til ka tel", "sesame oil", "gingelly oil", "तिल तेल", "तिळाचे तेल"], u: "L", v: [["500 ml", 160], ["1 L", 300]], hsn: "15155099", gst: 5, fest: ["makar-sankranti"] },
  { t: "puja-oil-ghee", en: "Puja Ghee (Cow Ghee for Diya)", hi: "पूजा घी (दीये के लिए गाय का घी)", mr: "पूजेचे तूप (दिव्यासाठी गाईचे तूप)", syn: ["puja ghee", "diya ghee", "cow ghee", "desi ghee", "ghee", "घी", "तूप"], u: "ml", v: [["200 ml", 140], ["1 L", 640]], hsn: "04059020", gst: 5, edible: true },

  /* ------------------------------------------------------ 4. Havan Samagri */
  { t: "havan-samagri", en: "Havan Samagri", hi: "हवन सामग्री", mr: "हवन साहित्य", syn: ["havan samagri", "hawan samagri", "havan material", "homa samagri", "yagya samagri", "हवन सामग्री", "हवन साहित्य", "होम साहित्य"], u: "pack", v: [["100 g", 40], ["500 g", 170], ["1 kg", 320]], hsn: "33074100", gst: 0 },
  { t: "havan-samagri", en: "Havan Samagri (Loose)", hi: "हवन सामग्री खुली", mr: "हवन साहित्य सुटे", syn: ["havan samagri", "hawan samagri", "loose havan samagri", "हवन सामग्री"], u: "kg", v: [["Loose, per kg", null]], hsn: "33074100", gst: 0, loose: true },
  { t: "havan-samagri", en: "Patanjali Havan Samagri", hi: "पतंजलि हवन सामग्री", mr: "पतंजली हवन साहित्य", syn: ["havan samagri", "patanjali"], u: "pack", v: [["Pack", null]], hsn: "33074100", gst: 0, brand: "Patanjali" },
  { t: "havan-kund", en: "Havan Kund (Copper)", hi: "हवन कुंड (तांबा)", mr: "होमकुंड (तांबे)", syn: ["havan kund", "hawan kund", "homa kund", "yagya kund", "हवन कुंड", "होमकुंड"], u: "pcs", v: [["6 inch", 899], ["9 inch", 1599]], hsn: "74181022", gst: 5, attrs: { material: "Copper" } },
  { t: "havan-kund", en: "Havan Kund (Iron)", hi: "हवन कुंड (लोहा)", mr: "होमकुंड (लोखंडी)", syn: ["havan kund", "iron havan kund", "हवन कुंड"], u: "pcs", v: [["9 inch", 499], ["12 inch", 799]], hsn: "73239990", gst: 5, attrs: { material: "Iron" } },
  { t: "havan-kund", en: "Havan Kund (Mitti)", hi: "हवन कुंड (मिट्टी)", mr: "होमकुंड (माती)", syn: ["havan kund", "clay havan kund", "mitti havan kund", "हवन कुंड"], u: "pcs", v: [["Small", 149], ["Medium", 249]], hsn: "69120040", gst: 0, attrs: { material: "Clay" } },
  { t: "samidha", en: "Samidha (Mixed Havan Wood)", hi: "समिधा (हवन लकड़ी)", mr: "समिधा (होमाचे लाकूड)", syn: ["samidha", "havan lakdi", "havan wood", "yagya wood", "समिधा", "हवन लकड़ी"], u: "pack", v: [["500 g", 70], ["1 kg", 130]], hsn: "44011200", gst: 5 },
  { t: "samidha", en: "Mango Wood (Aam ki Lakdi)", hi: "आम की लकड़ी", mr: "आंब्याचे लाकूड", syn: ["mango wood", "aam lakdi", "aam ki lakdi", "आम की लकड़ी", "आंब्याचे लाकूड"], u: "kg", v: [["1 kg pack", 80], ["Loose, per kg", null]], hsn: "44011200", gst: 5 },
  { t: "samidha", en: "Navgrah Samidha Set", hi: "नवग्रह समिधा सेट", mr: "नवग्रह समिधा संच", syn: ["navgrah samidha", "navagraha samidha", "navgrah lakdi", "नवग्रह समिधा"], u: "pack", v: [["Set of 9", 199]], hsn: "44011200", gst: 5 },
  { t: "samidha", en: "Kusha / Darbha Grass", hi: "कुशा घास", mr: "दर्भ", syn: ["kusha", "kush", "darbha", "darbh", "कुशा", "दर्भ"], u: "pack", v: [["Bundle", 30]], hsn: "14049090", gst: 0 },
  { t: "samidha", en: "Cow Dung Cakes (Gau Upla)", hi: "गाय के उपले", mr: "गोवऱ्या", syn: ["upla", "kande", "cow dung cake", "gobar upla", "gauvari", "उपले", "कंडे", "गोवऱ्या"], u: "pack", v: [["Pack of 10", 60], ["Pack of 25", 130]], hsn: "31010099", gst: 0 },
  { t: "havan-grain", en: "Jau (Barley) for Havan", hi: "जौ", mr: "जव", syn: ["jau", "jav", "barley", "जौ", "जव"], u: "pack", v: [["100 g", 25], ["250 g", 55]], hsn: "10039000", gst: 5, fest: ["navratri"] },
  { t: "havan-grain", en: "Kale Til (Black Sesame)", hi: "काले तिल", mr: "काळे तीळ", syn: ["kale til", "black til", "black sesame", "काले तिल", "काळे तीळ"], u: "pack", v: [["100 g", 35], ["250 g", 80]], hsn: "12074090", gst: 5, fest: ["shraddh", "makar-sankranti"] },
  { t: "havan-grain", en: "Guggal (Raw Resin)", hi: "गुग्गल", mr: "गुग्गुळ", syn: ["guggal", "guggul", "gugal", "गुग्गल", "गुग्गुळ"], u: "pack", v: [["50 g", 60], ["100 g", 110]], hsn: "13019099", gst: 5 },
  { t: "havan-ghee", en: "Havan Ghee", hi: "हवन घी", mr: "हवनाचे तूप", syn: ["havan ghee", "hawan ghee", "yagya ghee", "ghee", "घी", "तूप"], u: "ml", v: [["500 ml", 280], ["1 L", 540]], hsn: "04059020", gst: 5, edible: true },
  { t: "havan-tools", en: "Sruva (Havan Spoon)", hi: "स्रुवा (हवन चम्मच)", mr: "स्रुवा (होमाची पळी)", syn: ["sruva", "havan spoon", "aahuti spoon", "स्रुवा"], u: "pcs", v: [["Brass", 199], ["Wooden", 79]], hsn: "74181022", gst: 5 },

  /* ------------------------------------- 5. Kumkum, Roli, Tilak & Colours */
  { t: "kumkum-roli", en: "Kumkum", hi: "कुमकुम", mr: "कुंकू", syn: ["kumkum", "kumkuma", "kunku", "kanku", "कुमकुम", "कुंकू"], u: "pack", v: [["50 g", 35], ["100 g", 65]], hsn: "33049990", gst: 0 },
  { t: "kumkum-roli", en: "Kumkum (Loose)", hi: "कुमकुम खुला", mr: "कुंकू सुटे", syn: ["kumkum", "kunku", "loose kumkum", "कुमकुम", "कुंकू"], u: "kg", v: [["Loose, per kg", null]], hsn: "33049990", gst: 0, loose: true },
  { t: "kumkum-roli", en: "Roli", hi: "रोली", mr: "रोली", syn: ["roli", "tilak roli", "रोली", "kumkum"], u: "pack", v: [["25 g", 20], ["100 g", 65]], hsn: "33049990", gst: 0 },
  { t: "sindoor", en: "Hanuman Sindoor (Chola)", hi: "हनुमान सिंदूर (चोला)", mr: "मारुतीचा शेंदूर", syn: ["sindoor", "sindur", "chola", "hanuman sindoor", "orange sindoor", "shendur", "सिंदूर", "शेंदूर"], u: "pack", v: [["50 g", 30], ["100 g", 55]], hsn: "33049990", gst: 0 },
  { t: "sindoor", en: "Sindoor (Red)", hi: "सिंदूर (लाल)", mr: "सिंदूर (लाल)", syn: ["sindoor", "sindur", "red sindoor", "maang sindoor", "सिंदूर"], u: "pack", v: [["10 g", 20], ["25 g", 40]], hsn: "33049990", gst: 0 },
  { t: "haldi", en: "Puja Haldi Powder", hi: "पूजा हल्दी पाउडर", mr: "पूजेची हळद", syn: ["haldi", "turmeric", "halad", "हल्दी", "हळद"], u: "pack", v: [["50 g", 20], ["100 g", 35]], hsn: "09103030", gst: 5 },
  { t: "haldi", en: "Haldi Gaanth (Whole Turmeric)", hi: "हल्दी गांठ", mr: "हळकुंड", syn: ["haldi gaanth", "haldi gath", "whole turmeric", "halkund", "हल्दी गांठ", "हळकुंड"], u: "pack", v: [["50 g", 25], ["100 g", 45]], hsn: "09103020", gst: 5, fest: ["vivah"] },
  { t: "chandan", en: "Chandan Powder", hi: "चंदन पाउडर", mr: "चंदन पावडर", syn: ["chandan", "sandalwood powder", "sandal powder", "चंदन", "गंध"], u: "pack", v: [["10 g", 40], ["50 g", 170]], hsn: "12119099", gst: 5 },
  { t: "chandan", en: "Chandan Tika (Paste)", hi: "चंदन टीका", mr: "चंदन टिळा (गंध)", syn: ["chandan tika", "chandan tilak", "sandal paste", "gandh", "चंदन टीका", "गंध"], u: "pack", v: [["10 g", 30], ["20 g", 55]], hsn: "33079090", gst: 0 },
  { t: "chandan", en: "Ashtagandh", hi: "अष्टगंध", mr: "अष्टगंध", syn: ["ashtagandh", "asthagandha", "ashtgandh", "अष्टगंध"], u: "pack", v: [["10 g", 30], ["50 g", 120]], hsn: "33079090", gst: 5 },
  { t: "chandan", en: "Gopi Chandan", hi: "गोपी चंदन", mr: "गोपीचंदन", syn: ["gopi chandan", "gopichandan", "tilak clay", "गोपी चंदन"], u: "pack", v: [["Pack of 2 tablets", 30], ["50 g", 60]], hsn: "25070029", gst: 5 },
  { t: "vibhuti", en: "Vibhuti / Bhasma", hi: "विभूति / भस्म", mr: "विभूती / भस्म", syn: ["vibhuti", "bhasma", "bhasm", "holy ash", "राख", "विभूति", "भस्म"], u: "pack", v: [["50 g", 35], ["100 g", 60]], hsn: "33079090", gst: 5, fest: ["mahashivratri"] },
  { t: "gulal", en: "Abir (White / Pink)", hi: "अबीर", mr: "अबीर", syn: ["abir", "abeer", "अबीर", "bukka"], u: "pack", v: [["50 g", 25], ["100 g", 45]], hsn: "32129090", gst: 18 },
  ...gulal(),
  { t: "gulal", en: "Herbal Gulal Assorted Pack", hi: "हर्बल गुलाल मिक्स पैक", mr: "हर्बल गुलाल मिक्स पॅक", syn: ["gulal", "holi colours", "rang", "गुलाल"], u: "pack", v: [["4 x 100 g", 149], ["500 g", 160]], hsn: "32129090", gst: 18, fest: ["holi"] },
  { t: "akshat", en: "Akshat (Puja Rice)", hi: "अक्षत (पूजा चावल)", mr: "अक्षता", syn: ["akshat", "akshata", "puja rice", "chawal", "अक्षत", "अक्षता", "तांदूळ"], u: "pack", v: [["100 g", 20], ["250 g", 45]], hsn: "10063090", gst: 5, fest: ["vivah"] },
  { t: "sacred-thread", en: "Moli / Kalava (Raksha Sutra)", hi: "मौली / कलावा", mr: "नाडापुडी", syn: ["moli", "mauli", "kalava", "kalawa", "raksha sutra", "lal dhaga", "nadapudi", "मौली", "कलावा", "नाडापुडी"], u: "pcs", v: [["Single roll", 10], ["Bundle of 10 rolls", 85]], hsn: "56079090", gst: 0 },
  { t: "sacred-thread", en: "Janeu (Yagnopavit)", hi: "जनेऊ", mr: "जानवे", syn: ["janeu", "janeyu", "yagnopavit", "sacred thread", "poonal", "जनेऊ", "जानवे"], u: "pack", v: [["Pack of 1", 15], ["Pack of 11", 130]], hsn: "56079090", gst: 0 },

  /* -------------------------------------------- 6. Puja Thali & Utensils */
  { t: "thali", en: "Puja Thali Set (Steel)", hi: "पूजा थाली सेट (स्टील)", mr: "पूजेचे ताट संच (स्टील)", syn: ["puja thali", "pooja thali", "aarti thali", "thali set", "पूजा थाली", "ताट"], u: "pcs", v: [["7 pieces", 349], ["11 pieces", 549]], hsn: "73239390", gst: 5, attrs: { material: "Steel" } },
  { t: "thali", en: "Puja Thali Set (Brass)", hi: "पूजा थाली सेट (पीतल)", mr: "पूजेचे ताट संच (पितळी)", syn: ["puja thali", "brass thali", "pital thali", "पूजा थाली"], u: "pcs", v: [["7 pieces", 1499]], hsn: "74181022", gst: 5, attrs: { material: "Brass" } },
  { t: "thali", en: "Puja Thali Set (German Silver)", hi: "पूजा थाली सेट (जर्मन सिल्वर)", mr: "पूजेचे ताट संच (जर्मन सिल्व्हर)", syn: ["puja thali", "german silver thali", "silver thali"], u: "pcs", v: [["Decorative", 899]], hsn: "74181031", gst: 5, attrs: { material: "German Silver" } },
  { t: "thali", en: "Decorated Puja Thali", hi: "सजी हुई पूजा थाली", mr: "सजवलेले पूजेचे ताट", syn: ["decorated thali", "karva chauth thali", "aarti thali", "सजी थाली"], u: "pcs", v: [["Standard", 299]], hsn: "73239390", gst: 5, fest: ["karva-chauth", "raksha-bandhan"] },
  { t: "kalash-lota", en: "Kalash (Brass)", hi: "कलश (पीतल)", mr: "कलश (पितळी)", syn: ["kalash", "kalasha", "ghat", "कलश", "घट"], u: "pcs", v: [["Small", 349], ["Large", 899]], hsn: "74181022", gst: 5, fest: ["navratri"], attrs: { material: "Brass" } },
  { t: "kalash-lota", en: "Kalash (Copper)", hi: "कलश (तांबा)", mr: "कलश (तांबे)", syn: ["kalash", "copper kalash", "tamba kalash", "कलश"], u: "pcs", v: [["Medium", 549]], hsn: "74181022", gst: 5, attrs: { material: "Copper" } },
  { t: "kalash-lota", en: "Kalash (Steel)", hi: "कलश (स्टील)", mr: "कलश (स्टील)", syn: ["kalash", "steel kalash", "कलश"], u: "pcs", v: [["Medium", 199]], hsn: "73239390", gst: 5, attrs: { material: "Steel" } },
  { t: "kalash-lota", en: "Copper Lota", hi: "तांबे का लोटा", mr: "तांब्याचा तांब्या", syn: ["lota", "tambya", "copper lota", "jal lota", "लोटा", "तांब्या"], u: "pcs", v: [["500 ml", 399], ["1 L", 649]], hsn: "74181022", gst: 5, attrs: { material: "Copper" } },
  { t: "kalash-lota", en: "Brass Lota", hi: "पीतल का लोटा", mr: "पितळी तांब्या", syn: ["lota", "brass lota", "pital lota", "लोटा"], u: "pcs", v: [["500 ml", 449]], hsn: "74181022", gst: 5, attrs: { material: "Brass" } },
  { t: "panchpatra", en: "Panchpatra & Achmani (Brass)", hi: "पंचपात्र और आचमनी (पीतल)", mr: "पंचपात्री आणि पळी (पितळी)", syn: ["panchpatra", "panch patra", "achmani", "pali", "पंचपात्र", "पंचपात्री", "पळी"], u: "pcs", v: [["Small", 249], ["Medium", 399]], hsn: "74181022", gst: 5, attrs: { material: "Brass" } },
  { t: "panchpatra", en: "Panchpatra & Achmani (Copper)", hi: "पंचपात्र और आचमनी (तांबा)", mr: "पंचपात्री आणि पळी (तांबे)", syn: ["panchpatra", "achmani", "copper panchpatra"], u: "pcs", v: [["Small", 279]], hsn: "74181022", gst: 5, attrs: { material: "Copper" } },
  { t: "aarti", en: "Aarti Diya with Handle (Brass)", hi: "आरती दीया हैंडल सहित (पीतल)", mr: "निरांजन हँडलसह (पितळी)", syn: ["aarti diya", "aarti stand", "niranjan", "aarti lamp", "आरती", "निरांजन"], u: "pcs", v: [["5 wicks", 449], ["7 wicks", 649]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "aarti", en: "Kapur Aarti Stand (Brass)", hi: "कपूर आरती स्टैंड (पीतल)", mr: "कापूर आरती स्टँड (पितळी)", syn: ["kapur aarti", "camphor aarti", "karpur aarti", "कपूर आरती"], u: "pcs", v: [["Small", 249], ["Medium", 399]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "aarti", en: "Agarbatti Stand (Brass)", hi: "अगरबत्ती स्टैंड (पीतल)", mr: "अगरबत्ती स्टँड (पितळी)", syn: ["agarbatti stand", "incense stand", "brass stand", "अगरबत्ती स्टैंड"], u: "pcs", v: [["Plain", 149], ["Designer", 299]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "ghanti-shankh", en: "Puja Ghanti (Brass Bell)", hi: "पूजा घंटी (पीतल)", mr: "पूजेची घंटा (पितळी)", syn: ["ghanti", "bell", "puja bell", "ghanta", "घंटी", "घंटा"], u: "pcs", v: [["Size No. 1", 149], ["Size No. 2", 249], ["Size No. 4", 599]], hsn: "83061000", gst: 5, attrs: { material: "Brass" } },
  { t: "ghanti-shankh", en: "Shankh (Conch)", hi: "शंख", mr: "शंख", syn: ["shankh", "conch", "shankha", "शंख"], u: "pcs", v: [["Small", 199], ["Medium", 399], ["Large", 799]], hsn: "05080030", gst: 5 },
  { t: "ghanti-shankh", en: "Shankh Stand (Brass)", hi: "शंख स्टैंड (पीतल)", mr: "शंख स्टँड (पितळी)", syn: ["shankh stand", "conch stand", "शंख स्टैंड"], u: "pcs", v: [["Standard", 149]], hsn: "83062990", gst: 5, attrs: { material: "Brass" } },
  { t: "abhishek", en: "Abhishek Patra / Jaladhari (Brass)", hi: "अभिषेक पात्र / जलाधारी (पीतल)", mr: "अभिषेक पात्र (पितळी)", syn: ["abhishek patra", "jaladhari", "jalahari", "shivling abhishek", "अभिषेक पात्र", "जलाधारी"], u: "pcs", v: [["Small", 449], ["Medium", 749]], hsn: "74181022", gst: 5, fest: ["mahashivratri"], attrs: { material: "Brass" } },
  { t: "abhishek", en: "Abhishek Patra (Copper)", hi: "अभिषेक पात्र (तांबा)", mr: "अभिषेक पात्र (तांबे)", syn: ["abhishek patra", "copper abhishek", "अभिषेक पात्र"], u: "pcs", v: [["Medium", 699]], hsn: "74181022", gst: 5, fest: ["mahashivratri"], attrs: { material: "Copper" } },
  { t: "chowki-aasan", en: "Puja Chowki (Wooden)", hi: "पूजा चौकी (लकड़ी)", mr: "पूजेचा चौरंग (लाकडी)", syn: ["chowki", "chauki", "chaurang", "paat", "bajot", "चौकी", "चौरंग", "पाट"], u: "pcs", v: [["12 x 12 inch", 399], ["18 x 18 inch", 699]], hsn: "44209090", gst: 5, attrs: { material: "Wood" } },
  { t: "chowki-aasan", en: "Puja Aasan (Velvet)", hi: "पूजा आसन (मखमल)", mr: "पूजेचे आसन (मखमली)", syn: ["aasan", "asan", "puja mat", "आसन"], u: "pcs", v: [["Single", 149]], hsn: "63049990", gst: 5 },
  { t: "chowki-aasan", en: "Kusha Aasan", hi: "कुश आसन", mr: "दर्भाचे आसन", syn: ["kusha aasan", "kush asan", "darbha aasan", "आसन"], u: "pcs", v: [["Single", 129]], hsn: "46019900", gst: 5 },
  { t: "chowki-aasan", en: "Woollen Aasan", hi: "ऊनी आसन", mr: "लोकरीचे आसन", syn: ["woollen aasan", "ooni asan", "आसन"], u: "pcs", v: [["Single", 199]], hsn: "63041990", gst: 5 },
  { t: "puja-accessories", en: "Chandan Stone (Sahan)", hi: "चंदन घिसने का पत्थर", mr: "सहाण (गंध उगाळण्याचा दगड)", syn: ["chandan stone", "sahan", "sandal stone", "gandh dagad", "सहाण"], u: "pcs", v: [["Small", 199], ["Medium", 349]], hsn: "68029900", gst: 5 },
  { t: "puja-accessories", en: "Brass & Copper Cleaning Powder", hi: "पीतल-तांबा सफाई पाउडर", mr: "पितळ-तांबे स्वच्छता पावडर", syn: ["brass cleaner", "copper cleaner", "pital saaf", "bartan cleaner", "pitambari"], u: "pack", v: [["200 g", 55], ["500 g", 120]], hsn: "34059010", gst: 18 },
  { t: "puja-accessories", en: "Pitambari Shining Powder", hi: "पीतांबरी शाइनिंग पाउडर", mr: "पितांबरी शायनिंग पावडर", syn: ["pitambari", "brass cleaner", "copper cleaner"], u: "pack", v: [["Pack", null]], hsn: "34059010", gst: 18, brand: "Pitambari" },
  { t: "puja-accessories", en: "Katori Set (Brass)", hi: "कटोरी सेट (पीतल)", mr: "वाटी संच (पितळी)", syn: ["katori", "vati", "puja bowls", "कटोरी", "वाटी"], u: "pack", v: [["Set of 5", 399]], hsn: "74181022", gst: 5, attrs: { material: "Brass" } },
  { t: "puja-accessories", en: "Tamhan (Copper Plate)", hi: "ताम्हन (तांबे की प्लेट)", mr: "ताम्हण", syn: ["tamhan", "tamhana", "copper plate", "ताम्हण"], u: "pcs", v: [["Medium", 349]], hsn: "74181022", gst: 5, attrs: { material: "Copper" } },

  /* -------------------------------------------- 7. Murti, Photos & Yantra */
  ...murtis(),
  ...framedPhotos(),
  ...yantras(),

  /* ------------------------------------------------- 8. Vastra & Shringar */
  { t: "chunri-vastra", en: "Mata ki Chunri", hi: "माता की चुनरी", mr: "देवीची ओढणी", syn: ["chunri", "chunari", "chunni", "mata chunri", "odhni", "चुनरी", "ओढणी"], u: "pcs", v: [["Small", 49], ["Large", 99], ["Gota-patti design", 149]], hsn: "62149090", gst: 5, fest: ["navratri"] },
  { t: "chunri-vastra", en: "Ganesh Vastra & Dupatta", hi: "गणेश वस्त्र और दुपट्टा", mr: "गणपतीचे वस्त्र आणि उपरणे", syn: ["ganesh vastra", "uparne", "dupatta", "वस्त्र", "उपरणे"], u: "pcs", v: [["Small", 99]], hsn: "63079090", gst: 5, fest: ["ganesh-chaturthi"] },
  { t: "chunri-vastra", en: "Hanuman Langot (Lal)", hi: "हनुमान लंगोट (लाल)", mr: "मारुतीचा लंगोट (लाल)", syn: ["langot", "hanuman vastra", "लंगोट"], u: "pcs", v: [["Standard", 49]], hsn: "63079090", gst: 5 },
  { t: "poshak", en: "Laddu Gopal Poshak", hi: "लड्डू गोपाल पोशाक", mr: "लड्डू गोपाळ पोशाख", syn: ["laddu gopal dress", "poshak", "kanha dress", "bal gopal vastra", "पोशाक"], u: "pcs", v: [["Size 0", 99], ["Size 1-2", 149], ["Size 3-4", 199]], hsn: "63079090", gst: 5, fest: ["janmashtami"] },
  { t: "poshak", en: "Laddu Gopal Mukut", hi: "लड्डू गोपाल मुकुट", mr: "लड्डू गोपाळ मुकुट", syn: ["mukut", "crown", "kanha mukut", "मुकुट"], u: "pcs", v: [["Small", 99], ["Medium", 149]], hsn: "71171990", gst: 3, fest: ["janmashtami"] },
  { t: "poshak", en: "Mata Mukut", hi: "माता मुकुट", mr: "देवीचा मुकुट", syn: ["mukut", "mata crown", "devi mukut", "मुकुट"], u: "pcs", v: [["Standard", 199]], hsn: "71171990", gst: 3, fest: ["navratri"] },
  { t: "puja-kapda", en: "Lal Kapda (Red Puja Cloth)", hi: "लाल कपड़ा", mr: "लाल कापड", syn: ["lal kapda", "red cloth", "puja cloth", "लाल कपड़ा", "लाल कापड"], u: "pcs", v: [["1 m", 60], ["2.5 m", 140]], hsn: "52085990", gst: 5 },
  { t: "puja-kapda", en: "Peela Kapda (Yellow Puja Cloth)", hi: "पीला कपड़ा", mr: "पिवळे कापड", syn: ["peela kapda", "yellow cloth", "puja cloth", "पीला कपड़ा", "पिवळे कापड"], u: "pcs", v: [["1 m", 60], ["2.5 m", 140]], hsn: "52085990", gst: 5 },
  { t: "shringar", en: "Mata Shringar Set", hi: "माता श्रृंगार सेट", mr: "देवीचा शृंगार संच", syn: ["shringar", "shringar set", "mata shringar", "श्रृंगार", "शृंगार"], u: "pack", v: [["Small", 99], ["Big", 199]], hsn: "33049990", gst: 5, fest: ["navratri"] },
  { t: "shringar", en: "Solah Shringar Kit", hi: "सोलह श्रृंगार किट", mr: "सोळा शृंगार किट", syn: ["solah shringar", "16 shringar", "suhag kit", "सोलह श्रृंगार"], u: "pack", v: [["Standard", 299]], hsn: "33049990", gst: 5, fest: ["karva-chauth", "vivah"] },
  { t: "shringar", en: "Bindi", hi: "बिंदी", mr: "टिकली", syn: ["bindi", "tikli", "बिंदी", "टिकली"], u: "pack", v: [["Small pack", 20], ["Big pack", 40]], hsn: "33049940", gst: 0 },
  { t: "shringar", en: "Glass Choodi (Bangles)", hi: "कांच की चूड़ी", mr: "काचेच्या बांगड्या", syn: ["choodi", "chudi", "bangles", "bangadi", "चूड़ी", "बांगड्या"], u: "dozen", v: [["Red, 1 dozen", 60], ["Green, 1 dozen", 60]], hsn: "70189010", gst: 0, fest: ["karva-chauth", "vivah"] },
  { t: "shringar", en: "Mehendi Powder", hi: "मेहंदी पाउडर", mr: "मेंदी पावडर", syn: ["mehendi", "mehndi", "henna", "मेहंदी", "मेंदी"], u: "pack", v: [["100 g", 40], ["250 g", 90]], hsn: "14049040", gst: 5, fest: ["karva-chauth", "vivah"] },
  { t: "shringar", en: "Mehendi Cones", hi: "मेहंदी कोन", mr: "मेंदी कोन", syn: ["mehendi cone", "henna cone", "मेहंदी कोन"], u: "pack", v: [["Pack of 6", 60]], hsn: "33059090", gst: 5, fest: ["karva-chauth", "vivah"] },
  { t: "shringar", en: "Kajal", hi: "काजल", mr: "काजळ", syn: ["kajal", "kajol", "काजल", "काजळ"], u: "pcs", v: [["5 g", 40], ["10 g", 70]], hsn: "33042000", gst: 18 },
  { t: "shringar", en: "Sindoor Dibbi", hi: "सिंदूर डिब्बी", mr: "कुंकवाचा करंडा", syn: ["sindoor dibbi", "sindoor box", "kunku karanda", "करंडा", "डिब्बी"], u: "pcs", v: [["Wooden", 79], ["Brass", 199]], hsn: "44209090", gst: 5 },
  { t: "toran", en: "Artificial Marigold Toran", hi: "आर्टिफिशियल गेंदा तोरण", mr: "कृत्रिम झेंडू तोरण", syn: ["toran", "door hanging", "bandhanwar", "marigold toran", "तोरण", "बंदनवार"], u: "pcs", v: [["Single", 149]], hsn: "67029090", gst: 18, fest: ["diwali", "griha-pravesh"] },
  { t: "toran", en: "Beaded Toran (Handmade)", hi: "मोती तोरण", mr: "मण्यांचे तोरण", syn: ["toran", "beaded toran", "bandhanwar", "तोरण"], u: "pcs", v: [["Single", 249]], hsn: "63079090", gst: 5, fest: ["diwali"] },
  { t: "toran", en: "Mango-leaf Design Toran", hi: "आम पत्ता डिज़ाइन तोरण", mr: "आंब्याच्या पानांचे तोरण", syn: ["toran", "mango leaf toran", "aam patta toran", "तोरण"], u: "pcs", v: [["Single", 199]], hsn: "63079090", gst: 5, fest: ["griha-pravesh", "diwali"] },

  /* ------------------------------------------ 9. Phool & Patte (perishable) */
  { t: "garland", en: "Marigold Garland (Genda Mala)", hi: "गेंदे की माला", mr: "झेंडूचा हार", syn: ["genda", "marigold", "genda phool mala", "zendu", "garland", "haar", "गेंदा", "झेंडू", "हार", "माला"], u: "pcs", v: [["Small, per piece", null], ["Large (3 ft), per piece", null]], hsn: "06031900", gst: 0, loose: true, perishable: true, fest: ["diwali", "ganesh-chaturthi"] },
  { t: "fresh-flowers", en: "Marigold Flowers (Loose)", hi: "गेंदे के फूल (खुले)", mr: "झेंडूची फुले (सुटी)", syn: ["genda", "marigold", "zendu", "phool", "गेंदा", "झेंडू", "फूल", "फुले"], u: "kg", v: [["Loose, per kg", null]], hsn: "06031900", gst: 0, loose: true, perishable: true, fest: ["diwali", "ganesh-chaturthi"] },
  { t: "fresh-flowers", en: "Rose Petals (Loose)", hi: "गुलाब की पंखुड़ियाँ", mr: "गुलाबाच्या पाकळ्या", syn: ["rose petals", "gulab pankhudi", "gulab", "गुलाब", "पंखुड़ी", "पाकळ्या"], u: "g", v: [["Loose, per 100 g", null]], hsn: "06031100", gst: 0, loose: true, perishable: true },
  { t: "fresh-flowers", en: "Rose Flowers", hi: "गुलाब के फूल", mr: "गुलाबाची फुले", syn: ["rose", "gulab", "गुलाब"], u: "dozen", v: [["Loose, per dozen", null]], hsn: "06031100", gst: 0, loose: true, perishable: true },
  { t: "garland", en: "Rose Garland", hi: "गुलाब की माला", mr: "गुलाबाचा हार", syn: ["rose garland", "gulab mala", "haar", "गुलाब माला", "हार"], u: "pcs", v: [["Loose, per piece", null]], hsn: "06031100", gst: 0, loose: true, perishable: true, fest: ["vivah"] },
  { t: "garland", en: "Mixed Flower Haar (for Murti)", hi: "मिक्स फूल हार (मूर्ति के लिए)", mr: "मिश्र फुलांचा हार (मूर्तीसाठी)", syn: ["haar", "phool mala", "garland", "हार", "माला"], u: "pcs", v: [["Loose, per piece", null]], hsn: "06031900", gst: 0, loose: true, perishable: true },
  { t: "fresh-flowers", en: "Lotus Flower", hi: "कमल का फूल", mr: "कमळ", syn: ["lotus", "kamal", "kamal phool", "कमल", "कमळ"], u: "pcs", v: [["Loose, per piece", null]], hsn: "06031900", gst: 0, loose: true, perishable: true, fest: ["diwali"] },
  { t: "fresh-flowers", en: "Mogra Flowers / Gajra", hi: "मोगरा फूल / गजरा", mr: "मोगऱ्याची फुले / गजरा", syn: ["mogra", "gajra", "jasmine", "मोगरा", "गजरा"], u: "pcs", v: [["Loose, per gajra", null]], hsn: "06031900", gst: 0, loose: true, perishable: true },
  { t: "fresh-flowers", en: "Hibiscus (Jaswand / Gudhal)", hi: "गुड़हल का फूल", mr: "जास्वंद", syn: ["hibiscus", "gudhal", "jaswand", "jasud", "गुड़हल", "जास्वंद"], u: "pcs", v: [["Loose, per 11 flowers", null]], hsn: "06031900", gst: 0, loose: true, perishable: true, fest: ["ganesh-chaturthi", "navratri"] },
  { t: "fresh-flowers", en: "Rajnigandha (Tuberose) Sticks", hi: "रजनीगंधा", mr: "निशिगंध", syn: ["rajnigandha", "tuberose", "nishigandh", "रजनीगंधा", "निशिगंध"], u: "pcs", v: [["Loose, per bunch", null]], hsn: "06031900", gst: 0, loose: true, perishable: true },
  { t: "leaves", en: "Tulsi Leaves", hi: "तुलसी पत्ते", mr: "तुळशीची पाने", syn: ["tulsi", "tulasi", "holy basil", "तुलसी", "तुळस"], u: "pcs", v: [["Loose, per bunch", null]], hsn: "06042000", gst: 0, loose: true, perishable: true },
  { t: "leaves", en: "Bel Patra", hi: "बेल पत्र", mr: "बेलपत्र", syn: ["bel patra", "bilva", "bel patta", "bilva patra", "बेल पत्र", "बेलपत्र", "बेल"], u: "pcs", v: [["Loose, per 21 leaves", null]], hsn: "06042000", gst: 0, loose: true, perishable: true, fest: ["mahashivratri"] },
  { t: "leaves", en: "Durva Grass", hi: "दूर्वा घास", mr: "दुर्वा", syn: ["durva", "doob", "durba", "दूर्वा", "दूब", "दुर्वा"], u: "pcs", v: [["Loose, per 21 blades", null]], hsn: "06042000", gst: 0, loose: true, perishable: true, fest: ["ganesh-chaturthi"] },
  { t: "leaves", en: "Mango Leaves", hi: "आम के पत्ते", mr: "आंब्याची पाने", syn: ["mango leaves", "aam ke patte", "ambyachi pane", "आम पत्ते", "आंब्याची पाने"], u: "pcs", v: [["Loose, per bunch", null]], hsn: "06042000", gst: 0, loose: true, perishable: true, fest: ["griha-pravesh", "navratri"] },
  { t: "leaves", en: "Banana Leaves", hi: "केले के पत्ते", mr: "केळीची पाने", syn: ["banana leaf", "kele ka patta", "keli pan", "केले के पत्ते", "केळीचे पान"], u: "pcs", v: [["Loose, per piece", null], ["Loose, per 10 pieces", null]], hsn: "14049090", gst: 0, loose: true, perishable: true, fest: ["satyanarayan"] },
  { t: "artificial-garland", en: "Artificial Marigold Garland", hi: "आर्टिफिशियल गेंदा माला", mr: "कृत्रिम झेंडू हार", syn: ["artificial garland", "plastic mala", "genda mala", "marigold", "माला", "हार"], u: "pcs", v: [["Single (5 ft)", 79], ["Pack of 5", 349]], hsn: "67021000", gst: 18, fest: ["diwali"] },
  { t: "artificial-garland", en: "Artificial Rose Garland", hi: "आर्टिफिशियल गुलाब माला", mr: "कृत्रिम गुलाब हार", syn: ["artificial garland", "rose mala", "plastic garland", "माला"], u: "pcs", v: [["Single (5 ft)", 99]], hsn: "67021000", gst: 18 },
  { t: "artificial-garland", en: "Artificial Murti Haar (Pearl & Flower)", hi: "मूर्ति हार (मोती व फूल)", mr: "मूर्तीचा हार (मोती व फुले)", syn: ["murti haar", "idol garland", "pearl mala", "हार"], u: "pcs", v: [["Small", 79], ["Medium", 149]], hsn: "67029090", gst: 18 },

  /* ------------------------------------ 10. Prasad & Puja Dry Items (edible) */
  { t: "nariyal", en: "Puja Nariyal (Whole Coconut)", hi: "पूजा नारियल", mr: "पूजेचा नारळ", syn: ["nariyal", "coconut", "naral", "shriphal", "नारियल", "नारळ", "श्रीफल"], u: "pcs", v: [["Loose, per piece", null]], hsn: "08011990", gst: 0, loose: true, edible: true, fest: ["satyanarayan", "navratri", "griha-pravesh"] },
  { t: "nariyal", en: "Sukha Nariyal (Copra Gola)", hi: "सूखा नारियल (गोला)", mr: "सुके खोबरे (वाटी)", syn: ["gola", "copra", "dry coconut", "khobra", "सूखा नारियल", "खोबरे"], u: "pcs", v: [["Single gola", 45], ["250 g", 90]], hsn: "08011100", gst: 5, edible: true },
  { t: "supari-spices", en: "Puja Supari (Whole)", hi: "पूजा सुपारी", mr: "पूजेची सुपारी", syn: ["supari", "betel nut", "areca nut", "सुपारी"], u: "pack", v: [["50 g", 40], ["250 g", 180]], hsn: "08028010", gst: 5, edible: true },
  { t: "supari-spices", en: "Laung (Cloves)", hi: "लौंग", mr: "लवंग", syn: ["laung", "long", "lavang", "cloves", "लौंग", "लवंग"], u: "pack", v: [["10 g", 25], ["50 g", 105]], hsn: "09071000", gst: 5, edible: true },
  { t: "supari-spices", en: "Elaichi (Green Cardamom)", hi: "इलायची", mr: "वेलची", syn: ["elaichi", "ilaichi", "cardamom", "velchi", "इलायची", "वेलची"], u: "pack", v: [["10 g", 40], ["50 g", 185]], hsn: "09083120", gst: 5, edible: true },
  { t: "mishri-batasha", en: "Mishri (Dhaga / Crystal)", hi: "मिश्री", mr: "खडीसाखर", syn: ["mishri", "misri", "khadi sakhar", "rock sugar", "sugar candy", "मिश्री", "खडीसाखर"], u: "pack", v: [["100 g", 25], ["500 g", 100]], hsn: "17019990", gst: 5, edible: true },
  { t: "mishri-batasha", en: "Batasha", hi: "बताशा", mr: "बत्तासे", syn: ["batasha", "batashe", "patasha", "battase", "बताशा", "बत्तासे"], u: "pack", v: [["100 g", 20], ["500 g", 85]], hsn: "17049090", gst: 5, edible: true, fest: ["diwali"] },
  { t: "mishri-batasha", en: "Batasha (Loose)", hi: "बताशा खुला", mr: "बत्तासे सुटे", syn: ["batasha", "loose batasha", "बताशा"], u: "kg", v: [["Loose, per kg", null]], hsn: "17049090", gst: 5, edible: true, loose: true },
  { t: "mishri-batasha", en: "Elaichi Dana", hi: "इलायची दाना", mr: "वेलची दाणे", syn: ["elaichi dana", "ilaichi dana", "prasad dana", "इलायची दाना"], u: "pack", v: [["100 g", 30], ["250 g", 65]], hsn: "17049090", gst: 5, edible: true },
  { t: "mishri-batasha", en: "Kheel (Puffed Rice) for Lakshmi Puja", hi: "खील", mr: "लाह्या", syn: ["kheel", "khil", "lahya", "puffed rice", "खील", "लाह्या"], u: "pack", v: [["100 g", 20], ["250 g", 40]], hsn: "19041090", gst: 0, edible: true, fest: ["diwali"] },
  { t: "mishri-batasha", en: "Gud (Jaggery)", hi: "गुड़", mr: "गूळ", syn: ["gud", "gur", "jaggery", "gul", "गुड़", "गूळ"], u: "pack", v: [["250 g", 30], ["500 g", 55]], hsn: "17011410", gst: 0, edible: true },
  { t: "dry-fruits", en: "Makhana (Fox Nuts)", hi: "मखाना", mr: "मखाणा", syn: ["makhana", "makhane", "fox nut", "lotus seeds", "मखाना", "मखाणा"], u: "pack", v: [["100 g", 130], ["250 g", 310]], hsn: "20081990", gst: 5, edible: true, fest: ["janmashtami", "navratri"] },
  { t: "dry-fruits", en: "Panchmeva (Mixed Dry Fruits)", hi: "पंचमेवा", mr: "पंचमेवा", syn: ["panchmeva", "panch meva", "dry fruits", "mewa", "पंचमेवा", "मेवा"], u: "pack", v: [["100 g", 120], ["500 g", 560]], hsn: "08135000", gst: 5, edible: true, fest: ["satyanarayan", "janmashtami"] },
  { t: "dry-fruits", en: "Chironji", hi: "चिरौंजी", mr: "चारोळी", syn: ["chironji", "charoli", "charoli seeds", "चिरौंजी", "चारोळी"], u: "pack", v: [["50 g", 115], ["100 g", 220]], hsn: "08029900", gst: 5, edible: true },
  { t: "dry-fruits", en: "Kharik (Dry Dates)", hi: "छुहारा", mr: "खारीक", syn: ["kharik", "chhuhara", "dry dates", "खारीक", "छुहारा"], u: "pack", v: [["100 g", 50], ["250 g", 120]], hsn: "08041020", gst: 5, edible: true, fest: ["vivah"] },
  { t: "kesar-shahad", en: "Kesar (Saffron)", hi: "केसर", mr: "केशर", syn: ["kesar", "keshar", "saffron", "केसर", "केशर"], u: "pack", v: [["1 g", 290], ["2 g", 560]], hsn: "09102010", gst: 5, edible: true },
  { t: "kesar-shahad", en: "Shahad (Honey)", hi: "शहद", mr: "मध", syn: ["shahad", "honey", "madh", "शहद", "मध"], u: "pack", v: [["100 g", 70], ["250 g", 160]], hsn: "04090000", gst: 5, edible: true },
  { t: "gangajal-panchamrit", en: "Gangajal", hi: "गंगाजल", mr: "गंगाजल", syn: ["gangajal", "ganga jal", "ganga water", "holy water", "गंगाजल", "गंगा जल"], u: "ml", v: [["100 ml", 20], ["500 ml", 70], ["1 L", 120]], hsn: "22019090", gst: 0, edible: true },
  { t: "gangajal-panchamrit", en: "Panchamrit Kit", hi: "पंचामृत किट", mr: "पंचामृत किट", syn: ["panchamrit", "panchamrut", "panchamritam", "पंचामृत"], u: "pack", v: [["Kit", 149]], hsn: "04059020", gst: 0, edible: true, fest: ["satyanarayan", "janmashtami"] },
  { t: "paan", en: "Paan Leaves (Betel / Vida)", hi: "पान के पत्ते", mr: "विड्याची पाने", syn: ["paan", "pan", "betel leaf", "vida", "nagvel", "पान", "विड्याची पाने"], u: "pcs", v: [["Loose, per 5 leaves", null]], hsn: "14049060", gst: 0, loose: true, perishable: true, edible: true, fest: ["satyanarayan", "vivah"] },

  /* ---------------------------------------------------- 11. Mala & Rudraksha */
  { t: "jap-mala", en: "Rudraksha Mala (108+1)", hi: "रुद्राक्ष माला (108+1)", mr: "रुद्राक्ष माळ (108+1)", syn: ["rudraksha mala", "rudraksh mala", "jap mala", "japa mala", "रुद्राक्ष माला", "जपमाळ"], u: "pcs", v: [["5 mukhi, small beads", 199], ["5 mukhi, medium beads", 349], ["54 beads", 149]], hsn: "14049090", gst: 0, fest: ["mahashivratri"] },
  { t: "jap-mala", en: "Tulsi Mala", hi: "तुलसी माला", mr: "तुळशीची माळ", syn: ["tulsi mala", "tulasi mala", "tulsi kanthi", "kanthi mala", "तुलसी माला", "तुळशीमाळ"], u: "pcs", v: [["108 beads jap mala", 99], ["Kanthi (single round)", 49], ["Kanthi (double round)", 79]], hsn: "14049090", gst: 0 },
  { t: "jap-mala", en: "Sphatik Mala", hi: "स्फटिक माला", mr: "स्फटिक माळ", syn: ["sphatik", "sphatik mala", "crystal mala", "quartz mala", "स्फटिक"], u: "pcs", v: [["6 mm beads", 299], ["8 mm beads", 449]], hsn: "71162000", gst: 3 },
  { t: "jap-mala", en: "Chandan Mala (Sandalwood)", hi: "चंदन माला", mr: "चंदन माळ", syn: ["chandan mala", "sandalwood mala", "चंदन माला"], u: "pcs", v: [["108 beads", 249]], hsn: "44209090", gst: 5 },
  { t: "jap-mala", en: "Rakt Chandan Mala (Red Sandalwood)", hi: "रक्त चंदन माला", mr: "रक्तचंदन माळ", syn: ["rakt chandan", "red sandalwood mala", "lal chandan mala", "रक्त चंदन"], u: "pcs", v: [["108 beads", 299]], hsn: "44209090", gst: 5 },
  { t: "jap-mala", en: "Kamal Gatta Mala", hi: "कमल गट्टा माला", mr: "कमळ गट्टा माळ", syn: ["kamal gatta", "lotus seed mala", "lakshmi mala", "कमल गट्टा"], u: "pcs", v: [["108 beads", 149]], hsn: "14049090", gst: 5, fest: ["diwali"] },
  { t: "jap-mala", en: "Vaijanti Mala", hi: "वैजयंती माला", mr: "वैजयंती माळ", syn: ["vaijanti", "vaijayanti mala", "वैजयंती"], u: "pcs", v: [["108 beads", 149]], hsn: "14049090", gst: 5 },
  { t: "jap-mala", en: "Haldi Mala", hi: "हल्दी माला", mr: "हळदीची माळ", syn: ["haldi mala", "turmeric mala", "हल्दी माला"], u: "pcs", v: [["108 beads", 149]], hsn: "14049090", gst: 5 },
  { t: "rudraksha", en: "Rudraksha Bead – 5 Mukhi", hi: "रुद्राक्ष – 5 मुखी", mr: "रुद्राक्ष – 5 मुखी", syn: ["rudraksha", "rudraksh", "panchmukhi rudraksha", "5 mukhi", "रुद्राक्ष"], u: "pcs", v: [["Single bead", 49], ["Pack of 5", 199]], hsn: "14049090", gst: 0 },
  { t: "rudraksha", en: "Rudraksha Bead – 6 Mukhi", hi: "रुद्राक्ष – 6 मुखी", mr: "रुद्राक्ष – 6 मुखी", syn: ["rudraksha", "6 mukhi", "रुद्राक्ष"], u: "pcs", v: [["Single bead", 149]], hsn: "14049090", gst: 0 },
  { t: "rudraksha", en: "Rudraksha Bead – 7 Mukhi", hi: "रुद्राक्ष – 7 मुखी", mr: "रुद्राक्ष – 7 मुखी", syn: ["rudraksha", "7 mukhi", "रुद्राक्ष"], u: "pcs", v: [["Single bead", 349]], hsn: "14049090", gst: 0 },
  { t: "rudraksha", en: "Gauri Shankar Rudraksha", hi: "गौरी शंकर रुद्राक्ष", mr: "गौरी शंकर रुद्राक्ष", syn: ["gauri shankar", "rudraksha", "गौरी शंकर"], u: "pcs", v: [["Single", null]], hsn: "14049090", gst: 0 },
  { t: "gomukhi", en: "Gomukhi (Jap Mala Bag)", hi: "गोमुखी", mr: "गोमुखी", syn: ["gomukhi", "jap bag", "mala bag", "गोमुखी"], u: "pcs", v: [["Cotton", 79], ["Velvet", 129]], hsn: "63079090", gst: 5 },

  /* ------------------------------------------------------ 12. Ready Puja Kits */
  ...pujaKits(),

  /* ----------------------------------------------------- 13. Festival Items */
  { t: "rangoli", en: "Rangoli Colours Set", hi: "रंगोली रंग सेट", mr: "रांगोळी रंग संच", syn: ["rangoli", "rangoli colour", "rangoli powder", "रंगोली", "रांगोळी"], u: "pack", v: [["Set of 5 x 100 g", 99], ["Set of 10 x 100 g", 179]], hsn: "32129090", gst: 18, fest: ["diwali"] },
  { t: "rangoli", en: "White Rangoli Powder", hi: "सफ़ेद रंगोली पाउडर", mr: "पांढरी रांगोळी", syn: ["rangoli", "white rangoli", "safed rangoli", "रांगोळी", "रंगोली"], u: "pack", v: [["500 g", 40], ["1 kg", 70]], hsn: "25171090", gst: 5, fest: ["diwali"] },
  { t: "rangoli", en: "White Rangoli (Loose)", hi: "सफ़ेद रंगोली खुली", mr: "पांढरी रांगोळी सुटी", syn: ["rangoli", "loose rangoli", "रांगोळी"], u: "kg", v: [["Loose, per kg", null]], hsn: "25171090", gst: 5, loose: true, fest: ["diwali"] },
  { t: "rangoli", en: "Rangoli Stencils", hi: "रंगोली स्टेंसिल", mr: "रांगोळी छाप (स्टेन्सिल)", syn: ["rangoli stencil", "rangoli sancha", "rangoli chhap", "स्टेंसिल", "छाप"], u: "pack", v: [["Set of 8", 179]], hsn: "39269099", gst: 18, fest: ["diwali"] },
  { t: "rangoli", en: "Rangoli Pen / Filler Tool", hi: "रंगोली पेन", mr: "रांगोळी पेन", syn: ["rangoli pen", "rangoli tool", "rangoli filler"], u: "pcs", v: [["Single", 49]], hsn: "39269099", gst: 18, fest: ["diwali"] },
  { t: "kandil", en: "Paper Kandil (Akash Kandil)", hi: "कागज़ का कंदील", mr: "कागदी आकाशकंदील", syn: ["kandil", "kandeel", "akash kandil", "lantern", "diwali lantern", "कंदील", "आकाशकंदील"], u: "pcs", v: [["Small", 149], ["Large", 299]], hsn: "48239090", gst: 18, fest: ["diwali"] },
  { t: "kandil", en: "Cloth Kandil", hi: "कपड़े का कंदील", mr: "कापडी आकाशकंदील", syn: ["kandil", "cloth lantern", "fabric kandil", "कंदील"], u: "pcs", v: [["Medium", 349]], hsn: "63079090", gst: 5, fest: ["diwali"] },
  { t: "kandil", en: "LED Kandil", hi: "एलईडी कंदील", mr: "एलईडी आकाशकंदील", syn: ["kandil", "led lantern", "electric kandil", "कंदील"], u: "pcs", v: [["Medium", 449]], hsn: "94054900", gst: 18, fest: ["diwali"] },
  { t: "decor-diya", en: "Decorative Kundan Diya", hi: "कुंदन सजावटी दीया", mr: "कुंदन सजावटी पणती", syn: [...DIYA_SYN, "kundan diya", "decorative diya", "designer diya"], u: "pack", v: [["Pack of 4", 199], ["Pack of 6", 279]], hsn: "69139000", gst: 5, fest: ["diwali"] },
  { t: "decor-diya", en: "Floating Wax Diyas", hi: "तैरने वाले दीये", mr: "पाण्यावर तरंगणाऱ्या पणत्या", syn: [...DIYA_SYN, "floating diya", "floating candle", "urli diya"], u: "pack", v: [["Pack of 6", 149]], hsn: "34060010", gst: 5, fest: ["diwali"] },
  { t: "rakhi", en: "Thread Rakhi", hi: "धागा राखी", mr: "धाग्याची राखी", syn: ["rakhi", "raksha bandhan", "राखी"], u: "pcs", v: [["Single", 20], ["Pack of 3", 50]], hsn: "63079090", gst: 0, fest: ["raksha-bandhan"] },
  { t: "rakhi", en: "Designer Rakhi", hi: "डिज़ाइनर राखी", mr: "डिझायनर राखी", syn: ["rakhi", "designer rakhi", "राखी"], u: "pcs", v: [["Single", 60]], hsn: "63079090", gst: 0, fest: ["raksha-bandhan"] },
  { t: "rakhi", en: "Rakhi with Roli-Chawal Pack", hi: "राखी रोली-चावल सहित", mr: "राखी रोली-तांदूळसह", syn: ["rakhi", "rakhi set", "roli chawal", "राखी"], u: "pack", v: [["Set", 70]], hsn: "63079090", gst: 0, fest: ["raksha-bandhan"] },
  { t: "til-items", en: "Tilgul Ladoo", hi: "तिल-गुड़ लड्डू", mr: "तिळगूळ लाडू", syn: ["tilgul", "til ladoo", "til gud", "til laddu", "तिलगुड़", "तिळगूळ"], u: "pack", v: [["200 g", 70], ["500 g", 160]], hsn: "17049090", gst: 5, edible: true, fest: ["makar-sankranti"] },
  { t: "til-items", en: "Til Chikki", hi: "तिल चिक्की", mr: "तिळाची चिक्की", syn: ["til chikki", "sesame chikki", "chikki", "तिल चिक्की"], u: "pack", v: [["200 g", 60]], hsn: "17049090", gst: 5, edible: true, fest: ["makar-sankranti"] },
  { t: "til-items", en: "Tilgul Halwa (Sugar-coated Til)", hi: "तिलगुल हलवा", mr: "तिळगूळ हलवा", syn: ["tilgul halwa", "halwa", "sankranti halwa", "हलवा"], u: "pack", v: [["100 g", 40], ["250 g", 90]], hsn: "17049090", gst: 5, edible: true, fest: ["makar-sankranti"] },
  { t: "ganesh-utsav", en: "Eco-friendly Seed Ganesh (Plantable)", hi: "इको-फ्रेंडली बीज गणेश", mr: "पर्यावरणपूरक बीज गणपती", syn: ["eco ganesh", "seed ganesh", "plantable ganpati", "eco friendly ganpati", "गणपती", "गणेश"], u: "pcs", v: [["8 inch", 699], ["12 inch", 1199]], hsn: "69139000", gst: 5, fest: ["ganesh-chaturthi"] },
  { t: "ganesh-utsav", en: "Modak Mould", hi: "मोदक सांचा", mr: "मोदकाचा साचा", syn: ["modak mould", "modak sancha", "modak maker", "मोदक साचा"], u: "pcs", v: [["Plastic, 11 modak", 149], ["Brass, single", 299]], hsn: "39241090", gst: 18, fest: ["ganesh-chaturthi"] },
  { t: "jhula", en: "Laddu Gopal Jhula", hi: "लड्डू गोपाल झूला", mr: "लड्डू गोपाळ पाळणा", syn: ["jhula", "palna", "krishna jhula", "laddu gopal swing", "झूला", "पाळणा"], u: "pcs", v: [["Small (brass)", 499], ["Medium (wooden, decorated)", 799]], hsn: "83062990", gst: 5, fest: ["janmashtami"] },
  { t: "shubh-stickers", en: "Swastik & Shubh-Labh Stickers", hi: "स्वास्तिक और शुभ-लाभ स्टिकर", mr: "स्वस्तिक आणि शुभ-लाभ स्टिकर", syn: ["swastik sticker", "shubh labh", "subh labh", "स्वास्तिक", "शुभ लाभ"], u: "pack", v: [["Pack", 49]], hsn: "49119990", gst: 18, fest: ["diwali", "griha-pravesh"] },
  { t: "shubh-stickers", en: "Om Sticker (Gold Foil)", hi: "ॐ स्टिकर", mr: "ॐ स्टिकर", syn: ["om sticker", "aum sticker", "ॐ"], u: "pack", v: [["Pack", 39]], hsn: "49119990", gst: 18 },
  { t: "shubh-stickers", en: "Lakshmi Charan (Footprint) Stickers", hi: "लक्ष्मी चरण स्टिकर", mr: "लक्ष्मीची पावले स्टिकर", syn: ["lakshmi charan", "laxmi paduka", "footprint sticker", "लक्ष्मी चरण", "पावले"], u: "pack", v: [["Pack", 59]], hsn: "49119990", gst: 18, fest: ["diwali"] },

  /* --------------------------------------- 14. Religious Books & Stationery */
  { t: "religious-books", en: "Hanuman Chalisa", hi: "हनुमान चालीसा", mr: "हनुमान चालीसा", syn: ["hanuman chalisa", "chalisa", "हनुमान चालीसा"], u: "pcs", v: [["Pocket size", 15], ["Large print", 40]], hsn: "49011010", gst: 0 },
  { t: "religious-books", en: "Shrimad Bhagavad Gita", hi: "श्रीमद्भगवद्गीता", mr: "श्रीमद्भगवद्गीता", syn: ["gita", "geeta", "bhagavad gita", "bhagwat geeta", "गीता"], u: "pcs", v: [["Hindi, pocket", 40], ["Hindi, with meaning", 180], ["Marathi", 180]], hsn: "49011010", gst: 0 },
  { t: "religious-books", en: "Aarti Sangrah", hi: "आरती संग्रह", mr: "आरती संग्रह", syn: ["aarti sangrah", "aarti book", "aarti", "आरती संग्रह"], u: "pcs", v: [["Hindi", 30], ["Marathi", 30]], hsn: "49011010", gst: 0, fest: ["ganesh-chaturthi"] },
  { t: "religious-books", en: "Sundarkand", hi: "सुंदरकांड", mr: "सुंदरकांड", syn: ["sundarkand", "sunderkand", "सुंदरकांड"], u: "pcs", v: [["Hindi", 40]], hsn: "49011010", gst: 0 },
  { t: "religious-books", en: "Durga Saptashati", hi: "दुर्गा सप्तशती", mr: "दुर्गा सप्तशती", syn: ["durga saptashati", "chandi path", "durga path", "दुर्गा सप्तशती"], u: "pcs", v: [["Sanskrit-Hindi", 90]], hsn: "49011010", gst: 0, fest: ["navratri"] },
  { t: "religious-books", en: "Satyanarayan Vrat Katha", hi: "सत्यनारायण व्रत कथा", mr: "सत्यनारायण व्रतकथा", syn: ["satyanarayan katha", "vrat katha", "सत्यनारायण कथा"], u: "pcs", v: [["Hindi", 20], ["Marathi", 20]], hsn: "49011010", gst: 0, fest: ["satyanarayan"] },
  { t: "religious-books", en: "Shri Ram Raksha Stotra", hi: "श्री राम रक्षा स्तोत्र", mr: "श्रीरामरक्षा स्तोत्र", syn: ["ram raksha", "ramraksha", "राम रक्षा", "रामरक्षा"], u: "pcs", v: [["Pocket", 15]], hsn: "49011010", gst: 0 },
  { t: "religious-books", en: "Vishnu Sahasranama", hi: "विष्णु सहस्रनाम", mr: "विष्णुसहस्रनाम", syn: ["vishnu sahasranama", "sahasranaam", "विष्णु सहस्रनाम"], u: "pcs", v: [["Pocket", 25]], hsn: "49011010", gst: 0 },
  { t: "religious-books", en: "Shiv Chalisa & Aarti", hi: "शिव चालीसा और आरती", mr: "शिव चालीसा आणि आरती", syn: ["shiv chalisa", "chalisa", "शिव चालीसा"], u: "pcs", v: [["Pocket", 15]], hsn: "49011010", gst: 0, fest: ["mahashivratri"] },
  { t: "panchang", en: "Hindi Panchang", hi: "हिंदी पंचांग", mr: "हिंदी पंचांग", syn: ["panchang", "patra", "hindu calendar", "पंचांग"], u: "pcs", v: [["Yearly", 60]], hsn: "49100010", gst: 5 },
  { t: "panchang", en: "Marathi Wall Calendar (Dinadarshika)", hi: "मराठी दीवार कैलेंडर", mr: "मराठी दिनदर्शिका", syn: ["calendar", "dinadarshika", "marathi calendar", "दिनदर्शिका", "कॅलेंडर"], u: "pcs", v: [["Yearly", 60]], hsn: "49100010", gst: 5 },
  { t: "bahi-khata", en: "Lal Bahi-Khata (Diwali Ledger)", hi: "लाल बही-खाता", mr: "लाल वही-खाते (चोपडी)", syn: ["bahi khata", "bahi", "ledger", "chopda", "chopdi", "बही खाता", "चोपडी"], u: "pcs", v: [["Small", 99], ["Large", 199]], hsn: "48201010", gst: 5, fest: ["diwali"] },
  { t: "bahi-khata", en: "Diwali Chopda Puja Set", hi: "दिवाली चोपड़ा पूजन सेट", mr: "दिवाळी चोपडी पूजन संच", syn: ["chopda pujan", "bahi pujan", "muhurat", "चोपडा पूजन"], u: "pack", v: [["Set", 299]], hsn: "48201010", gst: 5, fest: ["diwali"] },
  { t: "bahi-khata", en: "Lal Pen (Red Pen)", hi: "लाल पेन", mr: "लाल पेन", syn: ["red pen", "lal pen", "लाल पेन"], u: "pcs", v: [["Pack of 5", 45]], hsn: "96081019", gst: 18, fest: ["diwali"] },
  { t: "matchbox-lighter", en: "Matchbox", hi: "माचिस", mr: "काडेपेटी", syn: ["matchbox", "machis", "matches", "kadepeti", "माचिस", "काडेपेटी"], u: "pack", v: [["Pack of 10 boxes", 20]], hsn: "36050010", gst: 5 },
  { t: "matchbox-lighter", en: "Gas Lighter (Long Nozzle)", hi: "गैस लाइटर (लंबा)", mr: "गॅस लायटर (लांब)", syn: ["lighter", "gas lighter", "diya lighter", "लाइटर", "लायटर"], u: "pcs", v: [["Single", 99]], hsn: "96131000", gst: 18 },
  { t: "matchbox-lighter", en: "Pocket Lighter", hi: "पॉकेट लाइटर", mr: "पॉकेट लायटर", syn: ["lighter", "pocket lighter", "लाइटर"], u: "pcs", v: [["Single", 20]], hsn: "96131000", gst: 18 },
  { t: "mantra-booklets", en: "Mantra Cards (Gayatri, Mahamrityunjay, Hanuman)", hi: "मंत्र कार्ड (गायत्री, महामृत्युंजय, हनुमान)", mr: "मंत्र कार्ड (गायत्री, महामृत्युंजय, हनुमान)", syn: ["mantra card", "gayatri mantra", "mahamrityunjay", "मंत्र"], u: "pack", v: [["Set of 3", 49]], hsn: "49119100", gst: 5 },
  { t: "mantra-booklets", en: "Ganesh Puja Vidhi Booklet", hi: "गणेश पूजा विधि पुस्तिका", mr: "गणेश पूजा विधी पुस्तिका", syn: ["puja vidhi", "ganesh puja", "पूजा विधि", "पूजा विधी"], u: "pcs", v: [["Hindi", 25], ["Marathi", 25]], hsn: "49011010", gst: 0, fest: ["ganesh-chaturthi"] },
  { t: "mantra-booklets", en: "Lakshmi Puja Vidhi Booklet", hi: "लक्ष्मी पूजा विधि पुस्तिका", mr: "लक्ष्मीपूजन विधी पुस्तिका", syn: ["puja vidhi", "lakshmi pujan vidhi", "पूजा विधि"], u: "pcs", v: [["Hindi", 25], ["Marathi", 25]], hsn: "49011010", gst: 0, fest: ["diwali"] },

  /* -------------------------------------------- 15. Temple Bulk Supplies */
  { t: "bulk-puja", en: "Bulk Agarbatti", hi: "थोक अगरबत्ती", mr: "घाऊक अगरबत्ती", syn: [...AGARBATTI_SYN, "bulk agarbatti", "temple agarbatti", "wholesale"], u: "kg", v: [["1 kg", 450], ["5 kg", 2100]], hsn: "33074100", gst: 5 },
  { t: "bulk-puja", en: "Bulk Kapur Tablets", hi: "थोक कपूर टिकिया", mr: "घाऊक कापूर वडी", syn: [...KAPUR_SYN, "bulk camphor", "wholesale"], u: "kg", v: [["1 kg", 1250]], hsn: "29142910", gst: 18 },
  { t: "bulk-puja", en: "Bulk Bhimseni Kapur", hi: "थोक भीमसेनी कपूर", mr: "घाऊक भीमसेनी कापूर", syn: [...KAPUR_SYN, "bhimseni", "bulk camphor"], u: "kg", v: [["1 kg", null]], hsn: "29142910", gst: 18 },
  { t: "bulk-puja", en: "Bulk Cotton Batti (1,000 pcs)", hi: "थोक रुई बत्ती (1,000 पीस)", mr: "घाऊक वाती (1,000 नग)", syn: [...BATTI_SYN, "bulk batti", "1000 batti"], u: "pack", v: [["Round, 1,000 pcs", 220], ["Long, 1,000 pcs", 220]], hsn: "56012100", gst: 5 },
  { t: "bulk-puja", en: "Bulk Havan Samagri", hi: "थोक हवन सामग्री", mr: "घाऊक हवन साहित्य", syn: ["havan samagri", "bulk havan", "हवन सामग्री"], u: "kg", v: [["5 kg", 1450]], hsn: "33074100", gst: 0 },
  { t: "bulk-puja", en: "Bulk Kumkum", hi: "थोक कुमकुम", mr: "घाऊक कुंकू", syn: ["kumkum", "kunku", "bulk kumkum", "कुमकुम"], u: "kg", v: [["1 kg", 480]], hsn: "33049990", gst: 0 },
  { t: "bulk-ghee-oil", en: "Puja Ghee Tin", hi: "पूजा घी टिन", mr: "पूजेचे तूप डबा", syn: ["ghee tin", "15 kg ghee", "bulk ghee", "temple ghee", "घी", "तूप"], u: "kg", v: [["15 kg tin", null]], hsn: "04059020", gst: 5, edible: true },
  { t: "bulk-ghee-oil", en: "Puja Oil Tin", hi: "पूजा तेल टिन", mr: "दिव्याचे तेल डबा", syn: ["oil tin", "15 litre oil", "bulk deepam oil", "temple oil", "तेल"], u: "L", v: [["15 L tin", null]], hsn: "15180039", gst: 5 },
  { t: "bulk-ghee-oil", en: "Bulk Mishri (Prasad)", hi: "थोक मिश्री (प्रसाद)", mr: "घाऊक खडीसाखर (प्रसाद)", syn: ["mishri", "bulk prasad", "मिश्री"], u: "kg", v: [["5 kg", null]], hsn: "17019990", gst: 5, edible: true },
  { t: "prasad-packing", en: "Prasad Boxes", hi: "प्रसाद डिब्बे", mr: "प्रसादाचे डबे", syn: ["prasad box", "sweet box", "mithai box", "प्रसाद डिब्बा"], u: "pack", v: [["Small, pack of 100", 250], ["Medium, pack of 100", 400]], hsn: "48191090", gst: 18 },
  { t: "prasad-packing", en: "Leaf Dona (Bowls)", hi: "पत्तों के दोने", mr: "पानांचे द्रोण", syn: ["dona", "donna", "leaf bowl", "drona", "दोना", "द्रोण"], u: "pack", v: [["Pack of 100", 120]], hsn: "14049090", gst: 0 },
  { t: "prasad-packing", en: "Leaf Pattal (Plates)", hi: "पत्तल", mr: "पत्रावळ", syn: ["pattal", "pattal plate", "leaf plate", "patravali", "पत्तल", "पत्रावळ"], u: "pack", v: [["Pack of 100", 180]], hsn: "14049090", gst: 0 },
  { t: "prasad-packing", en: "Paper Dona", hi: "कागज़ के दोने", mr: "कागदी द्रोण", syn: ["paper dona", "paper bowl", "दोना"], u: "pack", v: [["Pack of 100", 90]], hsn: "48236900", gst: 5 },
  { t: "prasad-packing", en: "Kulhad (Clay Cups)", hi: "कुल्हड़", mr: "मातीचे कप (कुल्हड)", syn: ["kulhad", "kullad", "clay cup", "matka cup", "कुल्हड़"], u: "pack", v: [["Pack of 50", 150], ["Pack of 100", 280]], hsn: "69120040", gst: 0 },
  { t: "temple-equipment", en: "Donation Box (Steel)", hi: "दान पेटी (स्टील)", mr: "दानपेटी (स्टील)", syn: ["donation box", "daan peti", "hundi", "दान पेटी", "दानपेटी"], u: "pcs", v: [["Small", 799], ["Large, with lock", 1999]], hsn: "73269099", gst: 18 },
  { t: "temple-equipment", en: "Donation Box (Acrylic)", hi: "दान पेटी (एक्रिलिक)", mr: "दानपेटी (ॲक्रेलिक)", syn: ["donation box", "acrylic box", "dan peti", "दान पेटी"], u: "pcs", v: [["Medium", 899]], hsn: "39269099", gst: 18 },
  { t: "temple-equipment", en: "Temple Bell (Hanging, Brass)", hi: "मंदिर घंटा (पीतल)", mr: "मंदिराची घंटा (पितळी)", syn: ["temple bell", "mandir ghanta", "hanging bell", "घंटा"], u: "pcs", v: [["2 kg", null], ["5 kg", null]], hsn: "83061000", gst: 5, attrs: { material: "Brass" } },
  { t: "bulk-flowers", en: "Bulk Marigold (Loose)", hi: "थोक गेंदा फूल", mr: "घाऊक झेंडू", syn: ["marigold", "genda", "zendu", "bulk flowers", "गेंदा", "झेंडू"], u: "kg", v: [["Loose, per kg", null]], hsn: "06031900", gst: 0, loose: true, perishable: true },
  { t: "bulk-flowers", en: "Bulk Rose (Loose)", hi: "थोक गुलाब", mr: "घाऊक गुलाब", syn: ["rose", "gulab", "bulk flowers", "गुलाब"], u: "kg", v: [["Loose, per kg", null]], hsn: "06031100", gst: 0, loose: true, perishable: true },
  { t: "bulk-flowers", en: "Bulk Garlands (Temple Order)", hi: "थोक माला (मंदिर ऑर्डर)", mr: "घाऊक हार (मंदिर ऑर्डर)", syn: ["bulk garland", "temple garland", "haar", "माला", "हार"], u: "dozen", v: [["Loose, per dozen", null]], hsn: "06031900", gst: 0, loose: true, perishable: true },
];
