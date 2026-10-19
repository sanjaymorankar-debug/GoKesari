import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Two builds from one codebase, chosen by APP_VARIANT (set per profile in
 * eas.json). They have different app ids and URL schemes, so both can be
 * installed on one phone.
 *
 *   production (default)  "GoKesari"       https://gokesari.com       com.gokesari.app
 *   preview               "GoKesari Test"  https://test.gokesari.com  com.gokesari.app.preview
 *
 * The scheme must be one the website accepts (MOBILE_APP_SCHEMES in
 * src/lib/mobile-app.ts at the repository root).
 */
const VARIANTS = {
  production: {
    name: "GoKesari",
    appId: "com.gokesari.app",
    scheme: "gokesari",
    host: "gokesari.com",
  },
  preview: {
    name: "GoKesari Test",
    appId: "com.gokesari.app.preview",
    scheme: "gokesari-preview",
    host: "test.gokesari.com",
  },
} as const;

const variant = process.env.APP_VARIANT === "preview" ? VARIANTS.preview : VARIANTS.production;

/**
 * The Expo project this app builds under: replace with the id
 * `npx eas-cli@latest init` prints (README.md, "First-time setup").
 */
const EAS_PROJECT_ID: string | undefined = process.env.EAS_PROJECT_ID;

/**
 * Website pages that open in the app when tapped as links on Android (App
 * Links). Listed rather than "everything" so /api/… (file downloads, the
 * emailed sign-in link) and /mobile-auth/… (the browser half of Google
 * sign-in) always stay in the browser. Add a prefix here when the website
 * gains a new top-level page. iOS reads the same rule from the website's
 * /.well-known/apple-app-site-association.
 */
const APP_LINK_PATH_PREFIXES = [
  "/about",
  "/admin",
  "/bakery",
  "/cart",
  "/categories",
  "/category",
  "/contact",
  "/dairy",
  "/delivery/",
  "/delivery-partner",
  "/disputes",
  "/gig",
  "/grievance",
  "/invoices",
  "/legal",
  "/notifications",
  "/onboarding",
  "/operator",
  "/orders",
  "/product-categories",
  "/products",
  "/profile",
  "/r/",
  "/refer",
  "/returns",
  "/search",
  "/sell",
  "/shop",
  "/signin",
  "/society",
  "/subscribe",
  "/subscriptions",
  "/wallet",
  "/manufacturer", // batch-2026-10 WS-D (manufacturer portal, F9.1.2)
  "/support", // batch-2026-10 WS-C: help desk portal
];

/**
 * Deep-link route map (F15.2.3): what shared links point at — product, shop,
 * order, invite/referral, notification and help-desk ticket. Same list as
 * DEEP_LINK_ROUTES in src/lib/deep-links.ts (website) and src/deep-links.ts.
 * Pages not (yet) top-level directories of the website, such as the help
 * desk's /support/tickets/…, are listed here so the intent filter has them.
 */
const DEEP_LINK_ROUTE_PREFIXES = ["/products/", "/shops/", "/orders/", "/r/", "/refer", "/notifications", "/support/tickets/", "/search/compare"];

const INTENT_PATH_PREFIXES = [...new Set([...APP_LINK_PATH_PREFIXES, ...DEEP_LINK_ROUTE_PREFIXES])];

/**
 * Firebase settings for Android push (google-services.json). On EAS, upload the
 * file as a secret file variable named GOOGLE_SERVICES_JSON; without it the
 * app builds and runs, and push stays unavailable on Android.
 */
