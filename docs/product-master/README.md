# Gokesari Product Master Data Platform

A platform — not a product list — that assembles, from **lawful sources**, one normalised master record per real-world product, keeps **sellers, offers, prices, sources, brands, manufacturers, categories, specifications, identifiers, history and data quality** as separate things around it, decides what is a duplicate and what is merely similar, and feeds the Gokesari marketplace catalogue.

> **Status: pilot delivered and validated. Large-scale ingestion has not been started** and needs an explicit go-ahead. Read the [pilot report](./PILOT_REPORT.md) first: it says what is proven, what is not, and what to settle before scale-up.

## Start here

| If you are… | Read |
|---|---|
| Deciding what happens next | [Pilot report](./PILOT_REPORT.md) → *Verdict* and *Recommended before scale-up* |
| A steward / operator | [User guide](./USER_GUIDE.md) |
| Adding a data source | [Data-source guide](./DATA_SOURCES.md), [source register](./SOURCE_REGISTER.md) |
| Onboarding **GS1 India** or a **manufacturer catalogue** | [GS1_AND_MANUFACTURERS.md](./GS1_AND_MANUFACTURERS.md) |
| An engineer | [SAD](./SAD.md) → [ETL](./ETL_PIPELINE.md) · [Deduplication](./DEDUPLICATION.md) · [Database design](./DATABASE_DESIGN.md) |
| Deploying it | [Deployment guide](./DEPLOYMENT.md) |
| Calling the API | [API guide](./API.md), [openapi.yaml](./openapi.yaml) |
| Checking requirements | [BRD](./BRD.md) · [PRD](./PRD.md) · [SRS](./SRS.md) |

## The brief's deliverables

| | Deliverable | Where |
|---|---|---|
| A | Architecture | [SAD](./SAD.md) (context diagram, decisions, scalability, failure modes) |
| B | PostgreSQL schema | `drizzle/0015_product_master_platform.sql` · [Database design](./DATABASE_DESIGN.md) |
| C | Data dictionary | [DATA_DICTIONARY.md](./DATA_DICTIONARY.md) *(generated from the export model)* and the workbook's DATA_DICTIONARY sheet |
| D | Source → field mapping | [SOURCE_FIELD_MAPPING.md](./SOURCE_FIELD_MAPPING.md) · [SOURCE_REGISTER.md](./SOURCE_REGISTER.md) *(generated)* |
| E | ETL pipeline | [ETL_PIPELINE.md](./ETL_PIPELINE.md) |
| F | Deduplication engine | [DEDUPLICATION.md](./DEDUPLICATION.md) |
| G | REST API | [API.md](./API.md) · [openapi.yaml](./openapi.yaml) |
| H | Excel export | `GOKESARI_PRODUCT_MASTER.xlsx` (13 sheets + RUN_SUMMARY) — `npm run pmd:export`; described in the [user guide](./USER_GUIDE.md#the-excel-master) |
| I | Dashboard | `/admin/product-master` · [user guide](./USER_GUIDE.md#the-dashboard) |
| J | Test suite | `tests/unit/pmd-*.test.ts`, `tests/integration/pmd-*.test.ts` · coverage map in [SRS §7](./SRS.md#7-test-suite-coverage-of-the-briefs-list-deliverable-j) |
| K | BRD, PRD, SRS, SAD, API spec, database design, deployment guide, data-source guide, user guide | This folder |

Two files are **generated from the code** and checked by a test, so they cannot drift: `DATA_DICTIONARY.md` and `SOURCE_REGISTER.md` (`npm run pmd:docs`). `openapi.yaml` is checked against the route files by the same test.

## The idea in five rules

1. **A product is not a listing.** One master record per product; price belongs to a seller at a moment (offers, price history), never to the product.
2. **Never guess quietly.** Unsure → the review queue. Unknown → NULL (never zero). Sources disagree → both kept, conflict recorded.
3. **Different means different.** Pack size, colour, model, size and variant are never merged away; nothing below the confidence threshold is merged automatically.
4. **Every fact has a source and a date.**
5. **Lawful or not at all.** Sources are registered with their legal basis; blocked sources cannot run; no CAPTCHA, login, robots.txt or anti-bot circumvention exists anywhere in the code.

## Quick start (local, Windows)

```powershell
./scripts/pmd/local-pg.ps1 init                                   # throwaway PostgreSQL, outside the repo
$env:DATABASE_URL = 'postgresql://pmd_admin@127.0.0.1:54329/gokesari_pmd'
npm run db:migrate                                                # applies 0000..0015 to that database only
$env:PMD_DATABASE_URL = $env:DATABASE_URL
npm run pmd:seed                                                  # source register, taxonomy, attributes
npm run pmd:import-feed -- --check --source partner_feed `
  --file docs/product-master/examples/partner-feed.sample.csv `
  --mapping docs/product-master/examples/partner-feed.mapping.json `
  --category-map docs/product-master/examples/partner-feed.categories.json
npm run pmd:pilot -- --reset                                      # after pmd:fetch-sample / pmd:fetch-prices
npm run pmd:checks ; npm run pmd:export
npm run pmd:test                                                  # needs TEST_DATABASE_URL -> a LOCAL database
```

Safety: the CLI tools never fall back to `DATABASE_URL`, refuse a non-local host without `PMD_ALLOW_REMOTE=1`, and do not load the application's `.env`.

## Where the code is

| Path | What |
|---|---|
| `drizzle/0015_product_master_platform.sql` | The `pmd` schema (additive; `scripts/pmd/rollback-0015.sql` undoes it) |
| `src/server/pmd/` | `normalize/` · `taxonomy/` · `match/` · `sources/` · `pipeline/` · `services/` · `export/` · `docs/` |
| `src/app/api/product-master/` | The API routes |
| `src/app/admin/product-master/`, `src/components/pmd-review-queue.tsx` | The dashboard and review queue |
| `scripts/pmd/` | Local database, sample fetchers, pilot, feed import, checks, export, benchmark, docs generator |
| `tests/unit/pmd-*`, `tests/integration/pmd-*`, `tests/helpers/pmd.ts` | The tests |
| Changes to existing files (all additive) | `permissions.ts` (4 permissions), `audit.ts` (4 actions), `site-header.tsx` (a link), `package.json` (scripts), `.gitignore`, the Drizzle journal |
