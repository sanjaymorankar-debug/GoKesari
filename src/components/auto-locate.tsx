"use client";

/**
 * Finds the shopper's location by itself (owner request, 24 Oct 2026: "user
 * location is not detected"). For a visitor or customer with no delivery
 * location yet — nothing chosen and no saved address — on the pages that list
 * shops and products, asks the device for its position and saves it as the
 * delivery location (POST /api/location), then refreshes the page so
 * "Deliver to", shops, banners and "Popular in your area" follow.
 *
 *  - Permission already given: done quietly, no prompt.
 *  - Not answered yet: the browser (or the app) asks once per browser
 *    session — asking on every page makes browsers block the prompt.
 *  - Refused: not asked again; "Find your location", "Deliver to" and the PIN
 *    code box stay.
 * The server keeps a location chosen while the device was still answering
 * (`ifUnset`). Renders nothing.
 */
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { findDevicePosition, isDiscoveryPath, locationPermission, saveDevicePosition } from "@/lib/device-location";

const ASKED_KEY = "gk-locate-asked";

/** One detection at a time across the page, also under React's double effects in development. */
let running = false;

function askedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(ASKED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberAsked(): void {
  try {
    window.sessionStorage.setItem(ASKED_KEY, "1");
  } catch {
    /* private mode: the browser's own prompt limits still apply */
  }
}

export function AutoLocate({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const active = enabled && isDiscoveryPath(pathname);

  useEffect(() => {
    if (!active || running) return;
    running = true;
    void (async () => {
      try {
        const permission = await locationPermission();
        if (permission === "denied") return;
        if (permission !== "granted") {
          if (askedThisSession()) return;
          rememberAsked();
        }
        const found = await findDevicePosition();
        if (!found.ok) return;
        const saved = await saveDevicePosition(found.position, { ifUnset: true });
        if (saved.saved) router.refresh();
      } catch {
        // Nothing saved: "Deliver to" keeps inviting a choice.
      } finally {
        running = false;
      }
    })();
  }, [active, router]);

  return null;
}
