import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Card } from "@/components/ui";
import { toClientError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { confirmEmailFactorLink, readEmailFactorLink } from "@/server/dual-auth/verify";

export const metadata = { title: "Verify your e-mail" };
export const dynamic = "force-dynamic";

function safeReturn(value: string | string[] | undefined): string {
  const v = typeof value === "string" ? value : "";
  return v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/account/verify") ? v : "/";
}

/**
 * Login & auth item 4 (owner 27-Nov-2026): the page the e-mailed verification link opens. Opening it changes nothing
 * (mail scanners open links too); pressing Confirm uses the link once and saves the address as the account's verified
 * e-mail. Signed in on this browser: back to the Verify page; otherwise a short "verified" note.
 */
export default async function VerifyEmailLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; return?: string | string[]; done?: string; error?: string }>;
}) {
  const query = await searchParams;
  const t = typeof query.t === "string" ? query.t : "";
  const returnTo = safeReturn(query.return);

  if (query.done) {
    return (
      <div className="mx-auto max-w-md py-6">
        <Card className="p-6" data-testid="email-link-done">
          <h1 className="text-2xl font-semibold text-ink-900">E-mail verified</h1>
          <p className="mt-2 text-sm text-ink-600">Your e-mail is now verified on your GoKesari account.</p>
          <Link href="/signin" className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 underline">
            Sign in to continue
          </Link>
        </Card>
      </div>
    );
  }

  const link = t ? await readEmailFactorLink(t) : null;

  async function confirm() {
    "use server";
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const me = await getCurrentUser();
    let error: string | null = null;
    try {
      await confirmEmailFactorLink(t, ip, me?.id ?? null);
    } catch (caught) {
      error = toClientError(caught).body.error.message;
    }
    if (error) redirect(`/account/verify/email?error=${encodeURIComponent(error)}`);
    redirect(me ? `/account/verify?return=${encodeURIComponent(returnTo)}` : "/account/verify/email?done=1");
  }

  return (
    <div className="mx-auto max-w-md py-6">
      <Card className="p-6">
        <h1 className="text-2xl font-semibold text-ink-900">Verify your e-mail</h1>
        {query.error ? (
          <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900" data-testid="email-link-error">
            {query.error}
          </p>
        ) : link ? (
          <form action={confirm} className="mt-3 space-y-3">
            <p className="text-sm text-ink-600">
              Confirm <strong>{link.maskedEmail}</strong> as the e-mail of your GoKesari account.
            </p>
            <button
              type="submit"
              className="min-h-11 w-full rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-800"
              data-testid="email-link-confirm"
            >
              Confirm my e-mail
            </button>
          </form>
        ) : (
          <p className="mt-3 text-sm text-ink-600" data-testid="email-link-invalid">
            This link is not valid any more. Open the newest link we sent, or ask for a new one on the{" "}
            <Link href="/account/verify" className="underline">
              Verify page
            </Link>
            .
          </p>
        )}
      </Card>
    </div>
  );
}
