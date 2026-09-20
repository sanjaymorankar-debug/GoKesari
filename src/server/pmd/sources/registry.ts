/**
 * The source register: every source the brief names, with HOW it may lawfully be
 * collected and what its status is today.
 *
 * ACTIVE sources have working adapters. Everything else is registered so the gap is
 * visible and the route to close it is written down - but NO code exists that
 * fetches from a blocked source, and the ingestion runner refuses to run a source
 * that is not ACTIVE and enabled.
 *
 * Statements about third parties' terms are deliberately hedged ("confirm ...").
 * They are the platform's starting position, not legal advice: terms and APIs
 * change, and each onboarding must re-verify current terms before enabling.
 */
import type { SourceDefinition } from "../types";
import { OPEN_FACTS_DUMPS, openFactsDefinition } from "./adapters/open-facts";
import { OPEN_PRICES_DEFINITION } from "./adapters/open-prices";

const NOT_FETCHED = "Not fetched. No automated access to this site is performed until an agreed route is in place.";

const SCRAPING_NOT_USED =
  "Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. " +
  "The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt.";

interface MarketplaceRow {
  key: string;
  name: string;
  route: string;
  categories: string;
}

/** Marketplaces named in the brief. Route = the lawful way to onboard, to be confirmed with the operator. */
const MARKETPLACES: MarketplaceRow[] = [
  { key: "amazon_in", name: "Amazon India", categories: "All", route: "Amazon's official affiliate product API (Product Advertising API or its successor - confirm the current programme) via an approved Associates account; Amazon's conditions of use prohibit automated scraping." },
  { key: "flipkart", name: "Flipkart", categories: "All", route: "Flipkart Affiliate API / product feeds (requires affiliate approval), or a seller-integration API where GoKesari is a seller." },
  { key: "myntra", name: "Myntra", categories: "Apparel, Beauty, Footwear", route: "Affiliate-network product feed or a written data-licence agreement (no public product API identified)." },
  { key: "meesho", name: "Meesho", categories: "Apparel, Home, Beauty", route: "Supplier/reseller programme data or a written data-licence agreement (no public product API identified)." },
  { key: "reliance_digital", name: "Reliance Digital", categories: "Electronics, Appliances", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "croma", name: "Croma", categories: "Electronics, Appliances", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "tata_cliq", name: "Tata CLiQ", categories: "Electronics, Apparel, Beauty", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "vijay_sales", name: "Vijay Sales", categories: "Electronics, Appliances", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "bigbasket", name: "BigBasket", categories: "Grocery, Dairy, Beverages", route: "Partner / data-licence agreement (no public product API identified)." },
  { key: "blinkit", name: "Blinkit", categories: "Grocery, Dairy, Personal Care", route: "Partner / data-licence agreement (no public product API identified)." },
  { key: "zepto", name: "Zepto", categories: "Grocery, Dairy, Personal Care", route: "Partner / data-licence agreement (no public product API identified)." },
  { key: "swiggy_instamart", name: "Swiggy Instamart", categories: "Grocery, Dairy, Personal Care", route: "Partner / data-licence agreement (no public product API identified)." },
  { key: "jiomart", name: "JioMart", categories: "Grocery, Electronics, Apparel", route: "Partner / affiliate feed or a written data-licence agreement." },
  { key: "dmart_ready", name: "DMart / DMart Ready", categories: "Grocery, Household", route: "Partner / data-licence agreement (no public product API identified)." },
  { key: "nykaa", name: "Nykaa", categories: "Beauty, Personal Care", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "firstcry", name: "FirstCry", categories: "Baby, Kids, Toys", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "pepperfry", name: "Pepperfry", categories: "Furniture, Home", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "ajio", name: "Ajio", categories: "Apparel, Footwear", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "snapdeal", name: "Snapdeal", categories: "All", route: "Affiliate-network product feed or a written data-licence agreement." },
  { key: "indiamart", name: "IndiaMART", categories: "Industrial, B2B", route: "IndiaMART's seller-facing APIs are for a seller's own catalogue and leads, not a public catalogue feed - a written data-licence agreement is needed for anything more." },
  { key: "moglix", name: "Moglix", categories: "Industrial, Tools, Electricals", route: "Partner / data-licence agreement (no public product API identified)." },
  { key: "industry_marketplaces", name: "Industry-specific marketplaces", categories: "Various", route: "Assessed per marketplace at onboarding; each needs its own documented lawful route." },
];

