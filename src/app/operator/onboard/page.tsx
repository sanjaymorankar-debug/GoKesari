import { redirect } from "next/navigation";

import { OnboardWizard } from "@/components/batch-d/onboard-wizard";
import { PageHeader } from "@/components/ui";
import { maskEmailAddress } from "@/lib/contact";
import { SHOP_TYPES } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listOpenOnboardings } from "@/server/services/operator-limited";
import { listShopCategories } from "@/server/services/shop-categories";

export const metadata = { title: "Onboard a shop" };
export const dynamic = "force-dynamic";

/** F8.4.2 — onboard a shop for its owner (owner's email code first). `?resume=<id>` continues an open one. */
export default async function OnboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.OPERATOR_LIMITED_ONBOARD)) redirect("/");
  const params = await searchParams;
  const [open, categories] = await Promise.all([listOpenOnboardings(user), listShopCategories({ activeOnly: true })]);
  const resumeId = typeof params.resume === "string" ? params.resume : null;
  const resume = open.find((o) => o.id === resumeId) ?? null;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="Onboard a shop" description="The owner confirms with a code sent to their email; then register the shop and collect the fee online." />
      <OnboardWizard
        key={resume?.id ?? "new"}
        shopTypes={SHOP_TYPES.map((t) => ({ value: t.key, label: t.label }))}
        categories={categories.map((c) => ({ value: c.id, label: c.name }))}
        resume={resume ? { sessionId: resume.id, ownerEmail: resume.ownerEmail, status: resume.status } : null}
      />
      <section id="open" className="space-y-2">
        <h2 className="text-lg font-semibold text-ink-900">Open onboardings</h2>
        {open.length === 0 ? (
          <p className="text-sm text-ink-500">None.</p>
        ) : (
          <ul className="divide-y divide-cream-200 rounded-xl border border-cream-200 bg-white">
            {open.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span>
                  {maskEmailAddress(o.ownerEmail)} · {o.status === "OWNER_VERIFIED" ? "owner confirmed" : "code sent"}
                </span>
                <a className="font-semibold text-kesari-800 underline" href={`/operator/onboard?resume=${o.id}`}>
                  Continue
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
