# Source register

> Generated from `src/server/pmd/sources/registry.ts` by `npm run pmd:docs` - do not edit by hand. A unit test fails if this file differs from the code (`tests/unit/pmd-docs.test.ts`).

Every source named in the brief, with its status and the lawful basis on which it can (or cannot yet) be collected. Only `ACTIVE` sources can run: the runner refuses anything else, and the database refuses to mark a non-active source enabled. Nothing in the platform collects from a marketplace; those entries exist so the gap is visible and the route to close it is written down.

**41 sources:** 7 active, 8 planned, 24 blocked needs agreement, 2 blocked technical.

## Summary

| Source | Name | Kind | Access | Status |
| --- | --- | --- | --- | --- |
| `open_food_facts` | Open Food Facts | OPEN_DATA | OPEN_DATASET | ACTIVE |
| `open_beauty_facts` | Open Beauty Facts | OPEN_DATA | OPEN_DATASET | ACTIVE |
| `open_products_facts` | Open Products Facts | OPEN_DATA | OPEN_DATASET | ACTIVE |
| `open_pet_food_facts` | Open Pet Food Facts | OPEN_DATA | OPEN_DATASET | ACTIVE |
| `open_prices` | Open Prices (Open Food Facts) | OPEN_DATA | OFFICIAL_API | ACTIVE |
| `manual_import` | Manual / steward import | INTERNAL | MANUAL_UPLOAD | ACTIVE |
| `partner_feed` | Licensed / partner CSV feed | LICENSED_FEED | LICENSED_FEED | ACTIVE |
| `gokesari_catalogue` | GoKesari marketplace catalogue | INTERNAL | INTERNAL_DB | PLANNED |
| `brand_manufacturer_feeds` | Brand / manufacturer catalogues | BRAND_MANUFACTURER | MANUFACTURER_FEED | PLANNED |
| `distributor_catalogues` | Authorised distributors | DISTRIBUTOR | LICENSED_FEED | PLANNED |
| `cbic_gst_hsn` | CBIC / GST Council rate & HSN notifications | GOVERNMENT | MANUAL_UPLOAD | PLANNED |
| `bis_public` | BIS certification data | GOVERNMENT | NONE | PLANNED |
| `legal_metrology` | Legal Metrology (declared MRP / net quantity) | GOVERNMENT | NONE | PLANNED |
| `ogd_india` | Open Government Data (data.gov.in) | GOVERNMENT | OPEN_DATASET | PLANNED |
| `wikidata` | Wikidata (brand / manufacturer enrichment) | OPEN_DATA | OFFICIAL_API | PLANNED |
| `gs1_india` | GS1 India (verified GTIN data) | GS1 | LICENSED_FEED | BLOCKED_NEEDS_AGREEMENT |
| `gem_catalogue` | Government e-Marketplace (GeM) catalogue | GOVERNMENT | NONE | BLOCKED_NEEDS_AGREEMENT |
| `amazon_in` | Amazon India | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `flipkart` | Flipkart | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `myntra` | Myntra | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `meesho` | Meesho | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `reliance_digital` | Reliance Digital | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `croma` | Croma | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `tata_cliq` | Tata CLiQ | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `vijay_sales` | Vijay Sales | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `bigbasket` | BigBasket | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `blinkit` | Blinkit | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `zepto` | Zepto | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `swiggy_instamart` | Swiggy Instamart | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `jiomart` | JioMart | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `dmart_ready` | DMart / DMart Ready | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `nykaa` | Nykaa | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `firstcry` | FirstCry | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `pepperfry` | Pepperfry | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `ajio` | Ajio | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `snapdeal` | Snapdeal | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `indiamart` | IndiaMART | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `moglix` | Moglix | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `industry_marketplaces` | Industry-specific marketplaces | MARKETPLACE | NONE | BLOCKED_NEEDS_AGREEMENT |
| `fssai_foscos` | FSSAI (FoSCoS licence / product data) | GOVERNMENT | NONE | BLOCKED_TECHNICAL |
| `gst_portal` | GST portal (public taxpayer look-up) | GOVERNMENT | NONE | BLOCKED_TECHNICAL |

