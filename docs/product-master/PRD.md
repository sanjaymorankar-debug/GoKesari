# Product Requirements Document — Product Master Data Platform

| | |
|---|---|
| Related | [BRD](./BRD.md) · [SRS](./SRS.md) · [User guide](./USER_GUIDE.md) · [Pilot report](./PILOT_REPORT.md) |
| Status | Pilot release. "Built / Partial / Not built" below is as of the pilot |

## 1. Product in one paragraph

A platform — not a product list — that assembles, from lawful sources, one normalised master record per real-world product, keeps sellers, prices, sources, brands, manufacturers, categories, specifications, identifiers and history as separate things around it, decides what is a duplicate and what is merely similar, measures its own data quality, and feeds the Gokesari marketplace catalogue.

## 2. Users

| Persona | Goal | Uses |
|---|---|---|
| **Data steward** (operator) | Keep the master clean: settle possible duplicates, see gaps, decide conflicts | Dashboard, review queue, checks, search |
| **Catalogue manager** (operator/admin) | Get good products in front of shops | Search, promote to catalogue |
| **Administrator** | Control what is collected; bring in data | Source register, feed import, API import, enable/disable sources |
| **Engineer** | Add a source; keep the platform healthy | Adapters, `--check`, tests, checks, deployment guide |
| *Shop owner (indirect)* | Pick a correct product instead of typing it | The marketplace catalogue the master feeds |

## 3. Principles

1. **A product is not a listing.** Price is a fact about a seller at a moment.
2. **Never guess quietly.** Uncertain → review queue. Unknown → NULL. Disagreement → recorded, both values kept.
3. **Every fact has a source and a date.**
4. **Different means different.** Pack size, colour, model, size and flavour are never merged away.
5. **Lawful or not at all.** Registered and blocked beats collected and risky.

## 4. Features

| ID | Feature | Status |
|---|---|---|
| F1 | Source register: status, legal basis, licence, trust, credentials by *name*, frequency, mapping | Built |
| F2 | Adapter framework: Open*Facts dumps, Open Prices API, mapped CSV feed (config only), manual/API import | Built |
| F3 | Polite HTTP: robots.txt fail-closed, rate limits, retry with backoff, identifying User-Agent, byte caps | Built |
| F4 | Normalisation: pack sizes, GTIN/ISBN, brand, tax (GST/HSN/cess), colour/size/country, money, stock | Built |
| F5 | Category taxonomy (410 nodes, 5 levels) and source-category mapping | Built |
| F6 | Product master with separate identifiers, specifications (per source), images, families | Built |
| F7 | Deduplication: 4 match levels, hard conflicts, configurable thresholds, review queue, merge by pointer | Built |
| F8 | Conflicts between sources: detect, resolve by precedence or leave open | Built |
| F9 | Offers (current) and append-only price history | Built |
| F10 | Product status from offers — never DISCONTINUED automatically | Built |
| F11 | Quality score with components; automated invariants and stewardship checks | Built |
| F12 | Incremental updates: unchanged shortcut, changes only, full-snapshot "not seen" handling | Built |
| F13 | REST API (15 operations) with permissions | Built |
| F14 | Quality dashboard + review queue screen | Built |
| F15 | Promote master → marketplace catalogue (adopt by GTIN, no prices copied, audited) | Built (API) |
| F16 | Excel export: 13 specified sheets + RUN_SUMMARY, validation, formats, partitioned output | Built |
| F17 | Audit, version history, merge history, change log | Built |
| F18 | Product browser / detail / edit screens; promote button | **Not built** |
| F19 | Scheduled runs, run alerts, worker for `pmd.job` | **Not built** |
| F20 | Licensed/partner/manufacturer/GS1 feeds actually connected | **Not built** — need agreements |
| F21 | Bulk load path for tens of millions of records | **Not built** — measured need ([pilot report](./PILOT_REPORT.md)) |

## 5. User stories and acceptance

