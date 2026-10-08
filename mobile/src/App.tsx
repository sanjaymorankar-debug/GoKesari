/**
 * GoKesari for Android and iOS.
 *
 * The app shows the website (gokesari.com, or test.gokesari.com in the
 * preview build), so every feature the site has — shopping, wallet,
 * subscriptions, shop owner, delivery partner and admin tools — is in the app
 * the moment it ships on the web. This file adds what a bare WebView lacks:
 * Google sign-in through the system browser, UPI and other app links, native
 * share/print/location/downloads (bridge.ts), deep links, the Android back
 * button, and an offline screen.
 */
import * as Crypto from "expo-crypto";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, BackHandler, KeyboardAvoidingView, Linking, Platform, StyleSheet, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import type {
  FileDownloadEvent,
  ShouldStartLoadRequest,
  WebViewErrorEvent,
  WebViewMessageEvent,
  WebViewNavigation,
  WebViewOpenWindowEvent,
  WebViewProgressEvent,
} from "react-native-webview/lib/WebViewTypes";

import {
  LocationWatches,
  currentPosition,
  print,
  saveFile,
  share,
  type BridgeError,
  type BridgeMessage,
} from "./bridge";
import { buildBridgeScript } from "./bridge-script";
import { APP_VERSION, COLORS, SITE_URL, UA_TOKEN } from "./config";
import { signInWithGoogle } from "./google-sign-in";
import { decideNavigation, decideNewWindow, playStoreUrl, type NavigationDecision } from "./navigation-policy";
import { OfflineScreen } from "./OfflineScreen";
import { bytesToBase64Url } from "./pkce";
import { originOf, parseUrl, sameOrigin } from "./url";

void SplashScreen.preventAutoHideAsync().catch(() => {});
SplashScreen.setOptions({ fade: true, duration: 250 });

const SITE_ORIGIN = originOf(parseUrl(SITE_URL)!);
/** Errors that are not a failed page: a navigation the app cancelled itself, a download taking over. */
const IGNORED_LOAD_ERRORS = Platform.OS === "ios" ? [-999, 102, 204] : [-10];

/** A link to one of the website's pages (App Link / Universal Link), or null. */
function sitePageUrl(link: string | null): string | null {
  if (!link) return null;
  const parsed = parseUrl(link);
  if (!parsed || originOf(parsed) !== SITE_ORIGIN) return null;
  if (parsed.path.startsWith("/api/") || parsed.path.startsWith("/mobile-auth/")) return null;
  return link;
}

