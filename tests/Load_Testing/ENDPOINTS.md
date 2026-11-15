# Endpoints covered by the load tests

Taken from the codebase (`src/app/**/page.tsx`, `src/app/api/**/route.ts`) and
checked against test.gokesari.com on 01-Nov-2026. "k6 name" is the tag used in
the reports.

## Customer / guest (public)

| k6 name | Method + path | Notes |
|---|---|---|
| page / | GET `/` | home page, `force-dynamic` |
| api nearby | GET `/api/shops/nearby?lat=&lng=&radiusKm=10` | Pune points around 18.52, 73.85. 60 requests/min per IP. Calls OpenStreetMap. |
| page /shops/nearby | GET `/shops/nearby` | page shell; the data comes from the API |
| api search suggest | GET `/api/search/suggest?q=` | 120 requests/min per IP |
| page /search | GET `/search?q=` | records the search |
| page /shops/[slug] | GET `/shops/<slug>` | shop page |
| api shop products | GET `/api/shops/<id>/products` | product listing of a shop |
| page /products/[id] | GET `/products/<productId>` | product page |
| api shops list | GET `/api/shops` | all approved shops |
| page /signin | GET `/signin` | Lighthouse only (sign-in codes are emailed, not load-tested) |

## Customer (signed in; TEST only)

| k6 name | Method + path | Notes |
|---|---|---|
| page / (signed in) | GET `/` | |
| api cart add | POST `/api/cart` `{shopProductId, quantity}` | |
| api cart | GET `/api/cart` | |
| page /cart | GET `/cart` | |
| api cart item remove | DELETE `/api/cart/items/<cartItemId>` | |
| api cart validate | GET `/api/cart/validate` | checkout.js |
| api checkout | POST `/api/checkout` `{requestId, addressId, paymentMethod}` | checkout.js only; 15 per minute per account |
| api order cancel | POST `/api/orders/<id>/cancel` | checkout.js cancels every order it places |
| api orders | GET `/api/orders?limit=10` | |
| page /orders | GET `/orders` | |
| api tracking | GET `/api/tracking/<orderId>` | order status |
| page /orders/[id] | GET `/orders/<id>` | |

## Shop owner (TEST only)

| k6 name | Method + path |
|---|---|
| page /shop (dashboard) | GET `/shop` |
| page /shop/catalogue | GET `/shop/catalogue` |
| api owner products | GET `/api/shops/<ownShopId>/products` |
| api owner inventory | GET `/api/shops/<ownShopId>/inventory` |

The product upload (`/api/v1/product-imports`, `/api/excel-uploads`) is not
load-tested: it writes catalogue rows into the seller database.

## Admin and operator (TEST only)

| k6 name | Method + path | Notes |
|---|---|---|
| page /admin/dashboard | GET `/admin/dashboard` | admin and operator |
| page /admin/orders | GET `/admin/orders` | |
| page /admin | GET `/admin` | |
| api operator shops | GET `/api/operator/shops` | admin (operator gets 403 by design) |

## Accounts

The scripts use the saved staging sessions in `<repo>/.e2e-auth/staging-*.json`,
written by `scripts/qa/signin-staging.ts` (see the `gokesari-qa-signin` skill).
On 01-Nov-2026:

| file | account | role now |
|---|---|---|
| staging-customer.json | `+gk-lc14` | SHOP_OWNER (used as the buyer; shop owners may place personal orders) |
| staging-customer2.json | `+gk-cust` | DELIVERY_PARTNER (not used) |
| staging-shop.json | `+gk-shop` | SHOP_OWNER |
| staging-admin.json | `+gk-admin` | ADMIN |
| staging-ops.json | `+gk-ops` | OPERATOR |

Production never loads these sessions (`lib.js` refuses).
