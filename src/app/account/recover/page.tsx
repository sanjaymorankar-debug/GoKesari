import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { flowF17On } from "@/server/aftercare/support-tickets";
import { flowF18On } from "@/server/flows/wave5-flags";
import { FactorRecovery } from "./factor-recovery";
import { RecoverForm } from "./recover-form";

export const metadata = { title: "Recover your account" };
export const dynamic = "force-dynamic";

/**
 * docs/flows-v3/wave1.md (flag flow_f17): for someone who can no longer use either the mobile number or the e-mail
 * of their account. The request goes to support as a ticket with an identity document.
 * docs/flows-v3/wave5.md (flag flow_f18): also "lost my mobile" / "lost my e-mail", done online with codes.
 * 404 while both flags are off.
 */
export default async function RecoverAccountPage() {
  const [both, one] = await Promise.all([flowF17On(), flowF18On()]);
  if (!both && !one) notFound();
  return (
    <div className="mx-auto max-w-xl space-y-8 px-4 py-8">
      {one ? (
        <section>
          <PageHeader
            title="Lost your mobile or your e-mail?"
            description="If you can still use one of them, we send a code there, then you set the new one with a code sent to it. Your account is then signed out on every device."
          />
          <FactorRecovery />
        </section>
      ) : null}
      {both ? (
        <section>
          <PageHeader
            title="Lost your mobile and e-mail?"
            description="If you can use neither the mobile number nor the e-mail of your GoKesari account, tell us here. Our support team checks your identity document and contacts you at the e-mail you give."
          />
          <RecoverForm />
        </section>
      ) : null}
    </div>
  );
}
