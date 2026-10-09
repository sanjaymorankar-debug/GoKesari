"use client";

import { useEffect, useRef, useState } from "react";

export type FinishMobileSignIn = (input: {
  code: string;
  verifier: string;
}) => Promise<{ error?: string } | void>;

/**
 * Runs inside the app's WebView once the system browser has handed back a
 * sign-in code. The app puts the code and its PKCE verifier in the URL
 * fragment, which never reaches a server log; they are cleared from the
 * address before anything else happens.
 */
export function MobileAuthFinisher({ finish }: { finish: FinishMobileSignIn }) {
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const params = new URLSearchParams(window.location.hash.slice(1));
    const code = params.get("code") ?? "";
    const verifier = params.get("verifier") ?? "";
    window.history.replaceState(null, "", window.location.pathname);

    finish({ code, verifier })
      // On success the server action redirects and never returns here.
      .then((result) => setError(result?.error ?? null))
      .catch(() => setError("Could not sign you in. Please try again."));
  }, [finish]);

  if (!error) {
    return <p className="mt-4 text-sm text-ink-500" role="status">Signing you in…</p>;
  }
  return (
    <div className="mt-4">
      <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
        {error}
      </p>
      <a href="/signin" className="mt-4 inline-block text-sm font-medium text-kesari-700 underline">
        Back to sign in
      </a>
    </div>
  );
}