## Details

## Active - collects today

### `open_food_facts` - Open Food Facts

- **Kind / access:** OPEN_DATA / OPEN_DATASET
- **Trust:** reliability 55, specification precedence 60 (lower wins a conflict)
- **Legal basis / route:** Open database published by the project for reuse. Consumed through the official bulk dump (static host /data/), which robots.txt does not disallow; the live API is disallowed for generic crawlers and is not used. Database licence ODbL 1.0, contents DbCL 1.0: attribute 'Open Food Facts contributors' and keep derived datasets under the same terms.
- **Licence:** ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA
- **Terms:** https://world.openfoodfacts.org/terms-of-use
- **robots.txt:** static host robots.txt disallows /api, /cgi, /facets only; /data/ dumps are allowed (checked 2026-09-19).
- **Endpoint:** https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz
- **Frequency:** weekly (dump is regenerated daily)
- **Rate limit:** 30 requests/minute
- **Parser:** `open_facts_csv`
- **Notes:** Crowdsourced: coverage and accuracy vary. Treated as lower-reliability than manufacturer or licensed data; GTINs are validated before use.

### `open_beauty_facts` - Open Beauty Facts

- **Kind / access:** OPEN_DATA / OPEN_DATASET
- **Trust:** reliability 55, specification precedence 60 (lower wins a conflict)
- **Legal basis / route:** Open database published by the project for reuse. Consumed through the official bulk dump (static host /data/), which robots.txt does not disallow; the live API is disallowed for generic crawlers and is not used. Database licence ODbL 1.0, contents DbCL 1.0: attribute 'Open Food Facts contributors' and keep derived datasets under the same terms.
- **Licence:** ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA
- **Terms:** https://world.openfoodfacts.org/terms-of-use
- **robots.txt:** static host robots.txt disallows /api, /cgi, /facets only; /data/ dumps are allowed (checked 2026-09-19).
- **Endpoint:** https://static.openbeautyfacts.org/data/en.openbeautyfacts.org.products.csv.gz
- **Frequency:** weekly (dump is regenerated daily)
- **Rate limit:** 30 requests/minute
- **Parser:** `open_facts_csv`
- **Notes:** Crowdsourced: coverage and accuracy vary. Treated as lower-reliability than manufacturer or licensed data; GTINs are validated before use.

### `open_products_facts` - Open Products Facts

- **Kind / access:** OPEN_DATA / OPEN_DATASET
- **Trust:** reliability 55, specification precedence 60 (lower wins a conflict)
- **Legal basis / route:** Open database published by the project for reuse. Consumed through the official bulk dump (static host /data/), which robots.txt does not disallow; the live API is disallowed for generic crawlers and is not used. Database licence ODbL 1.0, contents DbCL 1.0: attribute 'Open Food Facts contributors' and keep derived datasets under the same terms.
- **Licence:** ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA
- **Terms:** https://world.openfoodfacts.org/terms-of-use
- **robots.txt:** static host robots.txt disallows /api, /cgi, /facets only; /data/ dumps are allowed (checked 2026-09-19).
- **Endpoint:** https://static.openproductsfacts.org/data/en.openproductsfacts.org.products.csv.gz
- **Frequency:** weekly (dump is regenerated daily)
- **Rate limit:** 30 requests/minute
- **Parser:** `open_facts_csv`
- **Notes:** Crowdsourced: coverage and accuracy vary. Treated as lower-reliability than manufacturer or licensed data; GTINs are validated before use.

### `open_pet_food_facts` - Open Pet Food Facts

