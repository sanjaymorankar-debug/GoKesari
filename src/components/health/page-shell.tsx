/**
 * GoKesari Health — server helpers for the patient pages: sign-in redirect, "coming soon" while the
 * rule is off, the My Health notice, and the person (self / family member) the page is about.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { Alert, PageHeader } from "@/components/ui";
import { getCurrentUser, type AuthenticatedUser } from "@/server/authz/guards";
import { healthEnabled } from "@/server/health/access";
import { listFamily, selfPatient } from "@/server/health/patients";
import type { HealthPatient } from "@/server/db/schema";
import { HealthNotice, type PersonLite } from "./patient";

export function ComingSoon({ title }: { title: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={title} />
      <Alert tone="info" title="Coming soon">
        GoKesari Health — doctors, prescriptions, your family&apos;s health record, medicines, home care and equipment — opens soon.
      </Alert>
    </div>
  );
}

export type PatientPage =
  | { kind: "ready"; user: AuthenticatedUser; people: HealthPatient[]; current: HealthPatient; lite: PersonLite[] }
  | { kind: "render"; node: ReactNode };

/** Resolves who the page is for, or what to render instead. */
export async function patientPage(path: string, title: string, requested?: string | null): Promise<PatientPage> {
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=${encodeURIComponent(path)}`);
  if (!(await healthEnabled())) return { kind: "render", node: <ComingSoon title={title} /> };
  const self = await selfPatient(user.id);
  if (!self)
    return {
      kind: "render",
      node: (
        <div className="mx-auto max-w-3xl">
          <PageHeader title="My Health" description="One lifelong health record for you and your family." />
          <HealthNotice />
        </div>
      ),
    };
  const people = await listFamily(user);
  const current = people.find((p) => p.id === requested) ?? people.find((p) => p.id === self.id) ?? self;
  const lite = people.map((p) => ({ id: p.id, fullName: p.fullName, relation: p.relation, linkStatus: p.linkStatus, dateOfBirth: p.dateOfBirth }));
  return { kind: "ready", user, people, current, lite };
}

export function BackToHealth({ patientId }: { patientId?: string }) {
  return (
    <Link href={patientId ? `/health?patient=${patientId}` : "/health"} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
      ← My Health
    </Link>
  );
}
