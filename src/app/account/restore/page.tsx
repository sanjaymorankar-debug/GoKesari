import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { Alert, Button, Card } from "@/components/ui";
import { toClientError } from "@/lib/errors";
import { OTP_TICKET_PROVIDER_ID, signIn } from "@/server/auth";
import { createLoginTicket } from "@/server/otp/service";
import {
  formatPurgeDate,
  getPendingDeletion,
  readRestoreTicket,
  restoreAccount,
  RESTORE_COOKIE,
} from "@/server/services/account-deletion";

export const metadata = { title: "Restore my account" };
export const dynamic = "force-dynamic";

/**
 * docs/account-deletion-2026-11 (0199): the screen a person in their deletion
 * cooling-off period reaches after signing in with an emailed code. Nothing else
 * is available to a hidden account: no session exists until "Restore my
 * account" switches it back on. The sign-in page proves the code with a
 * short-lived signed httpOnly cookie (RESTORE_COOKIE, 15 minutes).
 * Works whatever the flag (no one may be left hidden if it is switched off).
 */
export default async function RestoreAccountPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const userId = readRestoreTicket((await cookies()).get(RESTORE_COOKIE)?.value);
  if (!userId) redirect("/signin");
  const pending = await getPendingDeletion(userId);
  if (!pending) redirect("/signin");
  const { error } = await searchParams;
  const date = formatPurgeDate(pending.purgeAfter);

  async function restore() {
    "use server";
    const id = readRestoreTicket((await cookies()).get(RESTORE_COOKIE)?.value);
    if (!id) redirect("/signin");
    const h = await headers();
    try {
      await restoreAccount(id, { id, role: "CUSTOMER" }, {
        by: "SELF",
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: h.get("user-agent"),
      });
    } catch (err) {
      redirect(`/account/restore?error=${encodeURIComponent(toClientError(err).body.error.message)}`);
    }
    (await cookies()).delete({ name: RESTORE_COOKIE, path: "/account/restore" });
    try {
      // The account is ACTIVE again: open its session the normal way.
      await signIn(OTP_TICKET_PROVIDER_ID, { ticket: createLoginTicket(id), redirectTo: "/" });
    } catch (err) {
      if (isRedirectError(err)) throw err;
      redirect("/signin");
    }
  }

  async function keepDeletion() {
    "use server";
    (await cookies()).delete({ name: RESTORE_COOKIE, path: "/account/restore" });
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <Card className="grid gap-4 p-8" data-testid="account-restore">
        <h1 className="text-2xl font-semibold text-ink-900">Your account is scheduled for deletion</h1>
        <p className="text-sm text-ink-700">
          You asked to delete the GoKesari account for <strong>{pending.maskedEmail}</strong>. It is hidden now and will be
          deleted permanently on <strong data-testid="account-restore-date">{date}</strong>.
        </p>
        <p className="text-sm text-ink-700">
          Restore it to use GoKesari again as before. Subscriptions cancelled when you asked for the deletion stay
          cancelled; you can start them again.
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <div className="flex flex-wrap gap-3">
          <form action={restore}>
            <Button type="submit">Restore my account</Button>
          </form>
          <form action={keepDeletion}>
            <Button type="submit" variant="secondary">
              Keep deletion
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
