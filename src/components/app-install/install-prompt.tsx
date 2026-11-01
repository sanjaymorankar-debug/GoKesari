"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  decideInstallPrompt,
  INSTALL_STORAGE,
  installPlatform,
  readDeclines,
  type InstallEvent,
  type InstallPlatform,
  type StoreLinks,
} from "@/lib/app-install";
import { LANG_TAG, tr, UI, type Lang } from "@/lib/board/i18n";

import { Icon, type IconName } from "../board/icons";

/** Chrome's install event (not in TypeScript's DOM types). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Chrome can fire beforeinstallprompt before this component mounts; the inline
 * script in the root layout (INSTALL_EVENT_CATCHER) keeps that early event here.
 */
type EarlyInstallWindow = Window & { __gkInstallEvent?: BeforeInstallPromptEvent | null };

export const INSTALL_EVENT_CATCHER =
  "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__gkInstallEvent=e;});";

type RelatedAppsNavigator = Navigator & {
  standalone?: boolean;
  getInstalledRelatedApps?: () => Promise<unknown[]>;
};

/** How long to wait for Chrome's install event before deciding which button to show. */
const INSTALL_EVENT_WAIT_MS = 1500;

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the prompt still works for this page view.
  }
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as RelatedAppsNavigator).standalone === true;
}

function postEvent(event: InstallEvent, platform: InstallPlatform) {
  void fetch("/api/app-install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, platform }),
    keepalive: true,
  }).catch(() => {});
}

/**
 * docs/app-install-2026-10: "Get the GoKesari app" — a bottom sheet in the
 * Tile Board style (approved design "Theme 1 Tile Board"): one tile with the
 * app icon chip, a line of text and two buttons. It never covers the page with
 * a backdrop; "Not now" hides it until the next page load, and it comes back
 * on every visit until the app is installed (src/lib/app-install.ts has the rules).
 */
