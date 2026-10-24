import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { ListEditor } from "@/components/purchase-lists/list-editor";
import { AppError, isInvalidUuidInput } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { getPurchaseList, type PurchaseListDetail } from "@/server/services/purchase-lists";

export const metadata = { title: "My list" };
export const dynamic = "force-dynamic";

/** docs/purchase-lists-2026-10: one list — update the quantities, check the total, order. */
export default async function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { id } = await params;

  let list: PurchaseListDetail;
  try {
    list = await getPurchaseList(user.id, id);
  } catch (error) {
    // Another customer's list, or a malformed id in the URL: nothing by that id exists.
    if ((error instanceof AppError && error.code === "NOT_FOUND") || isInvalidUuidInput(error)) notFound();
    throw error;
  }

  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/lists" className="font-medium text-kesari-700 hover:underline">
          ← My lists
        </Link>
      </p>
      <ListEditor
        list={{
          id: list.id,
          name: list.name,
          kind: list.kind,
          frequency: list.frequency,
          remind: list.remind,
          lastOrderedAt: list.lastOrderedAt?.toISOString() ?? null,
          nextDueAt: list.nextDueAt.toISOString(),
        }}
        initialItems={list.items}
      />
    </>
  );
}
