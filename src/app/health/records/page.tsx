import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher, RecordsView } from "@/components/health/patient";

export const metadata = { title: "Health records" };
export const dynamic = "force-dynamic";

/** My Health Records: Timeline, By provider, Medicines, Reports — per person, from the record start date. */
export default async function RecordsPage({ searchParams }: { searchParams: Promise<{ patient?: string; view?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health/records", "Health records", sp.patient);
  if (page.kind === "render") return page.node;
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={page.current.id} />
      <PageHeader title={`Health records — ${page.current.fullName}`} description="Everything since you joined GoKesari Health, newest first. Times in IST." />
      <PersonSwitcher people={page.lite} current={page.current.id} basePath="/health/records" />
      <RecordsView patientId={page.current.id} initialView={sp.view} />
    </div>
  );
}
