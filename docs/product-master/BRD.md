# Business Requirements Document — Product Master Data Platform

| | |
|---|---|
| Product | Gokesari Universal Product Master |
| Status | Pilot delivered and validated; large-scale ingestion **not started** (gated — see §9) |
| Related | [PRD](./PRD.md) · [SRS](./SRS.md) · [SAD](./SAD.md) · [Pilot report](./PILOT_REPORT.md) |

## 1. Background

Gokesari is a marketplace connecting shops and customers. A shop owner who lists a product today types it in: name, size, brand, tax rate, category. Every shop types the same Amul butter differently, so the catalogue holds near-duplicates, no barcodes, and no reliable brand, manufacturer or tax data. At the start of this work the live catalogue held **373 generic products, no brands, and no GTINs**.

Product data that is complete and consistent exists — spread across manufacturers, e-commerce sites, distributors, government registers and open datasets, each in its own shape and each with its own terms. Nobody has assembled it once, correctly, for Gokesari.

## 2. Problem

1. **Duplicate and inconsistent listings.** One product exists as many differently-named rows; the same product from many sellers looks like many products.
2. **Missing facts.** No GTIN, brand, manufacturer, HSN or GST rate on most rows — which hurts search, invoicing and compliance.
3. **No way to measure quality** or to know where a fact came from.
4. **A risk of doing it wrongly.** The obvious shortcut — scraping marketplaces — breaches their terms, is fragile, and exposes Gokesari legally.
5. **A tempting wrong design.** One giant spreadsheet with a row per product-per-site multiplies every product ten to twenty times.

## 3. Objectives

| # | Objective | Measure |
|---|---|---|
| O1 | One reliable, normalised record per real-world product, with brand, manufacturer, category, specifications and identifiers separate from sellers and prices | Every product has a `GKS-PROD-…` id; the same GTIN never appears twice among active products (automated invariant) |
| O2 | Stop duplicates without merging things that differ | Different pack sizes and variants stay separate; nothing below the confidence threshold is merged automatically |
| O3 | Give shop owners a real catalogue to choose from instead of typing | Master → catalogue promotion, without copying marketplace prices |
| O4 | Make quality visible and improvable | A 0–100 score with components; a dashboard; automated checks; conflicts and gaps listed, never hidden |
| O5 | Collect **only lawfully** | Every source has a recorded legal basis; blocked sources cannot run; no circumvention of CAPTCHA, authentication, robots.txt, rate limits or anti-bot measures |
| O6 | Stay maintainable and scale to ~10 million products | Adapter-based sources; incremental daily updates; measured performance |
| O7 | Traceability | Every fact can be traced to a source, a collection method and a date; every change is versioned |

## 4. Scope

**In scope:** source register and adapters; ETL (extract, parse, normalise, match, validate, load); the product master and its supporting entities (brands, manufacturers, categories, specifications, identifiers, sources, sellers/offers, price history, images, families, conflicts, quality); deduplication and a human review queue; the bridge to the marketplace catalogue; REST API; quality dashboard; Excel reporting export; automated tests; documentation.

**Out of scope (for this release):**

* **Large-scale ingestion.** The brief makes it conditional on a validated pilot; it has not been started.
* Collecting from marketplaces, GS1, FSSAI, GST or BIS — each needs an agreement, licence or official API that does not yet exist (registered and blocked, with the route written down).
* Shop-facing product browsing (shops use the existing catalogue), customer-facing pages, price comparison for customers.
* Machine-learning matching, image matching, automatic translation.
* Storing or re-hosting product images.

## 5. Stakeholders

| Stakeholder | Interest |
|---|---|
| Gokesari management | A defensible, lawful product foundation; visible progress and quality |
| Operators / data stewards | Tools to review duplicates, see gaps and keep data clean |
| Administrators | Control of what is collected, imported and enabled |
| Shop owners (indirect) | Pick a correct product instead of typing one |
| Customers (indirect) | Correct names, sizes, brands and tax on what they buy |
| Engineering | A maintainable system that fits the existing stack |
| Legal / compliance | Evidence that collection is permitted and personal data is not collected |

## 6. Business requirements

Priority: **M**ust, **S**hould, **C**ould. Status as of the pilot.

