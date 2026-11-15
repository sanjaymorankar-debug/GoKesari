// Shared settings for the GoKesari k6 scripts.
//   BASE   https://test.gokesari.com (default) or https://gokesari.com
// Signed-in flows use the saved staging sessions in <repo>/.e2e-auth
// (written by scripts/qa/signin-staging.ts from the normal emailed code).
// They are never loaded for production.
import http from 'k6/http';
import { check } from 'k6';

export const BASE = (__ENV.BASE || 'https://test.gokesari.com').replace(/\/$/, '');
export const IS_PROD = /\/\/(www\.)?gokesari\.com$/.test(BASE);

// Fixed points around Pune (around 18.52, 73.85). A small fixed set keeps the
// app's OpenStreetMap address cache warm, so the test does not flood Nominatim.
export const PUNE = [
  [18.52, 73.85], [18.5204, 73.8567], [18.53, 73.84], [18.51, 73.86],
  [18.525, 73.86], [18.55, 73.94], [18.5, 73.83], [18.56, 73.81],
];
export const TERMS = ['milk', 'bread', 'rice', 'atta', 'sugar', 'oil', 'tea', 'soap', 'dal', 'eggs'];

// Staging fixtures (test.gokesari.com) found on 01-Nov-2026.
export const FIX = {
  shopId: '976135a1-ef87-4059-8ca7-2989db8724af',
  shopSlug: 'e2e-four-features-bakery-d31pf',
  ownerShopId: 'ee2d8026-ca0b-4bbe-9eb5-ccc183abcb70',
  orderId: 'a879e27a-aca2-41e8-b717-8e2e5ec78b82',
};

const COOKIE = '__Secure-authjs.session-token';
function sessionToken(role) {
  if (IS_PROD) return null;
  try {
    const state = JSON.parse(open(`../../../.e2e-auth/staging-${role}.json`));
    const c = state.cookies.find((x) => x.name === COOKIE);
    return c ? c.value : null;
  } catch (_) {
    return null;
  }
}
// "customer" is the buyer (now a shop owner — shop owners may place personal orders).
export const TOKENS = {
  buyer: sessionToken('customer'),
  shop: sessionToken('shop'),
  admin: sessionToken('admin'),
  ops: sessionToken('ops'),
};

// One client IP per VU, so each VU counts as its own visitor against the
// app's per-IP limits (the app keys them on the first X-Forwarded-For value).
export function vuIp() {
  return `10.77.${Math.floor(__VU / 250) % 250}.${(__VU % 250) + 1}`;
}

export function params(name, role, extra = {}) {
  const headers = { 'X-Forwarded-For': vuIp(), 'User-Agent': 'GoKesari-k6-perf/1.0', ...(extra.headers || {}) };
  if (role && TOKENS[role]) headers.Cookie = `${COOKIE}=${TOKENS[role]}`;
  if (extra.json) headers['Content-Type'] = 'application/json';
  return { headers, tags: { name, role: role || 'guest' }, redirects: 5, timeout: '30s' };
}

export function get(name, path, role, ok = [200]) {
  const r = http.get(`${BASE}${path}`, params(name, role));
  check(r, { [`${name} ${ok.join('/')}`]: (x) => ok.includes(x.status) }, { name });
  return r;
}

export function send(method, name, path, body, role, ok = [200, 201]) {
  const r = http.request(method, `${BASE}${path}`, body == null ? null : JSON.stringify(body), params(name, role, { json: true }));
  check(r, { [`${name} ${ok.join('/')}`]: (x) => ok.includes(x.status) }, { name });
  return r;
}

export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export function json(r) {
  try {
    const d = r.json();
    return d && d.data !== undefined && !Array.isArray(d) ? d.data : d;
  } catch (_) {
    return null;
  }
}