**US-1 — Trust what I see.** *As a steward, I want to know where a value came from, so I can trust or correct it.*
✔ Every specification row names its source and is marked preferred or not; `PRODUCT_SOURCE` shows method and dates; the change log records what changed and why.

**US-2 — Don't make me re-review the same thing.** *As a steward, I want a decided pair not to come back.*
✔ A decided review item is never re-opened by later runs.

**US-3 — Stop duplicates, keep variants.** *As a catalogue manager, I want the same product from five sellers to be one product, and a 1 kg pack and a 5 kg pack to be two.*
✔ Same GTIN → one master, several offers; different pack size → separate master in one family; a GTIN that contradicts brand or pack → held for a person, never merged silently.

**US-4 — Show me the gaps.** *As a steward, I want to see what is missing.*
✔ Dashboard tiles for missing GTIN / brand / manufacturer / category / MRP / GST / HSN; the DATA_QUALITY sheet lists each product's missing fields; missing is null/`NOT_AVAILABLE`, never 0.

**US-5 — Try before I load.** *As an admin, I want to test a feed's mapping without writing anything.*
✔ `--check` reports what would load, coverage and the first problems, with no database; `POST /products/validate` and `/match` are dry runs.

**US-6 — Add a source without an engineer.** *As an admin, I want to onboard a partner file by configuration.*
✔ A mapping file and a category map; a worked example is under automated test. (An API source needs an adapter — an engineer.)

**US-7 — Give shops a proper catalogue.** *As a catalogue manager, I want to promote a good master product so shops can pick it.*
✔ Eligible only if active, categorised, quality ≥ 40; an existing catalogue product with the same GTIN is adopted; no marketplace price crosses; audited.

**US-8 — Prove it is lawful.** *As compliance, I want evidence of what is collected and on what basis.*
✔ Source register lists status and legal basis for all 41 sources; only ACTIVE + enabled sources run (also enforced by a database constraint); the polite client obeys robots.txt and fails closed; personal data is stripped before storage.

**US-9 — Hand me a spreadsheet.** *As management, I want the Excel master.*
✔ 13 sheets in the specified order plus RUN_SUMMARY; frozen headers, filters, tables, validation, no merged cells; refuses to export from a database that violates its invariants.

**US-10 — Grow without rewriting.** *As an engineer, I want to add a category or source without touching the engine.*
✔ Taxonomy, attribute registry and mappings are data; adapters are the only place source specifics live.

## 6. Non-goals

Customer-facing catalogue pages; price comparison shown to customers; ML/image matching; hosting product images; automated review decisions beyond the proven rules; collecting from any source without a lawful route.

## 7. UX notes

* The **dashboard** is a snapshot with its time shown; numbers link to nothing yet (a future browser would).
* The **review queue** shows both sides, the score, the rule and every hard conflict, with three plain buttons (*Same product / Different product / Same family*); a decision is sent in place and the page refreshes.
* Wording avoids jargon in the UI ("Possible duplicates awaiting a person"); technical terms live in the docs.
* Not yet visually verified in a running dev server: the pilot environment's repository drive was full, so the page was verified by rendering the component tree in tests, not by a browser. Do a visual pass before wider use.

## 8. Milestones

| Milestone | Content | Status |
|---|---|---|
| **M0 — Pilot** | Schema, pipeline, matching, quality, API, dashboard, export, tests, docs; real open-data pilot on a local database | **Done** |
| M1 — First licensed feed | Agreement for one partner/manufacturer/GS1 feed; onboard by mapping; category coverage beyond food | Needs a decision and an agreement |
| M2 — Steward tooling | Product browser/detail, promote button, source enable/disable screen | Not started |
| M3 — Scale-up readiness | Loader round-trip reduction / bulk path, scheduler, alerting, staging on a hosted branch | Not started |
| M4 — Large-scale ingestion | Category by category, each gated on M1–M3 | **Not started; needs an explicit go-ahead** |
