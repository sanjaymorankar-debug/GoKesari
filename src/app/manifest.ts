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
    // docs/inventory-accounting-2026-10: once installed, a supplier's bill shared
    // from WhatsApp, email or Files ("Share → GoKesari") lands in the shop's
    // bills to check.
    share_target: {
      action: "/shop/accounts/share",
      method: "POST",
      enctype: "multipart/form-data",
      params: { title: "title", text: "text", files: [{ name: "file", accept: ["application/pdf", "image/*", "application/json", ".json", ".xlsx", ".xls", ".csv"] }] },
    },
    shortcuts: [{ name: "Scan a supplier bill", short_name: "Scan bill", url: "/shop/accounts/capture?mode=scan" }],
  };
}