const marketplaceSources: SourceDefinition[] = MARKETPLACES.map((m) => ({
  key: m.key,
  name: m.name,
  kind: "MARKETPLACE",
  accessMethod: "NONE",
  status: "BLOCKED_NEEDS_AGREEMENT",
  reliability: 65,
  legalBasis: `${SCRAPING_NOT_USED} Lawful route to enable: ${m.route}`,
  robotsPolicy: NOT_FETCHED,
  authEnvVar: `PMD_SRC_${m.key.toUpperCase()}_CREDENTIALS`,
  collectionFrequency: "daily (once a route exists)",
  notes: `Categories: ${m.categories}. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.`,
}));

const otherSources: SourceDefinition[] = [
  {
    key: "manual_import",
    name: "Manual / steward import",
    kind: "INTERNAL",
    accessMethod: "MANUAL_UPLOAD",
    status: "ACTIVE",
    reliability: 70,
    specPrecedence: 35,
    legalBasis: "Data supplied by an authenticated GoKesari operator or administrator through the import API or a file upload. The uploader is responsible for having the right to supply it.",
    collectionFrequency: "on demand",
    parserKey: "json_rows",
    notes: "Used by POST /products/import and by licensed/partner CSV feeds until a dedicated connector exists.",
  },
  {
    key: "partner_feed",
    name: "Licensed / partner CSV feed",
    kind: "LICENSED_FEED",
    accessMethod: "LICENSED_FEED",
    status: "ACTIVE",
    reliability: 80,
    specPrecedence: 30,
    legalBasis: "Product feeds delivered under a written agreement or an affiliate/partner programme's feed terms. Register one source per partner (copy this entry) and record the agreement reference in notes.",
    collectionFrequency: "daily",
    parserKey: "csv_feed",
    notes: "Generic mapped-CSV adapter: column names are mapped to platform fields in the source's field_mapping.",
  },
  {
    key: "gokesari_catalogue",
    name: "GoKesari marketplace catalogue",
    kind: "INTERNAL",
    accessMethod: "INTERNAL_DB",
    status: "PLANNED",
    reliability: 65,
    specPrecedence: 45,
    legalBasis: "GoKesari's own operational product catalogue (public.products). Read-only; used to reconcile what shops already sell with the master.",
    collectionFrequency: "daily",
    notes: "Adapter not built in the pilot: the current catalogue is generic (no brands or GTINs), so it would add noise rather than signal.",
  },
  {
    key: "brand_manufacturer_feeds",
    name: "Brand / manufacturer catalogues",
    kind: "BRAND_MANUFACTURER",
    accessMethod: "MANUFACTURER_FEED",
    status: "PLANNED",
    reliability: 95,
    legalBasis: "Catalogue files or APIs supplied by the brand under agreement, or public product-information pages where the brand's terms and robots.txt permit. Highest-precedence source for technical specifications.",
    robotsPolicy: NOT_FETCHED,
    collectionFrequency: "weekly",
    notes: "Register one source per brand once a feed or written permission exists.",
  },
  {
    key: "distributor_catalogues",
    name: "Authorised distributors",
    kind: "DISTRIBUTOR",
    accessMethod: "LICENSED_FEED",
    status: "PLANNED",
    reliability: 70,
    legalBasis: "Price lists and catalogues supplied by authorised distributors under their agreement.",
    collectionFrequency: "weekly",
  },
  {
    key: "gs1_india",
    name: "GS1 India (verified GTIN data)",
    kind: "GS1",
    accessMethod: "LICENSED_FEED",
    status: "BLOCKED_NEEDS_AGREEMENT",
    reliability: 95,
    legalBasis: "GS1 product-data and verification services require GS1 membership or a data licence (confirm the current service names and terms with GS1 India). GTIN prefixes are public; product records are not scraped.",
    robotsPolicy: NOT_FETCHED,
    authEnvVar: "PMD_SRC_GS1_INDIA_CREDENTIALS",
    collectionFrequency: "weekly",
    notes: "Authoritative for brand-owner and pack data. Enabling this is the single most valuable next source.",
  },
  {
    key: "fssai_foscos",
    name: "FSSAI (FoSCoS licence / product data)",
    kind: "GOVERNMENT",
    accessMethod: "NONE",
    status: "BLOCKED_TECHNICAL",
    reliability: 90,
    legalBasis: "FoSCoS public look-ups are protected by CAPTCHA, which this platform never bypasses. Route: request an official data-sharing arrangement/API from FSSAI, or use a licensed data provider. FSSAI licence numbers are validated for FORMAT only.",
    robotsPolicy: NOT_FETCHED,
    notes: "Format check (14 digits, leading 1/2) is implemented; existence/expiry of a licence is not verified.",
  },
  {
    key: "gst_portal",
    name: "GST portal (public taxpayer look-up)",
    kind: "GOVERNMENT",
    accessMethod: "NONE",
    status: "BLOCKED_TECHNICAL",
    reliability: 90,
    legalBasis: "The GST public search is CAPTCHA-protected and not bypassed. Route: an authorised GST Suvidha Provider (GSP) API under its terms. GSTIN structure is validated; registration status is not verified.",
    robotsPolicy: NOT_FETCHED,
    authEnvVar: "PMD_SRC_GST_GSP_CREDENTIALS",
  },
  {
    key: "cbic_gst_hsn",
    name: "CBIC / GST Council rate & HSN notifications",
    kind: "GOVERNMENT",
    accessMethod: "MANUAL_UPLOAD",
    status: "PLANNED",
    reliability: 90,
    specPrecedence: 15,
    legalBasis: "Rate schedules and HSN notifications are public government documents. They are loaded as reference data by a person (no API is assumed); slabs live in config, not in code.",
    collectionFrequency: "on each notification",
  },
  {
    key: "bis_public",
    name: "BIS certification data",
    kind: "GOVERNMENT",
    accessMethod: "NONE",
    status: "PLANNED",
    reliability: 90,
    legalBasis: "BIS licence/registration look-ups: confirm whether a bulk dataset or API is offered and under what terms before any collection.",
    robotsPolicy: NOT_FETCHED,
  },
  {
    key: "legal_metrology",
    name: "Legal Metrology (declared MRP / net quantity)",
    kind: "GOVERNMENT",
    accessMethod: "NONE",
    status: "PLANNED",
    reliability: 90,
    legalBasis: "Declared MRP and net quantity are printed on the pack; no public product database has been identified. Pack-label data reaches the platform through manufacturer or licensed feeds.",
  },
  {
    key: "ogd_india",
    name: "Open Government Data (data.gov.in)",
    kind: "GOVERNMENT",
    accessMethod: "OPEN_DATASET",
    status: "PLANNED",
    reliability: 85,
    legalBasis: "Datasets published for reuse under the Government Open Data Licence - India. Individual datasets must be reviewed for relevance and licence before loading.",
    robotsPolicy: NOT_FETCHED,
    collectionFrequency: "per dataset",
  },
  {
    key: "gem_catalogue",
    name: "Government e-Marketplace (GeM) catalogue",
    kind: "GOVERNMENT",
    accessMethod: "NONE",
    status: "BLOCKED_NEEDS_AGREEMENT",
    reliability: 80,
    legalBasis: "GeM's product catalogue is served to registered buyers and sellers under GeM's terms; no public bulk feed is assumed. Needs written permission or a published dataset.",
    robotsPolicy: NOT_FETCHED,
  },
  {
    key: "wikidata",
    name: "Wikidata (brand / manufacturer enrichment)",
    kind: "OPEN_DATA",
    accessMethod: "OFFICIAL_API",
    status: "PLANNED",
    reliability: 60,
    legalBasis: "CC0 data with a public query service intended for programmatic use with an identifying User-Agent. Useful for brand-to-company and country enrichment, not for product-level SKUs.",
    robotsPolicy: NOT_FETCHED,
  },
];

const activeSources: SourceDefinition[] = [
  ...(Object.keys(OPEN_FACTS_DUMPS) as Array<keyof typeof OPEN_FACTS_DUMPS>).map(openFactsDefinition),
  OPEN_PRICES_DEFINITION,
];

/** Every registered source. Order: working adapters first, then the visible gaps. */
export const SOURCE_REGISTRY: readonly SourceDefinition[] = [...activeSources, ...otherSources, ...marketplaceSources];

export function getSourceDefinition(key: string): SourceDefinition | undefined {
  return SOURCE_REGISTRY.find((s) => s.key === key);
}
