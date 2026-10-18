import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { LEGAL_ENTITY } from "@/lib/legal-docs";
import { getGrievanceOfficer } from "@/server/aftercare/grievance-officer";

export const metadata = { title: "Contact Us" };
// batch-2026-10 WS-C: the Grievance Officer is an admin setting (rule grievanceOfficer), read per request.
export const dynamic = "force-dynamic";

export default async function ContactPage() {
  const officer = await getGrievanceOfficer();
  return (
    <>
      <PageHeader title="Contact Us" />
      <div className="grid gap-6 sm:grid-cols-2">
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Customer care
          </h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium text-ink-700">Email</dt>
              <dd className="text-ink-600">
                <a href={`mailto:${LEGAL_ENTITY.supportEmail}`} className="underline">
                  {LEGAL_ENTITY.supportEmail}
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink-700">Registered address</dt>
              <dd className="text-ink-600">{LEGAL_ENTITY.registeredAddress}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-ink-500">
            For an order, payment, or delivery issue, it&apos;s usually fastest to
            use the order&apos;s &quot;Report an issue&quot; option from your{" "}
            <Link href="/orders" className="underline">
              Orders
            </Link>{" "}
            page. For anything else, email us or file a formal complaint
            below.
          </p>
        </Card>

        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
            Grievance Officer
          </h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="font-medium text-ink-700">Name</dt>
              <dd className="text-ink-600">{officer.name}</dd>
            </div>
            <div>
              <dt className="font-medium text-ink-700">Email</dt>
              <dd className="text-ink-600">
                <a href={`mailto:${officer.email}`} className="underline">
                  {officer.email}
                </a>
              </dd>
            </div>
            <div>
              <dt className="font-medium text-ink-700">Phone</dt>
              <dd className="text-ink-600">{officer.phone}</dd>
            </div>
            {officer.hours ? (
              <div>
                <dt className="font-medium text-ink-700">Hours</dt>
                <dd className="text-ink-600">{officer.hours}</dd>
              </div>
            ) : null}
          </dl>
          <a
            href="/grievance"
            className="mt-4 inline-block text-sm font-medium text-kesari-600 hover:underline"
          >
            File a formal complaint →
          </a>
          {/* batch-2026-10 WS-C: the help desk portal. */}
          <Link href="/support" className="mt-2 block text-sm font-medium text-kesari-600 hover:underline">
            Raise or follow a support ticket →
          </Link>
        </Card>
      </div>
    </>
  );
}
