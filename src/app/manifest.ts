import type { MetadataRoute } from "next";

/**
 * Makes the site installable as an app from the browser: on iPhone, Safari →
 * Share → Add to Home Screen opens it full-screen with the GoKesari name and
 * icon (the way to have GoKesari on an iPhone without the App Store, see
 * mobile/README.md); Chrome on Android offers "Install app". The colours match
 * the root layout's theme colour and the page background.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "GoKesari — Everything for Everyone",
    short_name: "GoKesari",
    description: "Every local shop near you, in one directory. Wallet payments and flexible daily subscriptions.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fffdf7",
    theme_color: "#f97316",
    icons: [
      { src: "/pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
