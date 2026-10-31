/**
 * docs/app-install-2026-10: the service worker of the installed web app
 * (Android "Install app", iPhone "Add to Home Screen").
 *
 * Every deploy changes GK_BUILD_VERSION (next.config.ts), so this script's
 * bytes change and the browser installs the new worker by itself on the next
 * launch or page load. The page then offers "Reload" (src/components/
 * app-install/update-prompt.tsx); when nobody presses it, the new version
 * takes over the next time the app is opened. Nobody reinstalls anything.
 *
 * What it caches: only the build's own static files (/_next/static, hashed,
 * never changing) and the app icons, in a cache named after the version —
 * older versions' caches are deleted when the new worker takes over. Pages
 * and API calls always go to the network, so prices, stock, orders and
 * sign-in are never served stale.
 */
export const dynamic = "force-static";

const VERSION = process.env.GK_BUILD_VERSION ?? "dev";

const SCRIPT = `/* GoKesari service worker — version ${VERSION} */
const VERSION = ${JSON.stringify(VERSION)};
const CACHE = "gk-static-" + VERSION;

self.addEventListener("install", () => {
  // Wait for the page's "Reload" (SKIP_WAITING) or the next launch.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("gk-static-") && k !== CACHE).map((k) => caches.delete(k))))
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
  if (!url.pathname.startsWith("/_next/static/") && !url.pathname.startsWith("/pwa/")) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          }),
      ),
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
