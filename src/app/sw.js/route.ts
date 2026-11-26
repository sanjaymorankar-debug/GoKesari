/**
 * docs/app-install-2026-10: the service worker of the installed web app
 * (Android "Install app", iPhone "Add to Home Screen").
 *
 * Every deploy changes GK_BUILD_VERSION (next.config.ts: the commit), so this
 * script's bytes change and the browser installs the new worker by itself.
 * docs/silent-update-2026-11: the new worker takes over at once
 * (skipWaiting + clients.claim) and nobody is asked anything; the page
 * switches to the new version at a safe moment (src/components/app-install/
 * app-auto-update.tsx). The same commit always gives the same bytes, so a
 * rebuild with no change triggers no update.
 *
 * What it caches: only the build's own static files (/_next/static, hashed,
 * never changing) and the app icons, in a cache named after the version.
 * The previous version's cache is kept (a tab still open on it may need its
 * files); older ones are deleted. Pages are network-first — a page is never
 * served from a cache; offline, a small "You are offline" page shows instead.
 * API calls (/api: cart, orders, wallet, sign-in, notifications, seller and
 * admin data) are never touched by the worker.
 */
export const dynamic = "force-static";

const VERSION = process.env.GK_BUILD_VERSION ?? "dev";

const SCRIPT = `/* GoKesari service worker — version ${VERSION} */
const VERSION = ${JSON.stringify(VERSION)};
const CACHE = "gk-static-" + VERSION;

const OFFLINE_PAGE =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Offline · GoKesari</title></head>" +
  '<body style="font-family:system-ui,sans-serif;background:#fffaf2;color:#1c1917;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;text-align:center;padding:16px">' +
  '<div><h1 style="font-size:20px">You are offline</h1><p>Check your internet connection and try again.</p>' +
  '<button onclick="location.reload()" style="height:44px;padding:0 20px;border:0;border-radius:12px;background:#c2410c;color:#fff;font-weight:700;font-size:16px">Try again</button></div>' +
  "</body></html>";

self.addEventListener("install", () => {
  // Silent update: no waiting for anyone.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        // Keep this version's cache and the newest older one (a tab still on it may need its files).
        const older = keys.filter((k) => k.startsWith("gk-static-") && k !== CACHE);
        return Promise.all(older.slice(0, -1).map((k) => caches.delete(k)));
      })
      .then(() => (self.registration.navigationPreload ? self.registration.navigationPreload.enable().catch(() => {}) : null))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "GET_VERSION" && event.source) event.source.postMessage({ type: "VERSION", version: VERSION });
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    // Pages: always the network (never a cached page); the offline page only when there is no network.
    event.respondWith(
      Promise.resolve(event.preloadResponse)
        .then((preloaded) => preloaded || fetch(request))
        .catch(() => new Response(OFFLINE_PAGE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })),
    );
    return;
  }
  if (!url.pathname.startsWith("/_next/static/") && !url.pathname.startsWith("/pwa/")) return;
  event.respondWith(
    // Any version's cache: a tab still on the previous version finds its files after a deploy.
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
`;

export function GET(): Response {
  return new Response(SCRIPT, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // The browser checks the worker on every launch; it must never get a cached copy.
      "cache-control": "no-cache, no-store, must-revalidate",
    },
  });
}
