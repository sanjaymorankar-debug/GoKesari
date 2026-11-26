import { notFound } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { flowF17On } from "@/server/aftercare/support-tickets";
import { RecoverForm } from "./recover-form";

export const metadata = { title: "Recover your account" };
export const dynamic = "force-dynamic";

/**
 * docs/flows-v3/wave1.md (flag flow_f17; 404 while it is off): for someone who can no longer use either the mobile
 * number or the e-mail of their account. The request goes to support as a ticket with an identity document.
 */
export default async function RecoverAccountPage() {
  if (!(await flowF17On())) notFound();
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <PageHeader
        title="Lost your mobile and e-mail?"
        description="If you can use neither the mobile number nor the e-mail of your GoKesari account, tell us here. Our support team checks your identity document and contacts you at the e-mail you give."
      />
      <RecoverForm />
    </div>
  );
}