function toBridgeError(error: unknown): BridgeError {
  if (error && typeof error === "object" && "message" in error) {
    const { name, code, message } = error as BridgeError;
    return { name, code, message: String(message) };
  }
  return { message: "Something went wrong." };
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  const insets = useSafeAreaInsets();
  const webView = useRef<WebView>(null);
  /** Per-launch secret the page bridge must quote (see bridge-script.ts). */
  const token = useMemo(() => bytesToBase64Url(Crypto.getRandomBytes(24)), []);
  const bridgeScript = useMemo(
    () =>
      buildBridgeScript({
        siteOrigin: SITE_ORIGIN,
        token,
        platform: Platform.OS === "ios" ? "ios" : "android",
        version: APP_VERSION,
      }),
    [token],
  );

  /** The URL the WebView is (re)created with; `webViewKey` forces a fresh WebView. */
  const [source, setSource] = useState<{ uri: string } | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [offline, setOfflineState] = useState(false);
  const [progress, setProgress] = useState(0);

  const canGoBack = useRef(false);
  const loaded = useRef(false);
  const currentUrl = useRef(SITE_URL);
  const offlineRef = useRef(false);
  const setOffline = useCallback((value: boolean) => {
    offlineRef.current = value;
    setOfflineState(value);
  }, []);

  /* ------------------------------------------------------------ plumbing */

  const sendToPage = useCallback((message: Record<string, unknown>) => {
    webView.current?.injectJavaScript(
      `window.__gokesariApp && window.__gokesariApp.receive(${JSON.stringify(message)}); true;`,
    );
  }, []);

  const watches = useRef<LocationWatches | null>(null);
  useEffect(() => {
    const current = new LocationWatches(sendToPage);
    watches.current = current;
    return () => current.stopAll();
  }, [sendToPage]);

  /** Opens a website URL in the WebView. */
  const navigate = useCallback((url: string) => {
    if (loaded.current && !offlineRef.current && webView.current) {
      webView.current.injectJavaScript(`window.location.assign(${JSON.stringify(url)}); true;`);
    } else {
      loaded.current = false;
      setOffline(false);
      setSource({ uri: url });
      setWebViewKey((key) => key + 1);
    }
  }, [setOffline]);

  const openOutside = useCallback(
    async (decision: Extract<NavigationDecision, { action: "open-outside" }>) => {
      try {
        await Linking.openURL(decision.url);
        return;
      } catch {
        // No app for it: try the page's fallback, then the store.
      }
      if (decision.fallbackUrl) return navigate(decision.fallbackUrl);
      if (decision.storePackage) {
        try {
          await Linking.openURL(playStoreUrl(decision.storePackage));
          return;
        } catch {
          // fall through to the alert
        }
      }
      Alert.alert("Can't open this link", "There is no app on this phone that can open it.");
    },
    [navigate],
  );

  const startGoogleSignIn = useCallback(async () => {
    const result = await signInWithGoogle();
    if (result.status === "success") navigate(result.finishUrl);
    else if (result.status === "failed") Alert.alert("Google sign-in", result.message);
  }, [navigate]);

  const follow = useCallback(
    (decision: NavigationDecision, url: string) => {
      switch (decision.action) {
        case "load":
          navigate(url);
          return;
        case "google-sign-in":
          void startGoogleSignIn();
          return;
        case "open-outside":
          void openOutside(decision);
          return;
        case "block":
          return;
      }
    },
    [navigate, openOutside, startGoogleSignIn],
  );

  /* --------------------------------------------------------- start & links */

  useEffect(() => {
    let cancelled = false;
    Linking.getInitialURL()
      .catch(() => null)
      .then((link) => {
        if (!cancelled) setSource({ uri: sitePageUrl(link) ?? SITE_URL });
      });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      // `<scheme>://auth-callback` belongs to the sign-in in progress (expo-web-browser handles it).
      const page = sitePageUrl(url);
      if (page) navigate(page);
    });
    // Never leave the splash screen up if the first page is slow or fails.
    const splashFallback = setTimeout(() => void SplashScreen.hideAsync().catch(() => {}), 10_000);
    return () => {
      cancelled = true;
      subscription.remove();
      clearTimeout(splashFallback);
    };
  }, [navigate]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!offlineRef.current && canGoBack.current && webView.current) {
        webView.current.goBack();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, []);

  /* ------------------------------------------------------- WebView events */

  const onShouldStartLoadWithRequest = useCallback(
    (request: ShouldStartLoadRequest) => {
      const decision = decideNavigation(request.url, SITE_ORIGIN, request.isTopFrame ?? true);
      if (decision.action === "load") return true;
      follow(decision, request.url);
      return false;
    },
    [follow],
  );

  const onOpenWindow = useCallback(
    (event: WebViewOpenWindowEvent) => {
      const url = event.nativeEvent.targetUrl;
      follow(decideNewWindow(url, SITE_ORIGIN), url);
    },
    [follow],
  );

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let message: BridgeMessage & { token?: unknown };
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      if (!message || message.token !== token || !sameOrigin(event.nativeEvent.url, SITE_ORIGIN)) return;

      const reply = (result: unknown, error?: BridgeError) => {
        if (typeof message.id === "number") sendToPage({ type: "reply", id: message.id, result, error });
      };
      try {
        switch (message.type) {
          case "hello":
            watches.current?.stopAll();
            return;
          case "share":
            await share(message);
            return reply(true);
          case "saveFile":
            await saveFile(message);
            return reply(true);
          case "print":
            await print(message);
            return reply(true);
          case "geo.current":
            return reply(await currentPosition(message));
          case "geo.watch":
            watches.current?.start(Number(message.watchId), message.options);
            return;
          case "geo.clearWatch":
            watches.current?.stop(Number(message.watchId));
            return;
          case "openExternal":
            if (typeof message.url === "string") follow(decideNewWindow(message.url, SITE_ORIGIN), message.url);
            return;
          case "signInWithGoogle":
            await startGoogleSignIn();
            return reply(true);
          case "downloadFailed":
            Alert.alert("Download failed", typeof message.message === "string" ? message.message : "Please try again.");
            return;
          default:
            return;
        }
      } catch (error) {
        reply(undefined, toBridgeError(error));
      }
    },
    [follow, sendToPage, startGoogleSignIn, token],
  );

  /** iOS: a response the WebView cannot show (Content-Disposition: attachment). Android downloads natively. */
  const onFileDownload = useCallback(
    (event: FileDownloadEvent) => {
      const url = event.nativeEvent.downloadUrl;
      if (sameOrigin(url, SITE_ORIGIN)) sendToPage({ type: "download", url });
      else void Linking.openURL(url).catch(() => {});
    },
    [sendToPage],
  );

  const onNavigationStateChange = useCallback((state: WebViewNavigation) => {
    canGoBack.current = state.canGoBack;
    if (state.url && !state.url.startsWith("about:")) currentUrl.current = state.url;
  }, []);

  const onLoadEnd = useCallback(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);

  const onLoad = useCallback(() => {
    loaded.current = true;
    setOffline(false);
  }, [setOffline]);

  const onError = useCallback((event: WebViewErrorEvent) => {
    // Handle it here instead of react-native-webview's default error view.
    event.preventDefault();
    if (IGNORED_LOAD_ERRORS.includes(event.nativeEvent.code)) return;
    setOffline(true);
  }, [setOffline]);

  const onLoadProgress = useCallback((event: WebViewProgressEvent) => {
    setProgress(event.nativeEvent.progress);
  }, []);

  /** Recreate the WebView where it was: after a failed load, or when the OS killed its renderer. */
  const restart = useCallback(() => {
    loaded.current = false;
    setOffline(false);
    setSource({ uri: currentUrl.current });
    setWebViewKey((key) => key + 1);
  }, [setOffline]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex}
        // Android is edge-to-edge (the window no longer shrinks for the keyboard);
        // iOS's WebView moves its own content.
        behavior={Platform.OS === "android" ? "padding" : undefined}
        enabled={Platform.OS === "android"}
      >
        {source ? (
          <WebView
            key={webViewKey}
            ref={webView}
            source={source}
            style={styles.flex}
            originWhitelist={["*"]}
            applicationNameForUserAgent={`${UA_TOKEN}/${APP_VERSION} (${Platform.OS})`}
            injectedJavaScriptBeforeContentLoaded={bridgeScript}
            injectedJavaScript={bridgeScript}
            onMessage={onMessage}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onOpenWindow={onOpenWindow}
            onFileDownload={onFileDownload}
            onNavigationStateChange={onNavigationStateChange}
            onLoad={onLoad}
            onLoadEnd={onLoadEnd}
            onLoadProgress={onLoadProgress}
            onError={onError}
            onRenderProcessGone={restart}
            onContentProcessDidTerminate={() => webView.current?.reload()}
            javaScriptCanOpenWindowsAutomatically
            domStorageEnabled
            geolocationEnabled
            allowsBackForwardNavigationGestures
            allowsLinkPreview={false}
            allowsInlineMediaPlayback
            pullToRefreshEnabled
            decelerationRate="normal"
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            downloadingMessage="Downloading…"
            lackPermissionToDownloadMessage="GoKesari needs storage permission to save files."
            webviewDebuggingEnabled={__DEV__}
          />
        ) : null}
        {progress > 0 && progress < 1 && !offline ? (
          <View pointerEvents="none" style={[styles.progress, { width: `${Math.round(progress * 100)}%` }]} />
        ) : null}
        {offline ? <OfflineScreen onRetry={restart} /> : null}
      </KeyboardAvoidingView>
      <View style={{ height: insets.bottom, backgroundColor: COLORS.cream }} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  flex: { flex: 1 },
  progress: { position: "absolute", top: 0, left: 0, height: 2, backgroundColor: COLORS.kesari },
});
