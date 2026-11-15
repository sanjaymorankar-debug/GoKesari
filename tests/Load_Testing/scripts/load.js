// GoKesari performance test: smoke, load or stress, all four roles.
//
//   bin/k6 run -e PROFILE=smoke  scripts/load.js
//   bin/k6 run -e PROFILE=load   -e PEAK=50  scripts/load.js
//   bin/k6 run -e PROFILE=stress -e PEAK=300 scripts/load.js        (TEST only)
//   scripts/run-guarded.sh test-stress-1000 -e PROFILE=stress -e PEAK=1000 -e ABORT=0 scripts/load.js
//   bin/k6 run -e BASE=https://gokesari.com -e PROFILE=baseline scripts/load.js
//
// Traffic mix at the peak: 60% guests, 25% signed-in buyers, 10% shop owners,
// 5% admin/operator. Production runs guests only (read-only, light).
import { buyer, guest, shopOwner, staff } from './flows.js';
import { IS_PROD } from './lib.js';

const PROFILE = __ENV.PROFILE || 'smoke';
const PEAK = Number(__ENV.PEAK || (PROFILE === 'stress' ? 300 : PROFILE === 'baseline' ? 10 : 50));

if (IS_PROD && !['smoke', 'baseline'].includes(PROFILE)) {
  throw new Error(`PROFILE=${PROFILE} is refused on production: run smoke or baseline there.`);
}

function stagesFor(share) {
  const n = (x) => Math.max(1, Math.round(x * share));
  if (PROFILE === 'load') {
    return [{ duration: '2m', target: n(PEAK) }, { duration: '5m', target: n(PEAK) }, { duration: '1m', target: 0 }];
  }
  if (PROFILE === 'stress') {
    // Step up until it breaks; the abort thresholds stop the run early.
    return [
      { duration: '1m', target: n(PEAK * 0.17) }, { duration: '2m', target: n(PEAK * 0.17) },
      { duration: '1m', target: n(PEAK * 0.33) }, { duration: '2m', target: n(PEAK * 0.33) },
      { duration: '1m', target: n(PEAK * 0.67) }, { duration: '2m', target: n(PEAK * 0.67) },
      { duration: '1m', target: n(PEAK) }, { duration: '2m', target: n(PEAK) },
      { duration: '1m', target: 0 },
    ];
  }
  // baseline
  return [{ duration: '1m', target: n(PEAK) }, { duration: '3m', target: n(PEAK) }, { duration: '30s', target: 0 }];
}

function scenario(exec, share) {
  if (PROFILE === 'smoke') return { executor: 'per-vu-iterations', vus: 1, iterations: 2, exec, maxDuration: '5m' };
  return { executor: 'ramping-vus', startVUs: 0, stages: stagesFor(share), exec, gracefulRampDown: '30s' };
}

const scenarios = IS_PROD
  ? { guest: scenario('guestFlow', 1) }
  : {
      guest: scenario('guestFlow', 0.6),
      buyer: scenario('buyerFlow', 0.25),
      shop_owner: scenario('shopFlow', 0.1),
      staff: scenario('staffFlow', 0.05),
    };

// -e ABORT=0 keeps a stress run going past its error and latency limits, so it
// reaches the full PEAK; run it through run-guarded.sh, which still stops it if
// production slows down.
const abort = PROFILE === 'stress' && __ENV.ABORT !== '0' ? { abortOnFail: true, delayAbortEval: '1m' } : {};

export const options = {
  scenarios,
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01' }, ...(PROFILE === 'stress' ? [{ threshold: 'rate<0.15', ...abort }] : [])],
    http_req_duration: [{ threshold: 'p(95)<1000' }, ...(PROFILE === 'stress' ? [{ threshold: 'p(95)<15000', ...abort }] : [])],
    'http_req_duration{name:api nearby}': ['p(95)<1500'],
    'http_req_duration{name:api search suggest}': ['p(95)<800'],
    'http_req_duration{name:page /}': ['p(95)<2000'],
    'http_req_duration{name:api cart add}': ['p(95)<1500'],
    checks: ['rate>0.99'],
  },
};

export const guestFlow = guest;
export const buyerFlow = buyer;
export const shopFlow = shopOwner;
export const staffFlow = staff;