| ID | Requirement | Pri | Status |
|---|---|---|---|
| BR-01 | A single normalised product master record per real-world product, kept separate from sellers, offers, prices, sources, brands, manufacturers, categories, specifications, identifiers and quality | M | Delivered |
| BR-02 | Collect from multiple permitted sources through a configurable adapter framework; new sources added without touching the core | M | Delivered (open data + file feeds); marketplaces need agreements |
| BR-03 | Detect duplicates across sources and sellers; keep different pack sizes and variants separate; never auto-merge below a configurable threshold | M | Delivered |
| BR-04 | Normalise units, identifiers, brands, tax and categories, keeping the original value | M | Delivered |
| BR-05 | Preserve source information, specifications per source, and full price history; never silently overwrite conflicting data | M | Delivered |
| BR-06 | Treat missing data honestly: NULL / NOT_AVAILABLE, never zero; score and list gaps | M | Delivered |
| BR-07 | Never mark a product discontinued because one marketplace stopped listing it | M | Delivered |
| BR-08 | Record and enforce the legal basis of every source; never bypass CAPTCHA, authentication, robots.txt, rate limits or anti-bot systems; never collect personal data | M | Delivered |
| BR-09 | Feed the marketplace catalogue (master → catalogue → shop catalogue → inventory) without copying seller prices into the master | M | Delivered (master → catalogue); shop and inventory layers already exist |
| BR-10 | Excel reporting export in the specified 13-sheet structure with data dictionary, validation and formatting | M | Delivered |
| BR-11 | REST API for products, offers, price history, brands, categories, manufacturers, import, match, validate and data quality | M | Delivered |
| BR-12 | Data-quality and collection dashboard | M | Delivered |
| BR-13 | Governance: audit of human actions, version history, merge history, role-based access | M | Delivered |
| BR-14 | Support ~10 million products and daily incremental updates | M | **Partly proven** — queries measured at 1M; loader reworked (~4x new, ~30x unchanged); price-change path still to batch ([pilot report](./PILOT_REPORT.md)) |
| BR-15 | A proof-of-concept across ~15 categories with 100–1,000 products per source before any large collection | M | **Partly met** — 8 of 15 categories populated in depth from open data; 5 barely; 2 (Automotive, Tools) not at all, because no lawful open source covers them |
| BR-16 | A product browser/editor and promotion button in the admin console | S | Not built — API only |
| BR-17 | Scheduled collection and alerting | S | Not built — CLI, run by a person or an external scheduler |

## 7. Business rules

1. A product is a *thing*, not a listing. Price belongs to a seller at a moment, not to the product.
2. Two different barcodes are two products; the same barcode is one product unless it contradicts brand or pack size — then a person decides.
3. Manufacturer / brand-owner data outranks marketplaces and open data for technical specifications; disagreements are recorded, not overwritten.
4. A marketplace's price is never Gokesari's MRP. An MRP is accepted only from a manufacturer, GS1 or government source, and starts as *pending verification*.
5. `DISCONTINUED` is set only by a person or a manufacturer statement.
6. A source that has no lawful route is not collected from — it is registered, blocked, and its route written down.

## 8. Constraints and assumptions

* **Legal:** only permitted access. This shaped the design: open datasets and licensed/partner feeds are first-class; marketplaces are blocked until an agreement exists.
* **Existing stack:** the platform runs inside the current Next.js / TypeScript / PostgreSQL application and its role model, audit log and CI.
* **Data reality:** open data is crowd-sourced and food-heavy. Electronics, mobiles, computers, apparel, automotive and tools need licensed, partner or manufacturer data.
* **Assumption:** a person will work the review queue; the volume is a staffing decision (§10).

## 9. Release gate

The brief's own sequence: inspect the existing system → identify existing tables → reuse architecture → propose schema and source strategy → implement a small pilot → validate it → generate the first Excel master → run automated quality and duplicate checks → **only after successful validation, proceed to large-scale ingestion.**

Steps 1–8 are complete. **Step 9 has not been started and needs an explicit go-ahead**, after the items in the pilot report's *Recommended before scale-up* are settled.

## 10. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| No lawful source for a category | Categories stay empty | Register the route; pursue agreements/feeds; the platform is source-agnostic |
| Review workload grows with volume (the pilot queued ~1 in 90 records) | Backlog erodes trust | Tune thresholds with evidence; steward capacity plan; auto-resolution rules for proven patterns |
| Crowdsourced brand/manufacturer confusion | Wrong brand pages, wrong owner | `brand-looks-like-company` check; alias table; manufacturer data from GS1/brand feeds |
| Loader throughput | Long initial loads, cost | Co-locate workers, cut round trips, add a bulk path (measured, planned) |
| Wrong merge | Two products' prices mixed | Conservative thresholds; hard conflicts; merges are by pointer and reversible in data terms |
| Licence obligations (ODbL share-alike) | Legal exposure if ignored | Attribution carried in every export; images linked, never copied |
| Hosted-database differences | Surprise on first deploy | Apply to a branch first; tests run against real PostgreSQL |

## 11. Success measures (baseline from the pilot)

| KPI | Pilot baseline | Direction |
|---|---|---|
| Products with a valid GTIN | 85 % (1,863 / 2,180) | ↑ |
| Products with a standard category | 44 % | ↑ |
| Products with a brand / manufacturer | 70 % / 0.6 % | ↑ |
| Average quality score | 60.8 (range 33–77) | ↑ |
| Invariant checks passing | 11 / 11 | must stay 11 |
| Review items per 100 records | ~1.1 | ↓ or staffed |
| Sources with a recorded legal basis | 41 / 41 | must stay 100 % |
