import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { GigEarningsCard } from "@/components/gig-earnings-card";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Section, StatusBadge } from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { vehicleTypeLabel } from "@/lib/vehicle-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getPartnerEarningsSummary } from "@/server/services/delivery-earnings";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getMyLatestChangeRequest } from "@/server/services/rider-profile";
import { RiderProfileEditor } from "@/components/rider-profile-editor";

export const metadata = { title: "My Delivery Profile" };
export const dynamic = "force-dynamic";

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-ink-700">{label}</dt>
      <dd className="text-ink-500">{children}</dd>
    </div>
  );
}

export default async function GigProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const profile = await getMyDeliveryPartnerProfile(user.id);
  if (!profile) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="My Delivery Profile" />
        <EmptyState
          title="You're not a delivery partner yet"
          description="Apply to deliver with GoKesari. Once you've applied, your profile and earnings show up here."
          action={<LinkButton href="/delivery-partner/apply">Become a delivery partner</LinkButton>}
        />
      </div>
    );
  }
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN)) redirect("/delivery-partner");

  const earnings = await getPartnerEarningsSummary(profile.id);
  const latestChange = await getMyLatestChangeRequest(user.id);
  const isApproved = profile.status === "APPROVED";

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader
        title="My Delivery Profile"
        description={`Applied on ${profile.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium" })}`}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/gig/orders" variant="secondary">
              My deliveries
            </LinkButton>
            <LinkButton href="/delivery-partner">Rider dashboard</LinkButton>
          </div>
        }
      />

      <Card className="mb-10 flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={profile.status} />
          {isApproved ? (
            profile.isOnline ? <Badge tone="success">Online</Badge> : <Badge>Offline</Badge>
          ) : null}
        </div>
        {isApproved ? null : (
          <p className="text-sm text-ink-500">
            Only approved partners receive delivery offers. Check the rider dashboard for your application status.
          </p>
        )}
      </Card>

      {isApproved || earnings.deliveryCount > 0 ? (
        <Section
          title="Earnings"
          href={isApproved ? "/delivery-partner" : undefined}
          linkLabel={isApproved ? "Statement & payouts" : undefined}
        >
          <GigEarningsCard
            earnings={earnings}
            rating={{ avgX100: profile.ratingAvgX100, count: profile.ratingCount }}
          />
        </Section>
      ) : null}

      <Section title="Personal details">
        <Card className="p-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label="Full name">{profile.fullName}</Detail>
            <Detail label="Mobile">{profile.mobile}</Detail>
            {profile.email ? <Detail label="Email">{profile.email}</Detail> : null}
            {profile.dateOfBirth ? (
              <Detail label="Date of birth">{formatDisplayDate(profile.dateOfBirth)}</Detail>
            ) : null}
          </dl>
          <p className="mt-4 text-xs text-ink-500">
            Identity and bank details are stored encrypted and are not shown here.
          </p>
        </Card>
      </Section>

      <Section title="Vehicle & operating area">
        <Card className="p-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label="Vehicle">{vehicleTypeLabel(profile.vehicleType)}</Detail>
            <Detail label="Registration number">
              {profile.vehicleRegistrationNumber ? (
                <span className="font-mono">{profile.vehicleRegistrationNumber}</span>
              ) : (
                "Not provided"
              )}
            </Detail>
            <Detail label="Operating radius">{profile.operatingRadiusKm} km</Detail>
            <Detail label="Base location">
              {profile.locationVerified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}
            </Detail>
          </dl>
        </Card>
      </Section>
      {profile.status !== "DEACTIVATED" ? (
        <Section title="Update my profile">
          <RiderProfileEditor
            rider={{
              fullName: profile.fullName,
              mobile: profile.mobile,
              email: profile.email,
              dateOfBirth: profile.dateOfBirth,
              profilePhotoUrl: profile.profilePhotoUrl,
              vehicleType: profile.vehicleType,
              vehicleRegistrationNumber: profile.vehicleRegistrationNumber,
              operatingRadiusKm: profile.operatingRadiusKm,
            }}
            latest={
              latestChange
                ? {
                    status: latestChange.status,
                    fields: latestChange.fields,
                    masked: latestChange.masked as Record<string, string>,
                    rejectionReason: latestChange.rejectionReason,
                    createdAt: latestChange.createdAt.toISOString(),
                  }
                : null
            }
          />
        </Section>
      ) : null}
    </div>
  );
}