- **Kind / access:** OPEN_DATA / OPEN_DATASET
- **Trust:** reliability 55, specification precedence 60 (lower wins a conflict)
- **Legal basis / route:** Open database published by the project for reuse. Consumed through the official bulk dump (static host /data/), which robots.txt does not disallow; the live API is disallowed for generic crawlers and is not used. Database licence ODbL 1.0, contents DbCL 1.0: attribute 'Open Food Facts contributors' and keep derived datasets under the same terms.
- **Licence:** ODbL 1.0 (database) / DbCL 1.0 (contents); images CC BY-SA
- **Terms:** https://world.openfoodfacts.org/terms-of-use
- **robots.txt:** static host robots.txt disallows /api, /cgi, /facets only; /data/ dumps are allowed (checked 2026-09-19).
- **Endpoint:** https://static.openpetfoodfacts.org/data/en.openpetfoodfacts.org.products.csv.gz
- **Frequency:** weekly (dump is regenerated daily)
- **Rate limit:** 30 requests/minute
- **Parser:** `open_facts_csv`
- **Notes:** Crowdsourced: coverage and accuracy vary. Treated as lower-reliability than manufacturer or licensed data; GTINs are validated before use.

### `open_prices` - Open Prices (Open Food Facts)

- **Kind / access:** OPEN_DATA / OFFICIAL_API
- **Trust:** reliability 50, specification precedence 65 (lower wins a conflict)
- **Legal basis / route:** Public REST API of an open-data project, provided for programmatic reuse; robots.txt is empty (no restrictions). Open database licence (ODbL) - attribute the contributors and keep derived data under the same terms.
- **Licence:** ODbL 1.0 (verify on prices.openfoodfacts.org/about before redistribution)
- **Terms:** https://prices.openfoodfacts.org/about
- **robots.txt:** robots.txt on prices.openfoodfacts.org is empty (checked 2026-09-19).
- **Endpoint:** https://prices.openfoodfacts.org/api/v1/prices
- **Frequency:** daily
- **Rate limit:** 30 requests/minute
- **Parser:** `open_prices_json`
- **Notes:** Shelf-price observations submitted by volunteers. Not a marketplace feed: no stock, no MRP, sparse for India.

### `manual_import` - Manual / steward import

- **Kind / access:** INTERNAL / MANUAL_UPLOAD
- **Trust:** reliability 70, specification precedence 35 (lower wins a conflict)
- **Legal basis / route:** Data supplied by an authenticated GoKesari operator or administrator through the import API or a file upload. The uploader is responsible for having the right to supply it.
- **Frequency:** on demand
- **Parser:** `json_rows`
- **Notes:** Used by POST /products/import and by licensed/partner CSV feeds until a dedicated connector exists.

### `partner_feed` - Licensed / partner CSV feed

- **Kind / access:** LICENSED_FEED / LICENSED_FEED
- **Trust:** reliability 80, specification precedence 30 (lower wins a conflict)
- **Legal basis / route:** Product feeds delivered under a written agreement or an affiliate/partner programme's feed terms. Register one source per partner (copy this entry) and record the agreement reference in notes.
- **Frequency:** daily
- **Parser:** `csv_feed`
- **Notes:** Generic mapped-CSV adapter: column names are mapped to platform fields in the source's field_mapping.

## Planned - lawful route identified, connector not built

### `gokesari_catalogue` - GoKesari marketplace catalogue

- **Kind / access:** INTERNAL / INTERNAL_DB
- **Trust:** reliability 65, specification precedence 45 (lower wins a conflict)
- **Legal basis / route:** GoKesari's own operational product catalogue (public.products). Read-only; used to reconcile what shops already sell with the master.
- **Frequency:** daily
- **Notes:** Adapter not built in the pilot: the current catalogue is generic (no brands or GTINs), so it would add noise rather than signal.

### `brand_manufacturer_feeds` - Brand / manufacturer catalogues

