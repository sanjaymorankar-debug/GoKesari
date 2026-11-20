import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher, PrivacyView } from "@/components/health/patient";

export const metadata = { title: "Health privacy" };
export const dynamic = "force-dynamic";

/** Who has access, withdraw access, access log, my data (DPDP Act 2023). */
export default async function HealthPrivacyPage({ searchParams }: { searchParams: Promise<{ patient?: string; member?: string; booking?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health/privacy", "Health privacy", sp.patient);
  if (page.kind === "render") return page.node;
  const uuid = /^[0-9a-f-]{36}$/;
  const ask = sp.member && uuid.test(sp.member) ? { memberId: sp.member, bookingId: sp.booking && uuid.test(sp.booking) ? sp.booking : null } : null;
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={page.current.id} />
      <PageHeader title={`Privacy — ${page.current.fullName}`} description="Decide who sees your records, see every look, download or delete your data." />
      <PersonSwitcher people={page.lite} current={page.current.id} basePath="/health/privacy" />
      <PrivacyView patientId={page.current.id} ask={ask} />
    </div>
  );
}
