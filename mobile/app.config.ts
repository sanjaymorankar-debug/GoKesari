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
  "/shop",
  "/signin",
  "/society",
  "/subscribe",
  "/subscriptions",
  "/wallet",
];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: variant.name,
  slug: "gokesari",
  version: "1.0.0",
  scheme: variant.scheme,
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  backgroundColor: "#ffffff",
  ios: {
    bundleIdentifier: variant.appId,
    supportsTablet: true,
    associatedDomains: [`applinks:${variant.host}`],
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSCameraUsageDescription:
        "GoKesari uses the camera when you take a photo to upload, such as a product picture or a proof of delivery.",
      NSPhotoLibraryUsageDescription:
        "GoKesari opens your photos when you choose a picture to upload, such as a product picture or a document.",
      NSPhotoLibraryAddUsageDescription: "GoKesari saves a picture to your photos when you ask it to.",
    },
  },
  android: {
    package: variant.appId,
    adaptiveIcon: {
      foregroundImage: "./assets/android-icon-foreground.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
      backgroundColor: "#ffffff",
    },
    // With predictive back, Android would animate leaving the app even when
    // the back press only goes to the previous website page.
    predictiveBackGestureEnabled: false,
    // Location (expo-location) and storage for downloads on Android 9 and
    // older (expo-file-system) come from the libraries. The camera needs no
    // permission: photo uploads hand off to the camera app. Drawing over
    // other apps is only for Expo's development menu.
    blockedPermissions: ["android.permission.RECORD_AUDIO", "android.permission.SYSTEM_ALERT_WINDOW"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        category: ["BROWSABLE", "DEFAULT"],
        data: [
          { scheme: "https", host: variant.host, path: "/" },
          ...APP_LINK_PATH_PREFIXES.map((pathPrefix) => ({ scheme: "https", host: variant.host, pathPrefix })),
        ],
      },
    ],
  },
  plugins: [
    "expo-web-browser",
    "expo-sharing",
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
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});
