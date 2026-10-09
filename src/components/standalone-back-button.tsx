"use client";

import { usePathname, useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/** True only in a home-screen web app on iPhone/iPad (Safari's "Add to Home Screen"). */
function useIosHomeScreenApp(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => (navigator as Navigator & { standalone?: boolean }).standalone === true,
    () => false,
  );
}

/**
 * Opened from the iPhone home screen, the site runs full-screen with no
 * browser toolbar, so there is no Back button. This puts one in the header —
 * there only: browsers have their own, Android has the system back button,
 * and the native app (mobile/) has its own back handling.
 */
export function StandaloneBackButton() {
  const homeScreenApp = useIosHomeScreenApp();
  const pathname = usePathname();
  const router = useRouter();
  if (!homeScreenApp || pathname === "/") return null;

  return (
    <button
      type="button"
      aria-label="Back"
      data-testid="standalone-back"
      onClick={() => (window.history.length > 1 ? router.back() : router.push("/"))}
      className="-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-700 hover:bg-cream-100"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );
}
