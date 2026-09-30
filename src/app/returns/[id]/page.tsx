import { notFound, redirect } from "next/navigation";

import { ReturnCase } from "@/components/return-case";
import { LinkButton, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getReturnDetail } from "@/server/services/returns";

export const metadata = { title: "Return" };
export const dynamic = "force-dynamic";

export default async function ReturnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const detail = await getReturnDetail(id, user).catch(() => null);
  if (!detail) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Return ${detail.ret.returnNumber}`}
        action={<LinkButton href="/returns" variant="secondary">All returns</LinkButton>}
      />
      <ReturnCase detail={detail} />
    </div>
  );
}
