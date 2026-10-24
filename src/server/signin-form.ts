import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/** The /signin notice a refused sign-in lands on: the suspended-or-closed notice, or a generic one. */
export function signInRefusalPath(error: AuthError): string {
  return `/signin?error=${error.type === "AccessDenied" ? "AccessDenied" : "SignInFailed"}`;
}

/**
 * Runs a sign-in started from a form on /signin. Auth.js redirects a refused
 * sign-in to /signin?error=… itself only on its own routes (Google's return);
 * started from a server action it throws instead, which showed "Something
 * went wrong on our side" — e.g. "Email me a link" for a suspended account
 * (QA TC-AUTH-027). The refusal now lands on the same notice.
 */
export async function signInFromForm(start: () => Promise<unknown>): Promise<void> {
  try {
    await start();
  } catch (error) {
    if (isRedirectError(error)) throw error;
    if (error instanceof AuthError) redirect(signInRefusalPath(error));
    throw error;
  }
}
