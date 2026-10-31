/**
 * docs/app-install-2026-10: the app's own update check (plain TypeScript — no
 * device needed). The website says which version is newest per platform
 * (GET /api/app/version, src/app/api/app/version/route.ts at the repository
 * root); on iPhone the App Store's own answer wins once the app is listed.
 *
 * The page inside the app is the live website, so most changes need no app
 * update at all; this is for new native builds (permissions, new bridges).
 */

export interface ReleaseInfo {
  latest: string | null;
  minimum: string | null;
  url: string | null;
}

export type UpdateDecision =
  | { kind: "none" }
  /** A newer build exists: "Update" or "Later". */
  | { kind: "optional"; version: string; url: string }
  /** This build is below the minimum: only "Update". */
  | { kind: "required"; version: string; url: string };

function parse(value: string | null | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value?.trim() ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Same rule as compareVersions in src/lib/app-install.ts (website). */
export function compareVersions(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The App Store listing's version, when Apple's lookup answered with one. */
export interface AppStoreListing {
  version: string;
  url: string;
}

/** Reads Apple's https://itunes.apple.com/lookup?bundleId=… answer. */
export function parseAppStoreLookup(body: unknown): AppStoreListing | null {
  const first = (body as { results?: { version?: unknown; trackViewUrl?: unknown }[] } | null)?.results?.[0];
  if (typeof first?.version !== "string" || typeof first.trackViewUrl !== "string" || !parse(first.version)) return null;
  return first.trackViewUrl.startsWith("https://") ? { version: first.version, url: first.trackViewUrl } : null;
}

export function decideUpdate(current: string, info: ReleaseInfo | null, appStore: AppStoreListing | null = null): UpdateDecision {
  const latest = appStore?.version ?? info?.latest ?? null;
  const url = appStore?.url ?? info?.url ?? null;
  if (!latest || !url || !parse(current)) return { kind: "none" };
  if (info?.minimum && compareVersions(current, info.minimum) < 0) return { kind: "required", version: latest, url };
  return compareVersions(current, latest) < 0 ? { kind: "optional", version: latest, url } : { kind: "none" };
}

/** Play Store web links open in the Play Store app (market://), where "Update" is one tap. */
export function storeOpenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const id = parsed.hostname === "play.google.com" ? parsed.searchParams.get("id") : null;
    return id ? `market://details?id=${encodeURIComponent(id)}` : url;
  } catch {
    return url;
  }
}

/** Checks at launch and when the app comes back to the screen, at most this often. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
