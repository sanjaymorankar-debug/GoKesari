import { notFound } from "next/navigation";

import { JoinStatusView } from "@/components/registration/join-status";
import { PageHeader } from "@/components/ui";
import { AppError } from "@/lib/errors";
import { registrationStatus } from "@/server/registration/service";

export const metadata = { title: "Your shop registration" };
export const dynamic = "force-dynamic";

/** Module 3: the applicant's private registration page (the token in the link is the access). */
export default async function JoinStatusPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;
  let status;
  try {
    status = await registrationStatus(token);
  } catch (error) {
    if (error instanceof AppError) notFound();
    throw error;
  }
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Your shop registration" description={status.shopName} />
      <JoinStatusView token={token} initial={JSON.parse(JSON.stringify(status))} returnedFromGateway={typeof query.order_id === "string"} />
    </div>
  );
}