export function AppInstallPrompt({ lang, signedIn, stores }: { lang: Lang; signedIn: boolean; stores: StoreLinks }) {
  const deferred = useRef<BeforeInstallPromptEvent | null>(null);
  const [ready, setReady] = useState(false);
  const [hasInstallEvent, setHasInstallEvent] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [relatedAppInstalled, setRelatedAppInstalled] = useState(false);
  const [installedOnDevice, setInstalledOnDevice] = useState(false);
  const [accountInstalledOn, setAccountInstalledOn] = useState<InstallPlatform[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [userAgent, setUserAgent] = useState("");
  const [touchPoints, setTouchPoints] = useState(0);

  const platform = installPlatform(userAgent, touchPoints);

  /** Stores an install on this device (and the account); true when it was not recorded before. */
  const recordInstall = useCallback(
    (on: InstallPlatform) => {
      if (storageGet(INSTALL_STORAGE.installed)) return false;
      storageSet(INSTALL_STORAGE.installed, new Date().toISOString());
      if (signedIn) postEvent("installed", on);
      return true;
    },
    [signedIn],
  );
  const markInstalled = useCallback(
    (on: InstallPlatform) => {
      recordInstall(on);
      setInstalledOnDevice(true);
    },
    [recordInstall],
  );

  useEffect(() => {
    const ua = navigator.userAgent;
    const touch = navigator.maxTouchPoints;
    const on = installPlatform(ua, touch);

    // Opened as the installed app: that is the proof of an install. On iPhone the
    // home-screen app has its own storage, so the account record is what tells
    // Safari to stop prompting a signed-in person.
    if (isStandalone()) recordInstall(on);

    const onPrompt = (event: Event) => {
      // Keep Chrome's own mini-bar away; the sheet's Install button opens the dialog.
      event.preventDefault();
      deferred.current = event as BeforeInstallPromptEvent;
      setHasInstallEvent(true);
      // Chrome offers the install only when the app is not installed: an install
      // recorded here earlier was removed since, so prompting starts again.
      if (storageGet(INSTALL_STORAGE.installed)) {
        storageSet(INSTALL_STORAGE.installed, null);
        setInstalledOnDevice(false);
        if (signedIn) postEvent("uninstalled", on);
        setAccountInstalledOn((list) => list.filter((p) => p !== on));
      }
    };
    const onInstalled = () => {
      deferred.current = null;
      setHasInstallEvent(false);
      markInstalled(on);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    const media = window.matchMedia("(display-mode: standalone)");
    const onMedia = () => setStandalone(isStandalone());
    media.addEventListener?.("change", onMedia);

    const checks: Promise<unknown>[] = [new Promise((resolve) => setTimeout(resolve, INSTALL_EVENT_WAIT_MS))];
    const nav = navigator as RelatedAppsNavigator;
    if (typeof nav.getInstalledRelatedApps === "function") {
      checks.push(
        nav
          .getInstalledRelatedApps()
          .then((apps) => setRelatedAppInstalled(Array.isArray(apps) && apps.length > 0))
          .catch(() => {}),
      );
    }
    if (signedIn) {
      checks.push(
        fetch("/api/app-install", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((record: { installedPlatforms?: InstallPlatform[] } | null) => setAccountInstalledOn(record?.installedPlatforms ?? []))
          .catch(() => {}),
      );
    }
    let live = true;
    void Promise.all(checks).then(() => {
      if (!live) return;
      setUserAgent(ua);
      setTouchPoints(touch);
      setStandalone(isStandalone());
      setInstalledOnDevice(Boolean(storageGet(INSTALL_STORAGE.installed)));
      // An install event Chrome fired before this component mounted (INSTALL_EVENT_CATCHER).
      const early = (window as EarlyInstallWindow).__gkInstallEvent;
      if (early) {
        (window as EarlyInstallWindow).__gkInstallEvent = null;
        onPrompt(early);
      }
      setReady(true);
    });

    return () => {
      live = false;
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      media.removeEventListener?.("change", onMedia);
    };
  }, [markInstalled, recordInstall, signedIn]);

  if (!ready || dismissed) return null;
  const decision = decideInstallPrompt({
    userAgent,
    maxTouchPoints: touchPoints,
    standalone,
    relatedAppInstalled,
    installedOnDevice,
    accountInstalledOn,
    hasInstallEvent,
    stores,
  });
  if (!decision.show) return null;

  const notNow = () => {
    const declines = readDeclines(storageGet(INSTALL_STORAGE.declines));
    storageSet(INSTALL_STORAGE.declines, JSON.stringify({ count: declines.count + 1, lastAt: new Date().toISOString() }));
    if (signedIn) postEvent("declined", platform);
    setDismissed(true);
  };

  const install = async () => {
    if (decision.method === "native-prompt" && deferred.current) {
      const event = deferred.current;
      deferred.current = null;
      setHasInstallEvent(false);
      await event.prompt();
      const choice = await event.userChoice.catch(() => ({ outcome: "dismissed" as const }));
      if (choice.outcome === "accepted") markInstalled(platform);
      else notNow();
      return;
    }
    setGuideOpen(true);
  };

  const guide: { icon: IconName; text: string }[] =
    decision.method === "ios-guide"
      ? [
          { icon: "share", text: tr(UI.installIosStep1, lang) },
          { icon: "square-plus", text: tr(UI.installIosStep2, lang) },
          { icon: "circle-check", text: tr(UI.installIosStep3, lang) },
        ]
      : [
          { icon: "ellipsis-vertical", text: tr(UI.installAndroidStep1, lang) },
          { icon: "smartphone", text: tr(UI.installAndroidStep2, lang) },
          { icon: "circle-check", text: tr(UI.installAndroidStep3, lang) },
        ];
  const storeUrl = decision.method === "store" ? (decision.platform === "ios" ? stores.ios : stores.android) : null;

  return (
    <section
      lang={LANG_TAG[lang]}
      role="dialog"
      aria-modal="false"
      aria-labelledby="gk-install-title"
      data-testid="app-install-prompt"
      data-method={decision.method}
      className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:inset-x-auto lg:right-6 lg:bottom-6 lg:w-96 lg:px-0 lg:pb-0"
    >
      <div className="mx-auto max-w-xl rounded-2xl border border-cream-200 border-l-4 border-l-kesari-600 bg-white p-4 shadow-xl shadow-ink-900/15">
        <div className="flex items-start gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-kesari-100 text-kesari-700">
            <Icon name="smartphone" size={26} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="gk-install-title" className="text-base font-bold text-ink-900">
              {tr(UI.installTitle, lang)}
            </h2>
            <p className="mt-0.5 text-sm leading-snug text-ink-700">{tr(UI.installBody, lang)}</p>
          </div>
          <button
            type="button"
            onClick={notNow}
            aria-label={tr(UI.installClose, lang)}
            className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-600 hover:bg-cream-100"
          >
            <Icon name="x" size={20} />
          </button>
        </div>

        {guideOpen ? (
          <div data-testid="app-install-guide" className="mt-3">
            <ol className="grid grid-cols-3 gap-2">
              {guide.map((step, i) => (
                <li key={step.text} className="flex flex-col items-center gap-1 rounded-xl bg-cream-100 px-1.5 py-2 text-center">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-kesari-700">
                    <Icon name={step.icon} size={20} />
                  </span>
                  <span className="text-xs font-semibold leading-tight text-ink-900">
                    {i + 1}. {step.text}
                  </span>
                </li>
              ))}
            </ol>
            {decision.method === "ios-guide" ? <p className="mt-2 text-xs text-ink-600">{tr(UI.installIosHint, lang)}</p> : null}
          </div>
        ) : null}

        <div className="mt-3 flex gap-2">
          {storeUrl ? (
            <a
              href={storeUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="app-install-store"
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800"
            >
              <Icon name="download" size={18} />
              {tr(UI.installStore, lang)}
            </a>
          ) : guideOpen ? null : (
            <button
              type="button"
              onClick={() => void install()}
              data-testid="app-install-button"
              className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800"
            >
              <Icon name="download" size={18} />
              {tr(UI.installButton, lang)}
            </button>
          )}
          <button
            type="button"
            onClick={notNow}
            data-testid="app-install-not-now"
            className="flex h-11 flex-1 items-center justify-center rounded-xl border border-cream-200 bg-white px-4 text-sm font-semibold text-ink-700 hover:bg-cream-100"
          >
            {tr(UI.installNotNow, lang)}
          </button>
        </div>
      </div>
    </section>
  );
}
