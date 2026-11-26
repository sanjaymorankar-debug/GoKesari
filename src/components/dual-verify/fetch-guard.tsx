"use client";

import { useEffect, useState } from "react";

import { DualStepUpDialog, type StepUpRequest } from "./step-up-dialog";

type Pending = { request: StepUpRequest; resolve: (ok: boolean) => void };

/**
 * docs/dual-auth-2026-11: one place for every screen. Wraps window.fetch for this site's /api calls:
 *   - 403 with details.stepUp = "DUAL" (a sensitive action): opens the two-code dialog, then repeats the same
 *     request once and hands that answer to the screen as if nothing happened (Cancel → the original 403);
 *   - 403 with details.dualAuth = "NEEDS_SECOND_FACTOR": goes to the DualVerify page, which comes back here.
 * Mounted once in the root layout while dual_auth is in force for a signed-in person.
 */
export function DualAuthFetchGuard() {
  const [pending, setPending] = useState<Pending | null>(null);

  useEffect(() => {
    const w = window as unknown as { __gkRawFetch?: typeof fetch; __gkDualGuard?: boolean };
    if (w.__gkDualGuard) return;
    w.__gkDualGuard = true;
    const original = window.fetch.bind(window);
    w.__gkRawFetch = original;

    const ask = (request: StepUpRequest) => new Promise<boolean>((resolve) => setPending({ request, resolve }));

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const replay = input instanceof Request ? input.clone() : null;
      const res = await original(input, init);
      if (res.status !== 403) return res;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let path = "";
      try {
        const u = new URL(url, window.location.href);
        if (u.origin !== window.location.origin) return res;
        path = u.pathname;
      } catch {
        return res;
      }
      if (!path.startsWith("/api/") || path.startsWith("/api/dual-auth/")) return res;
      const details = (await res.clone().json().catch(() => null))?.error?.details as Record<string, unknown> | undefined;
      if (!details) return res;
      if (details.dualAuth === "NEEDS_SECOND_FACTOR") {
        const here = window.location.pathname + window.location.search;
        window.location.assign(`/account/verify?return=${encodeURIComponent(here)}`);
        return res;
      }
      if (details.stepUp !== "DUAL") return res;
      const verified = await ask({
        action: String(details.action ?? ""),
        actionLabel: (details.actionLabel as string) ?? null,
        maskedPhone: (details.maskedPhone as string) ?? null,
        maskedEmail: (details.maskedEmail as string) ?? null,
      });
      if (!verified) return res;
      return replay ? original(replay) : original(input, init);
    };
    return () => {
      window.fetch = original;
      w.__gkDualGuard = false;
    };
  }, []);

  if (!pending) return null;
  return (
    <DualStepUpDialog
      request={pending.request}
      onDone={(ok) => {
        pending.resolve(ok);
        setPending(null);
      }}
    />
  );
}
