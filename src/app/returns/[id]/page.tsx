import { notFound, redirect } from "next/navigation";

import { ReturnCase } from "@/components/return-case";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getReturnDetail } from "@/server/services/returns";
import { FlowAction } from "@/components/flows-v3/flow-action";
import { declinedReturnDisputeState } from "@/server/flows/f16-cancellations";

export const metadata = { title: "Return" };
export const dynamic = "force-dynamic";

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getReturnDetail(id, user).catch(() => null);
  if (!detail) notFound();
  // docs/flows-v3/wave2.md (flag flow_f16): a declined return can be taken to a dispute.
  const dispute = await declinedReturnDisputeState(id, user.id);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Return ${detail.ret.returnNumber}`}
        action={<LinkButton href="/returns" variant="secondary">All returns</LinkButton>}
      />
      <ReturnCase detail={detail} />
      {dispute.canDispute ? (
        <div className="mt-4" data-testid="flows-v3-return-dispute">
          <p className="mb-2 text-sm text-ink-600">Do you disagree with the shop&apos;s decision? Our team will review it.</p>
          <FlowAction
            url={`/api/returns/${id}/dispute`}
            label="Disagree — open a dispute"
            noteLabel="What went wrong?"
            noteField="description"
            noteRequired
            doneText="Dispute opened. You can follow it under My orders."
          />
        </div>
      ) : dispute.disputeId ? (
        <p className="mt-4 text-sm text-ink-600">A dispute is open for this return.</p>
      ) : null}
    </div>
  );
}
