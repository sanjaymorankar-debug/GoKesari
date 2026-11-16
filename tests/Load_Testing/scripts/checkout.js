// Order placement timing on TEST only: add to cart → validate → checkout
// (wallet by default) → order status → cancel the order straight away.
// The app allows 15 checkouts a minute per account, so this measures the
// latency of one buyer placing orders back to back, not throughput.
//
//   bin/k6 run -e ORDERS=8 scripts/checkout.js
import { sleep } from 'k6';
import { BASE, FIX, IS_PROD, TOKENS, get, json, send } from './lib.js';

if (IS_PROD) throw new Error('checkout.js places orders: TEST only.');

export const options = {
  scenarios: { checkout: { executor: 'per-vu-iterations', vus: 1, iterations: Number(__ENV.ORDERS || 8), maxDuration: '10m' } },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
  thresholds: {
    'http_req_duration{name:api checkout}': ['p(95)<3000'],
    'http_req_duration{name:api order cancel}': ['p(95)<3000'],
    checks: ['rate>0.95'],
  },
};

export function setup() {
  if (!TOKENS.buyer) throw new Error('No saved buyer session (.e2e-auth/staging-customer.json).');
  send('DELETE', 'api cart clear', '/api/cart', null, 'buyer');
  const addresses = json(get('api addresses', '/api/addresses', 'buyer'));
  const list = (addresses && addresses.addresses) || [];
  const address = list.find((a) => a.isDefault) || list[0];
  const products = json(get('api shop products', `/api/shops/${FIX.shopId}/products`, 'buyer')) || [];
  const sp = products.find((p) => p.isAvailable && p.onlineSaleEnabled);
  if (!address || !sp) throw new Error('No address or available product for the buyer.');
  return { addressId: address.id, shopProductId: sp.shopProductId };
}

export default function (data) {
  send('POST', 'api cart add', '/api/cart', { shopProductId: data.shopProductId, quantity: 1 }, 'buyer');
  get('api cart validate', '/api/cart/validate', 'buyer', [200]);
  const requestId = `k6-${Date.now()}-${__ITER}-${Math.floor(Math.random() * 1e6)}`;
  const r = send('POST', 'api checkout', '/api/checkout', {
    // WALLET by default: cancelling refunds the wallet, and the account's COD slots may be taken.
    requestId, addressId: data.addressId, paymentMethod: __ENV.PAY || 'WALLET',
    notes: 'k6 performance test order - cancelled automatically',
    acknowledgeClosedShopIds: [FIX.shopId],
  }, 'buyer');
  const body = json(r);
  const orders = (body && body.orders) || [];
  if (!orders.length) console.warn(`checkout ${r.status}: ${String(r.body).slice(0, 300)}`);
  for (const o of orders) {
    get('api tracking', `/api/tracking/${o.id}`, 'buyer');
    send('POST', 'api order cancel', `/api/orders/${o.id}/cancel`, { reason: 'k6 performance test' }, 'buyer');
  }
  send('DELETE', 'api cart clear', '/api/cart', null, 'buyer');
  sleep(5); // stays under the 15-a-minute checkout limit
}

export function teardown() {
  console.log(`checkout test finished against ${BASE}`);
}