const GOOGLE_SERVICES_JSON: string | undefined = process.env.GOOGLE_SERVICES_JSON;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant.name,
  slug: "gokesari",
  // 1.1.0: bulk product upload (Excel/CSV) for shop owners, operators and admins — the website's
  // screens, with the phone's own document picker (Android: Files, Drive, WhatsApp and e-mail
  // attachments through the system picker; iPhone: Files).
  // 1.2.0: push notifications (expo-notifications), camera inside pages for QR scanning, deep-link
  // route map (product, shop, order, referral, notification, ticket).
  // 1.3.0: the website's new home (docs/homepage-uiux-2026-10 at the repository root) — voice search
  // on iPhone (microphone and speech-recognition descriptions below; the site shows the mic only to
  // 1.3.0 and later), "compare prices" links open in the app, white strip under the bottom navigation.
  version: "1.3.0",
  scheme: variant.scheme,
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  backgroundColor: "#ffffff",
  ios: {
    bundleIdentifier: variant.appId,
    // Local builds (the GitHub workflows); EAS store builds number themselves (eas.json appVersionSource "remote").
    buildNumber: "4",
    supportsTablet: true,
    associatedDomains: [`applinks:${variant.host}`],
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSCameraUsageDescription:
        "GoKesari uses the camera when you take a photo to upload, such as a product picture or a proof of delivery, and to scan an order's QR code.",
      NSPhotoLibraryUsageDescription:
        "GoKesari opens your photos when you choose a picture to upload, such as a product picture or a document.",
      NSPhotoLibraryAddUsageDescription: "GoKesari saves a picture to your photos when you ask it to.",
      // 1.3.0: voice search in the header search (the page's Web Speech API, in English, Hindi or Marathi).
      NSMicrophoneUsageDescription: "GoKesari listens only while you tap the microphone in search, to search by voice.",
      NSSpeechRecognitionUsageDescription: "GoKesari turns what you say into a search when you tap the microphone in search.",
    },
  },
  android: {
    package: variant.appId,
    versionCode: 4,
    ...(GOOGLE_SERVICES_JSON ? { googleServicesFile: GOOGLE_SERVICES_JSON } : {}),
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
      backgroundColor: "#ffffff",
    },
    // With predictive back, Android would animate leaving the app even when
    // the back press only goes to the previous website page.
    predictiveBackGestureEnabled: false,
    // Location (expo-location) and storage for downloads on Android 9 and
    // older (expo-file-system) come from the libraries. Photo uploads hand
    // off to the camera app; CAMERA is for pages that use the camera
    // themselves (QR scanning with getUserMedia) — the WebView asks for it
    // the first time a page wants the camera. Notifications (Android 13+)
    // come from expo-notifications. Drawing over other apps is only for
    // Expo's development menu; pages never record audio.
    permissions: ["android.permission.CAMERA"],
    blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.SYSTEM_ALERT_WINDOW"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        category: ["BROWSABLE", "DEFAULT"],
        data: [
          { scheme: "https", host: variant.host, path: "/" },
          ...INTENT_PATH_PREFIXES.map((pathPrefix) => ({ scheme: "https", host: variant.host, pathPrefix })),
        ],
      },
    ],
  },
  plugins: [
    "expo-web-browser",
    "expo-sharing",
    [
      "expo-notifications",
      {
        // Android's small notification icon: white on transparent.
        icon: "./assets/android-icon-monochrome.png",
        color: "#c9450c",
        defaultChannel: "default",
        // iOS push environment: only the development-client profile is signed for development;
        // ad-hoc (preview) and App Store builds use APNs production.
        mode: process.env.EAS_BUILD_PROFILE === "development" ? "development" : "production",
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 220,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
      },
    ],
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "GoKesari uses your location to show shops near you and fill in your delivery address. Delivery partners share it while they are on duty so customers can follow their order.",
        // Foreground only: no "always" location, no motion activity.
        locationAlwaysAndWhenInUsePermission: false,
        locationAlwaysPermission: false,
        motionUsagePermission: false,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
        isAndroidForegroundServiceEnabled: false,
      },
    ],
  ],
  extra: {
    siteUrl: `https://${variant.host}`,
    scheme: variant.scheme,
    appVariant: variant === VARIANTS.preview ? "preview" : "production",
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});