- **Kind / access:** BRAND_MANUFACTURER / MANUFACTURER_FEED
- **Trust:** reliability 95, specification precedence 10 (lower wins a conflict)
- **Legal basis / route:** Catalogue files or APIs supplied by the brand under agreement, or public product-information pages where the brand's terms and robots.txt permit. Highest-precedence source for technical specifications.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Frequency:** weekly
- **Notes:** Register one source per brand once a feed or written permission exists.

### `distributor_catalogues` - Authorised distributors

- **Kind / access:** DISTRIBUTOR / LICENSED_FEED
- **Trust:** reliability 70, specification precedence 40 (lower wins a conflict)
- **Legal basis / route:** Price lists and catalogues supplied by authorised distributors under their agreement.
- **Frequency:** weekly

### `cbic_gst_hsn` - CBIC / GST Council rate & HSN notifications

- **Kind / access:** GOVERNMENT / MANUAL_UPLOAD
- **Trust:** reliability 90, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** Rate schedules and HSN notifications are public government documents. They are loaded as reference data by a person (no API is assumed); slabs live in config, not in code.
- **Frequency:** on each notification

### `bis_public` - BIS certification data

- **Kind / access:** GOVERNMENT / NONE
- **Trust:** reliability 90, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** BIS licence/registration look-ups: confirm whether a bulk dataset or API is offered and under what terms before any collection.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.

### `legal_metrology` - Legal Metrology (declared MRP / net quantity)

- **Kind / access:** GOVERNMENT / NONE
- **Trust:** reliability 90, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** Declared MRP and net quantity are printed on the pack; no public product database has been identified. Pack-label data reaches the platform through manufacturer or licensed feeds.

### `ogd_india` - Open Government Data (data.gov.in)

- **Kind / access:** GOVERNMENT / OPEN_DATASET
- **Trust:** reliability 85, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** Datasets published for reuse under the Government Open Data Licence - India. Individual datasets must be reviewed for relevance and licence before loading.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Frequency:** per dataset

### `wikidata` - Wikidata (brand / manufacturer enrichment)

- **Kind / access:** OPEN_DATA / OFFICIAL_API
- **Trust:** reliability 60, specification precedence 60 (lower wins a conflict)
- **Legal basis / route:** CC0 data with a public query service intended for programmatic use with an identifying User-Agent. Useful for brand-to-company and country enrichment, not for product-level SKUs.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.

## Blocked - needs an agreement, licence or official API

### `gs1_india` - GS1 India (verified GTIN data)

