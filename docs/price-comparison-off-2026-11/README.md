# Price comparison between local shops — switched off (24-Nov-2026)

Owner decision, 24-Nov-2026: customers are not shown price comparisons between
local shops. Everything sits behind the feature flag
**`local_price_comparison_enabled`**, seeded **OFF** on both sites by migration
`0200_local_price_comparison_off` (a missing row also reads as off).

| Surface | Flag off | Flag on |
|---|---|---|
| "Compare N prices" link on product cards (home tiles, search, category, shop pages) | not shown (`nearbyOfferCounts` returns nothing) | shown from 2 nearby shops |
| `/search/compare` (and `?product=`) | **404** | comparison page |
| Home comparison block (rule `homePriceComparison`) | empty (`homePriceComparison` returns `[]`) | per the rule |
| "Compare prices" chip, board tile, account drawer, phone bottom-bar tab | hidden | shown |
| Home banner leading to `/search/compare` (built-in or admin-made) | dropped | shown |
| Product page | "Shops selling this", nearest-first, no "Lowest price" (`data-mode="nearest"`) | "Compare prices", cheapest-first, "Lowest price" (`data-mode="price"`) |

No JSON API serves the comparison: the pages render it on the server, and the
one service behind them (`src/server/services/price-comparison.ts`) refuses
while the flag is off, so nothing leaks through another caller.

**Not affected:** the smart shopping list's own comparison
(`/wishlist/[id]/compare`, `/api/smart-list/wishlists/[id]/compare`) keeps its
own flag, `smart_list_scan_enabled`.

**Mobile app:** the Android / iOS app is a WebView of the site, so it follows
the flag with no app release. Its deep-link list still accepts
`/search/compare` links (old shares); they open the page, which answers 404
while the flag is off.

**Switching it on:** Admin → Feature flags → "Price comparison between local
shops", with a reason (audited). Takes effect within 15 s.

Tests: `tests/integration/price-comparison-flag-off.test.ts`; QA
`TC-PCOMP-001…003` (`tests/qa/guest/price-comparison-off.spec.ts`, production-safe).
