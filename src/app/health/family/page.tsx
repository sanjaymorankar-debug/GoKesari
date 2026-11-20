import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { FamilyManager } from "@/components/health/patient";

export const metadata = { title: "Family health records" };
export const dynamic = "force-dynamic";

/** Family: dependents you manage fully; adults linked only after their one-time code. */
export default async function FamilyPage() {
  const page = await patientPage("/health/family", "Family health records");
  if (page.kind === "render") return page.node;
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth />
      <PageHeader title="Family" description="Every feature in My Health works for each person here." />
      <FamilyManager people={page.lite} />
    </div>
  );
}
