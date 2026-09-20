# REST API specification

The machine-readable contract is [openapi.yaml](./openapi.yaml) (OpenAPI 3.0.3; a unit test fails if it stops matching the routes on disk). This page is the human guide.

## Conventions

| | |
|---|---|
| Base path | `/api/product-master` — the brief's bare `/products` is already the marketplace catalogue's path (`/api/products`), so the master lives beside it, not on top of it |
| Auth | The application's signed-in session. Every route calls `requirePermission(...)`; there is no anonymous access |
| Format | JSON in, JSON out. Responses are the payload itself (no `{data}` wrapper) |
| Ids | `MASTER_PRODUCT_ID` (`GKS-PROD-000000001`) in URLs — never a database key. Brands `GKS-BRND-…`, manufacturers `GKS-MFR-…` |
| Money | Integer minor units (paise) plus `currency`. A missing value is `null`, never `0` |
| Pagination | Keyset: pass `nextCursor` as `cursor`. Stable and constant-cost at any depth (measured: page 1 and page 900,000 of a 1M master both ~2 ms) |
| Errors | `{ "error": { "code", "message", "details?" } }` — `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 CONFLICT`, `422 VALIDATION_FAILED`, `500 INTERNAL` (detail logged server-side only) |
| Input | Zod schemas with unknown keys **rejected**; a mistyped field name fails loudly instead of importing nothing |

## Permissions

| Permission | Granted to | Allows |
|---|---|---|
| `pmd:view` | Operator, Admin | Every read endpoint, and the two dry-run endpoints (`match`, `validate`) |
| `pmd:review` | Operator, Admin | Resolving review-queue items (merges) |
| `pmd:promote` | Operator, Admin | Putting a master product into the marketplace catalogue |
| `pmd:import` | Admin | Bulk import into the master |

Shop owners and customers have no access to the master; shops pick from the live catalogue as before.

## Endpoints

The brief lists 13 endpoints; the mapping is below. Two are deliberately nested under a product instead of top-level (`/offers`, `/price-history`): an offer or a price point means nothing without its product, and a global list of every offer is not a use case the platform serves.

| Brief | Implemented | Notes |
|---|---|---|
| `GET /products` | `GET /api/product-master/products` | Filters: brand, manufacturer, category (includes descendants), status, minQuality, hasGtin |
| `GET /products/{id}` | `GET /api/product-master/products/{id}` | Full record with provenance |
| `GET /products/search` | `GET /api/product-master/products/search?q=` | Identifier → keyword → fuzzy |
| `GET /offers` | `GET /api/product-master/products/{id}/offers` | `?current=true` hides delisted offers |
| `GET /price-history` | `GET /api/product-master/products/{id}/price-history` | `?from=&to=&limit=`; returns lowest / highest / average |
| `GET /brands` | `GET /api/product-master/brands` | `?q=` matches any spelling seen |
| `GET /categories` | `GET /api/product-master/categories` | `?level=` `?parent=` |
| `GET /manufacturers` | `GET /api/product-master/manufacturers` | |
| `POST /products/import` | `POST /api/product-master/products/import` | ≤ 1,000 rows/call; admin |
| `POST /products/match` | `POST /api/product-master/products/match` | Dry run; writes nothing |
| `POST /products/validate` | `POST /api/product-master/products/validate` | Pure; writes nothing |
| `GET /data-quality` | `GET /api/product-master/data-quality` | Snapshot refreshed after every run |
| *(added)* | `GET /review`, `POST /review/{candidateId}` | The possible-duplicate queue and its resolution |
| *(added)* | `POST /products/{id}/promote` | Master → marketplace catalogue |

## Examples

The *validate* example is the real output for its input. The search, match and review examples show the response **shape** with illustrative values.

**Search** — `GET /api/product-master/products/search?q=amul taaza 1 l`

```json
{
  "query": "amul taaza 1 l",
  "items": [
    { "masterProductId": "GKS-PROD-000000412", "productName": "Amul Taaza Toned Milk 1 L", "brand": "Amul",
      "categoryPath": ["Dairy", "Milk", "Toned Milk"], "gtin": "08901262010010", "packSize": "1000 ml",
      "productStatus": "ACTIVE", "dataQualityScore": 74.2, "offerCount": 2, "minPriceMinor": 6400,
      "currency": "INR", "sourceCount": 2, "matchType": "KEYWORD", "score": 50.061 }
  ]
}
```

