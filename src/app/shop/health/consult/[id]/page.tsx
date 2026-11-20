import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, eq, inArray, or } from "drizzle-orm";

import { PageHeader } from "@/components/ui";
import { ConsultationPad } from "@/components/health/doctor";
import { CARE_CATEGORY_GROUP, EXTRA_CARE_CATEGORY_SLUGS } from "@/lib/health/constants";
import { AppError } from "@/lib/errors";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { consultBookings, consultCategories, healthPrescriptions } from "@/server/db/schema";
import { loadConsultationForDoctor, patientSummary } from "@/server/health/consultations";
import { effectiveLetterhead } from "@/server/health/letterheads";

export const metadata = { title: "Consultation" };
export const dynamic = "force-dynamic";

/** The consultation pad: patient summary, vitals, diagnosis, e-prescription, suggestions, issue and print. */
export default async function ConsultationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?callbackUrl=/shop/health/consult/${id}`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const consultation = await loadConsultationForDoctor(id, user).catch((e) => {
    if (e instanceof AppError) notFound();
    throw e;
  });
  const summary = await patientSummary(id, user);
  const lh = await effectiveLetterhead(consultation.shopId, consultation.memberId);
  const care = await db
    .select({ slug: consultCategories.slug, name: consultCategories.name })
    .from(consultCategories)
    .where(and(eq(consultCategories.status, "ACTIVE"), or(eq(consultCategories.groupName, CARE_CATEGORY_GROUP), inArray(consultCategories.slug, [...EXTRA_CARE_CATEGORY_SLUGS]))));
  const [rx] = await db.select({ id: healthPrescriptions.id }).from(healthPrescriptions).where(and(eq(healthPrescriptions.consultationId, consultation.id), eq(healthPrescriptions.status, "ISSUED"))).limit(1);
  const [booking] = consultation.bookingId ? await db.select({ meetingUrl: consultBookings.meetingUrl, number: consultBookings.bookingNumber }).from(consultBookings).where(eq(consultBookings.id, consultation.bookingId)) : [];
  return (
    <div className="mx-auto max-w-6xl">
      <Link href="/shop/health" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Today
      </Link>
      <PageHeader
        title={`Consultation — ${summary.patient.fullName}`}
        description={`${consultation.mode === "VIDEO" ? "Video" : consultation.mode === "PHONE" ? "Phone" : consultation.mode === "HOME_VISIT" ? "Home visit" : "In clinic"}${booking ? ` · ${booking.number}` : ""}`}
        action={
          booking?.meetingUrl && consultation.mode === "VIDEO" ? (
            <a className="inline-flex min-h-11 items-center rounded-xl bg-teal-700 px-4 text-sm font-extrabold text-white" href={booking.meetingUrl} target="_blank" rel="noreferrer">
              Open video call
            </a>
          ) : undefined
        }
      />
      <ConsultationPad
        consultation={{ ...consultation, vitals: consultation.vitals as Record<string, number | null>, diagnoses: consultation.diagnoses, investigations: consultation.investigations }}
        summary={JSON.parse(JSON.stringify(summary))}
        letterheadAutoPrint={lh.autoPrint}
        localLanguage={lh.localLanguage}
        careCategories={care}
        prescriptionId={rx?.id ?? null}
      />
    </div>
  );
}
