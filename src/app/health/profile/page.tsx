import { PageHeader } from "@/components/ui";
import { BackToHealth, patientPage } from "@/components/health/page-shell";
import { PersonSwitcher, ProfileForm } from "@/components/health/patient";

export const metadata = { title: "Health profile" };
export const dynamic = "force-dynamic";

export default async function HealthProfilePage({ searchParams }: { searchParams: Promise<{ patient?: string }> }) {
  const sp = await searchParams;
  const page = await patientPage("/health/profile", "Health profile", sp.patient);
  if (page.kind === "render") return page.node;
  const p = page.current;
  return (
    <div className="mx-auto max-w-3xl">
      <BackToHealth patientId={p.id} />
      <PageHeader title={`Health profile — ${p.fullName}`} description="Only the name and date of birth are needed; the rest helps your doctors." />
      <PersonSwitcher people={page.lite} current={p.id} basePath="/health/profile" />
      <ProfileForm
        patient={{
          id: p.id,
          fullName: p.fullName,
          relation: p.relation,
          linkStatus: p.linkStatus,
          dateOfBirth: p.dateOfBirth,
          gender: p.gender,
          bloodGroup: p.bloodGroup,
          allergies: p.allergies,
          conditions: p.conditions,
          currentMedicines: p.currentMedicines,
          emergencyName: p.emergencyName,
          emergencyPhone: p.emergencyPhone,
          emergencyRelation: p.emergencyRelation,
          abhaNumber: p.abhaNumber,
          recordStartAt: p.recordStartAt.toISOString(),
        }}
      />
    </div>
  );
}
