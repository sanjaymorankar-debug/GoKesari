import { notFound, redirect } from "next/navigation";

import { DisputeCase } from "@/components/dispute-case";
import { LinkButton, PageHeader } from "@/components/ui";
import { isDisputeTerminal } from "@/lib/dispute-states";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getDispute } from "@/server/services/disputes";

export const metadata = { title: "Dispute" };
export const dynamic = "force-dynamic";

/**
 * Event layer: one dispute case for whichever party is looking — the
 * customer, the shop or support. Internal notes and reviewer identities are
 * withheld by the service for everyone but support.
 */
export default async function DisputePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ opened?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getDispute(id, user).catch((error) => {
    if (error instanceof AppError && error.code === "FORBIDDEN") return null;
    throw error;
  });
  if (!detail) notFound();
  const { dispute } = detail;
  const back =
    detail.viewerParty === "SUPPORT" ? "/admin/disputes" : detail.viewerParty === "SHOP" ? "/shop/disputes" : "/orders";

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={`Dispute ${dispute.caseNumber}`}
        description={`Order ${detail.orderNumber}`}
        action={<LinkButton href={back} variant="secondary">Back</LinkButton>}
      />
      <DisputeCase
        justOpened={(await searchParams).opened === "1"}
        view={{
          id: dispute.id,
          caseNumber: dispute.caseNumber,
          orderNumber: detail.orderNumber,
          shopName: detail.shopName,
          status: dispute.status,
          level: dispute.level,
          reason: dispute.reason,
          description: dispute.description,
          disputedAmountPaise: dispute.disputedAmountPaise,
          createdAt: dispute.createdAt.toISOString(),
          viewerParty: detail.viewerParty,
          closed: isDisputeTerminal(dispute.status),
          images: detail.images,
          comments: detail.comments.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
        }}
      />
    </div>
  );
}
