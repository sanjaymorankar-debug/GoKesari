import { redirect } from "next/navigation";

import { Alert, PageHeader } from "@/components/ui";
import { formatIst } from "@/lib/consult/time";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getRiderSosSettings, listSosEvents } from "@/server/services/rider-sos";
import { RiderSosQueue } from "./rider-sos-queue";

export const metadata = { title: "Rider SOS" };
export const dynamic = "force-dynamic";

/** Rider App v2: riders' SOS alerts — acknowledge (the rider is told help is coming) and close with a note. */
export default async function RiderSosAdminPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/admin/rider-sos");
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_MANAGE)) redirect("/");
  const params = await searchParams;
  const status = params.status === "OPEN" || params.status === "ACKNOWLEDGED" || params.status === "CLOSED" ? params.status : null;
  const [events, settings] = await Promise.all([listSosEvents({ status }), getRiderSosSettings()]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader
        title="Rider SOS"
        description="A rider pressed SOS: call them first, then acknowledge (the rider is told help is on the way), and close with a note once it is settled."
      />
      {!settings.enabled ? (
        <Alert tone="info">The SOS button is switched off (rule riderSos). Riders cannot raise new alerts; older ones stay listed here.</Alert>
      ) : null}
      <RiderSosQueue
        status={status}
        events={events.map((e) => ({
          id: e.id,
          status: e.status,
          raisedAt: formatIst(e.createdAt),
          acknowledgedAt: e.acknowledgedAt ? formatIst(e.acknowledgedAt) : null,
          closedAt: e.closedAt ? formatIst(e.closedAt) : null,
          note: e.note,
          riderName: e.riderName,
          riderMobile: e.riderMobile,
          emergencyContact: e.emergencyContactMobile
            ? `${e.emergencyContactName ?? "Contact"}${e.emergencyContactRelation ? ` (${e.emergencyContactRelation})` : ""}`
            : null,
          emergencyContactMobile: e.emergencyContactMobile,
          orderNumber: e.orderNumber,
          mapUrl: e.mapUrl,
          accuracyM: e.accuracyM,
        }))}
      />
    </div>
  );
}