- **Kind / access:** GS1 / LICENSED_FEED
- **Trust:** reliability 95, specification precedence 12 (lower wins a conflict)
- **Legal basis / route:** GS1 product-data and verification services require GS1 membership or a data licence (confirm the current service names and terms with GS1 India). GTIN prefixes are public; product records are not scraped.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_GS1_INDIA_CREDENTIALS` (the secret is never stored)
- **Frequency:** weekly
- **Notes:** Authoritative for brand-owner and pack data. Enabling this is the single most valuable next source.

### `gem_catalogue` - Government e-Marketplace (GeM) catalogue

- **Kind / access:** GOVERNMENT / NONE
- **Trust:** reliability 80, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** GeM's product catalogue is served to registered buyers and sellers under GeM's terms; no public bulk feed is assumed. Needs written permission or a published dataset.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.

### `amazon_in` - Amazon India

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Amazon's official affiliate product API (Product Advertising API or its successor - confirm the current programme) via an approved Associates account; Amazon's conditions of use prohibit automated scraping.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_AMAZON_IN_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: All. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `flipkart` - Flipkart

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Flipkart Affiliate API / product feeds (requires affiliate approval), or a seller-integration API where GoKesari is a seller.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_FLIPKART_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: All. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `myntra` - Myntra

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_MYNTRA_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Apparel, Beauty, Footwear. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `meesho` - Meesho

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Supplier/reseller programme data or a written data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_MEESHO_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Apparel, Home, Beauty. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `reliance_digital` - Reliance Digital

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_RELIANCE_DIGITAL_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Electronics, Appliances. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `croma` - Croma

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_CROMA_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Electronics, Appliances. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `tata_cliq` - Tata CLiQ

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_TATA_CLIQ_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Electronics, Apparel, Beauty. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `vijay_sales` - Vijay Sales

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_VIJAY_SALES_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Electronics, Appliances. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `bigbasket` - BigBasket

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_BIGBASKET_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Grocery, Dairy, Beverages. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `blinkit` - Blinkit

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_BLINKIT_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Grocery, Dairy, Personal Care. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `zepto` - Zepto

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_ZEPTO_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Grocery, Dairy, Personal Care. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `swiggy_instamart` - Swiggy Instamart

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_SWIGGY_INSTAMART_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Grocery, Dairy, Personal Care. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `jiomart` - JioMart

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / affiliate feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_JIOMART_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Grocery, Electronics, Apparel. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `dmart_ready` - DMart / DMart Ready

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_DMART_READY_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Grocery, Household. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `nykaa` - Nykaa

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_NYKAA_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Beauty, Personal Care. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `firstcry` - FirstCry

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_FIRSTCRY_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Baby, Kids, Toys. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `pepperfry` - Pepperfry

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_PEPPERFRY_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Furniture, Home. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `ajio` - Ajio

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_AJIO_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Apparel, Footwear. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `snapdeal` - Snapdeal

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Affiliate-network product feed or a written data-licence agreement.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_SNAPDEAL_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: All. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `indiamart` - IndiaMART

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: IndiaMART's seller-facing APIs are for a seller's own catalogue and leads, not a public catalogue feed - a written data-licence agreement is needed for anything more.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_INDIAMART_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Industrial, B2B. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `moglix` - Moglix

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Partner / data-licence agreement (no public product API identified).
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_MOGLIX_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Industrial, Tools, Electricals. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

### `industry_marketplaces` - Industry-specific marketplaces

- **Kind / access:** MARKETPLACE / NONE
- **Trust:** reliability 65, specification precedence 50 (lower wins a conflict)
- **Legal basis / route:** Public storefront pages are governed by the operator's terms of use and robots.txt and are typically protected by anti-bot controls. The platform does not scrape them and does not circumvent CAPTCHA, authentication, rate limits or robots.txt. Lawful route to enable: Assessed per marketplace at onboarding; each needs its own documented lawful route.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_INDUSTRY_MARKETPLACES_CREDENTIALS` (the secret is never stored)
- **Frequency:** daily (once a route exists)
- **Notes:** Categories: Various. Marketplace data is preferred for availability, seller, price, rating and reviews; manufacturer data for technical specifications.

## Blocked - no lawful automated route (CAPTCHA / login / no API)

### `fssai_foscos` - FSSAI (FoSCoS licence / product data)

- **Kind / access:** GOVERNMENT / NONE
- **Trust:** reliability 90, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** FoSCoS public look-ups are protected by CAPTCHA, which this platform never bypasses. Route: request an official data-sharing arrangement/API from FSSAI, or use a licensed data provider. FSSAI licence numbers are validated for FORMAT only.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Notes:** Format check (14 digits, leading 1/2) is implemented; existence/expiry of a licence is not verified.

### `gst_portal` - GST portal (public taxpayer look-up)

- **Kind / access:** GOVERNMENT / NONE
- **Trust:** reliability 90, specification precedence 15 (lower wins a conflict)
- **Legal basis / route:** The GST public search is CAPTCHA-protected and not bypassed. Route: an authorised GST Suvidha Provider (GSP) API under its terms. GSTIN structure is validated; registration status is not verified.
- **robots.txt:** Not fetched. No automated access to this site is performed until an agreed route is in place.
- **Credentials:** environment variable `PMD_SRC_GST_GSP_CREDENTIALS` (the secret is never stored)