`matchType` says how the hit was found, and `score` orders the results: an exact identifier hit is `100`, a keyword hit is `50 +` its text-search rank (0–1), a fuzzy hit is `0 +` its trigram similarity (0–1). Read it as an ordering, not a probability.

**Validate** — `POST /api/product-master/products/validate`

```json
{ "product": { "sourceProductId": "X-1", "name": "Acme Mustard Oil 1 L", "gtin": "8901235000089",
               "gstRate": "12%", "offer": { "price": 400, "mrp": 350 } } }
```
```json
{ "valid": true, "wouldBeLoaded": true,
  "issues": [
    { "field": "brand", "code": "BRAND_MISSING", "severity": "INFO", "message": "No brand supplied." },
    { "field": "gtin", "code": "GTIN_CHECK_DIGIT_INVALID", "severity": "WARNING", "message": "GTIN check digit is wrong; not used for matching.", "original": "8901235000089" },
    { "field": "category", "code": "CATEGORY_UNMAPPED", "severity": "INFO", "message": "No standard category matched; filed as Uncategorised." },
    { "field": "gst", "code": "GST_RATE_LEGACY", "severity": "INFO", "message": "GST slab is no longer current.", "original": "12%" },
    { "field": "offer.price", "code": "PRICE_ABOVE_MRP", "severity": "WARNING", "message": "Selling price is above the MRP.", "original": "40000 > 35000" } ],
  "normalized": { "name": "Acme Mustard Oil 1 L", "coreName": "acme mustard oil", "brand": null, "gtin14": "08901235000089",
                  "gtinUsableForMatching": false, "packLabel": "1000 ml", "categoryCode": "uncategorised/unmapped",
                  "gstRateBp": 1200, "hsnCode": null, "countryOfOrigin": null,
                  "attributes": [ { "key": "volume_ml", "value": 1000, "unit": "ml" }, { "key": "gst_rate_bp", "value": 1200, "unit": "bp" } ] } }
```

(Prices in `original` are in paise. This is the actual output of the endpoint's function for that input.)

**Match (dry run)** — the decision, and *why*

```json
{ "decision": { "action": "CREATE_AND_QUEUE", "reason": "POSSIBLE_DUPLICATE", "linksTo": null },
  "thresholds": { "autoMerge": 92, "possible": 70 },
  "candidates": [
    { "masterProductId": "GKS-PROD-000000031", "productName": "Sunrise Toned Milk 500 ml", "score": 78.4,
      "status": "POSSIBLE_MATCH", "relation": "SAME_PRODUCT", "rule": "L4_FUZZY",
      "hardConflicts": [], "notes": ["BRAND_UNKNOWN"] } ] }
```

**Resolve a review item** — `POST /api/product-master/review/57` `{ "decision": "CONFIRMED_SAME", "note": "same carton" }`

```json
{ "candidateId": 57, "decision": "CONFIRMED_SAME",
  "merged": { "fromProductId": 902, "intoProductId": 31, "sourcesMoved": 1, "offersMoved": 1, "historyRowsMoved": 4, "specsMoved": 6 } }
```

## Promotion rules (`POST /products/{id}/promote`)

* Eligible only if the master is `ACTIVE`, its quality score is at least `minQuality` (default 40), it has a standard category, and the marketplace has an operational category for that department.
* If the live catalogue already holds a product with the same GTIN — **in any written form** (UPC-A, EAN-13, GTIN-14) — it is *adopted* (`200`, `adopted: true`) instead of duplicated (`201` for a new one).
* Marketplace prices are never copied. An MRP crosses only from a manufacturer, GS1 or government source, and lands as `PENDING_VERIFICATION`.
* The audit row is written in the same transaction as the catalogue insert; a failure rolls both back.

## Not implemented (deliberately, for now)

* No webhook or push notification when a run finishes — the dashboard and `GET /data-quality` show run status.
* No public/partner API keys: the master is an internal platform behind the operator/admin roles.
* No bulk-export endpoint: use `npm run pmd:export` (Excel, partitioned beyond 1,048,576 rows).
