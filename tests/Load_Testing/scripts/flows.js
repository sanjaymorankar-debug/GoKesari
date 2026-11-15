// One journey per role. Each call is tagged with a stable name, so the
// summary reports timings per endpoint.
import { group, sleep } from 'k6';
import { FIX, IS_PROD, PUNE, TERMS, TOKENS, get, json, pick, send } from './lib.js';

const think = (min = 1, max = 3) => sleep(min + Math.random() * (max - min));

/** Signed-out shopper: home, nearby, search, shop, products, product page. */
export function guest() {
  let shop = { id: FIX.shopId, slug: FIX.shopSlug };
  let productId = null;
  group('guest', () => {
    get('page /', '/');
    think(0.5, 1.5);
    const [lat, lng] = pick(PUNE);
    const nb = json(get('api nearby', `/api/shops/nearby?lat=${lat}&lng=${lng}&radiusKm=10`));
    if (nb && nb.shops && nb.shops.length) shop = pick(nb.shops.slice(0, 6));
    else if (IS_PROD) return; // no shop near this point on production: nothing more to browse
    get('page /shops/nearby', '/shops/nearby');
    think();
    const q = pick(TERMS);
    get('api search suggest', `/api/search/suggest?q=${q}`);
    get('page /search', `/search?q=${q}`);
    think();
    get('page /shops/[slug]', `/shops/${shop.slug}`);
    const products = json(get('api shop products', `/api/shops/${shop.id}/products`));
    const list = Array.isArray(products) ? products : (products && (products.products || products.items)) || [];
    if (list.length) productId = pick(list).productId;
    if (productId) get('page /products/[id]', `/products/${productId}`);
    get('api shops list', '/api/shops');
    think();
  });
}

/** Signed-in buyer: browse, add to cart, view cart, remove the item, orders, tracking. */
export function buyer() {
  if (!TOKENS.buyer) return guest();
  group('buyer', () => {
    get('page / (signed in)', '/', 'buyer');
    const products = json(get('api shop products', `/api/shops/${FIX.shopId}/products`, 'buyer'));
    const list = Array.isArray(products) ? products.filter((p) => p.isAvailable && p.onlineSaleEnabled) : [];
    think();
    if (list.length) {
      const sp = pick(list);
      send('POST', 'api cart add', '/api/cart', { shopProductId: sp.shopProductId, quantity: 1 }, 'buyer');
      const cart = json(get('api cart', '/api/cart', 'buyer'));
      get('page /cart', '/cart', 'buyer');
      const item = cart && cart.groups && cart.groups.flatMap((g) => g.lines || []).find((i) => i.shopProductId === sp.shopProductId);
      // Every buyer VU shares one account, so another VU may have removed the line already (404).
      if (item) send('DELETE', 'api cart item remove', `/api/cart/items/${item.cartItemId}`, null, 'buyer', [200, 204, 404]);
    }
    think();
    get('api orders', '/api/orders?limit=10', 'buyer');
    get('page /orders', '/orders', 'buyer');
    get('api tracking', `/api/tracking/${FIX.orderId}`, 'buyer');
    get('page /orders/[id]', `/orders/${FIX.orderId}`, 'buyer');
    think();
  });
}

/** Shop owner: dashboard, catalogue page, product list, inventory. */
export function shopOwner() {
  if (!TOKENS.shop) return;
  group('shop owner', () => {
    get('page /shop (dashboard)', '/shop', 'shop');
    think();
    get('page /shop/catalogue', '/shop/catalogue', 'shop');
    get('api owner products', `/api/shops/${FIX.ownerShopId}/products`, 'shop');
    get('api owner inventory', `/api/shops/${FIX.ownerShopId}/inventory`, 'shop');
    think(2, 5);
  });
}

/** Admin and operator: dashboard, orders, shop queues. */
export function staff() {
  const role = Math.random() < 0.5 ? 'admin' : 'ops';
  if (!TOKENS[role]) return;
  group(role, () => {
    get('page /admin/dashboard', '/admin/dashboard', role);
    think();
    get('page /admin/orders', '/admin/orders', role);
    if (role === 'admin') get('api operator shops', '/api/operator/shops', role);
    get('page /admin', '/admin', role);
    think(2, 5);
  });
}
