import Link from "next/link";
import { redirect } from "next/navigation";

import { CreateListForm } from "@/components/purchase-lists/create-list-form";
import { Badge, Card, PageHeader } from "@/components/ui";
import { FREQUENCY_LABEL, KIND_EMOJI, KIND_LABEL, formatListDate, type ListKind } from "@/lib/purchase-lists";
import { getCurrentUser } from "@/server/authz/guards";
import { listPurchaseLists, type PurchaseListSummary } from "@/server/services/purchase-lists";

export const metadata = { title: "My lists" };
export const dynamic = "force-dynamic";

const SECTIONS: { kind: ListKind; title: string; empty: string }[] = [
  {
    kind: "SHOPPING",
    title: "Shopping lists",
    empty: "Groceries, dairy, bakery — whatever you buy every week or every month.",
  },
  {
    kind: "MEDICINE",
    title: "Medicine lists",
    empty: "Regular medicines for you and your family, reordered in a few taps.",
  },
];

/**
 * docs/purchase-lists-2026-10: the customer's weekly / monthly lists. Each
 * time they update the quantities, check the live total and confirm — the
 * list goes to the cart and they pay at checkout as usual.
 */
export default async function ListsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const { kind } = await searchParams;
  const lists = await listPurchaseLists(user.id);
  const now = new Date();

  return (
    <>
      <PageHeader
        title="My lists"
        description="Keep a weekly or monthly list of what you buy — groceries or medicines. Each time, just update the quantities, check the total and order."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-8">
          {SECTIONS.map((section) => {
            const ofKind = lists.filter((l) => l.kind === section.kind);
            return (
              <section key={section.kind} data-testid={`lists-${section.kind.toLowerCase()}`}>
                <h2 className="mb-3 text-lg font-semibold text-ink-900">
                  <span aria-hidden>{KIND_EMOJI[section.kind]}</span> {section.title}
                </h2>
                {ofKind.length === 0 ? (
                  <Card className="p-5 text-sm text-ink-600">{section.empty} Create one with the form.</Card>
                ) : (
                  <ul className="grid gap-3 sm:grid-cols-2">
                    {ofKind.map((list) => (
                      <li key={list.id}>
                        <ListCard list={list} now={now} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
        <aside>
          <Card className="p-4">
            <h2 className="mb-3 text-base font-semibold text-ink-900">Create a list</h2>
            <CreateListForm defaultKind={kind === "MEDICINE" ? "MEDICINE" : "SHOPPING"} />
          </Card>
        </aside>
      </div>
    </>
  );
}

function ListCard({ list, now }: { list: PurchaseListSummary; now: Date }) {
  const due = list.activeItemCount > 0 && list.nextDueAt <= now;
  return (
    <Link
      href={`/lists/${list.id}`}
      data-testid="list-card"
      className="block h-full rounded-xl border border-cream-200 bg-white p-4 shadow-sm transition-colors hover:border-kesari-300"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-ink-900">{list.name}</p>
        <Badge tone={list.frequency === "WEEKLY" ? "info" : "neutral"}>{FREQUENCY_LABEL[list.frequency]}</Badge>
      </div>
      <p className="mt-1 text-sm text-ink-600">
        {list.itemCount === 0
          ? "No products yet"
          : `${list.itemCount} product${list.itemCount === 1 ? "" : "s"}${
              list.activeItemCount < list.itemCount ? ` · ${list.itemCount - list.activeItemCount} skipped this time` : ""
            }`}
      </p>
      <p className="mt-2 text-xs text-ink-500">
        {KIND_LABEL[list.kind]} ·{" "}
        {list.lastOrderedAt ? `Last ordered ${formatListDate(list.lastOrderedAt, now)} · ` : ""}
        {due ? (
          <span className="font-semibold text-kesari-700">Due now</span>
        ) : (
          `Next due ${formatListDate(list.nextDueAt, now)}`
        )}
      </p>
    </Link>
  );
}
