import Link from "next/link";
import { redirect } from "next/navigation";

import { NotificationPreferences } from "@/components/notification-preferences";
import { PhoneLinkForm } from "@/components/phone-link-form";
import { MarketingConsentToggle } from "@/components/marketing-consent-toggle";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { getCurrentUser } from "@/server/authz/guards";
import { getMarketingConsentStatus } from "@/server/services/consents";
import { getPreferenceMatrix, listNotifications } from "@/server/services/notifications";
import { signOut } from "@/server/auth";
import { db } from "@/server/db";
import { users, addresses } from "@/server/db/schema";
import { eq, isNull } from "drizzle-orm";

export const metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [notifications, marketingConsent, phoneRow, preferences, userAddresses] = await Promise.all([
    listNotifications(user.id, { limit: 20 }),
    getMarketingConsentStatus(user.id),
    db.select({ phoneE164: users.phoneE164 }).from(users).where(eq(users.id, user.id)),
    getPreferenceMatrix(user.id),
    db.select().from(addresses).where(eq(addresses.userId, user.id), isNull(addresses.deletedAt)),
  ]);

  const defaultAddress = userAddresses.find(a => a.isDefault);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Profile" />

      {/* Personal Details Card */}
      <Card className="mb-6 p-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <p className="text-lg font-semibold text-ink-900">
              {user.name ?? "Complete your profile"}
            </p>
            <p className="text-sm text-ink-500">{user.email}</p>
            {user.gender && (
              <p className="text-sm text-ink-500 capitalize">
                {user.gender.toLowerCase()}
              </p>
            )}
            <div className="mt-2">
              <Badge tone="info">{ROLE_LABELS[user.role]}</Badge>
            </div>
          </div>
          <Link
            href="/profile/edit"
            className="ml-4 text-sm font-medium text-kesari-600 hover:underline"
          >
            Edit
          </Link>
        </div>

        <div className="mt-4 border-t border-cream-200 pt-4">
          <h3 className="text-sm font-medium text-ink-900 mb-3">Contact Information</h3>
          <div className="space-y-2">
            <p className="text-sm text-ink-600">
              <span className="font-medium">Email:</span> {user.email}
            </p>
            {phoneRow[0]?.phoneE164 && (
              <p className="text-sm text-ink-600">
                <span className="font-medium">Mobile:</span> {phoneRow[0].phoneE164}
              </p>
            )}
          </div>

          <div className="mt-4">
            <PhoneLinkForm current={phoneRow[0]?.phoneE164 ?? null} />
          </div>
        </div>
      </Card>

      {/* Addresses Card */}
      <Card className="mb-6 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-ink-900">Delivery Addresses</h2>
          <Link
            href="/profile/addresses"
            className="text-sm font-medium text-kesari-600 hover:underline"
          >
            Manage →
          </Link>
        </div>

        {defaultAddress ? (
          <div className="rounded-lg border border-cream-200 p-4 bg-cream-50">
            <p className="font-medium text-ink-900">{defaultAddress.label}</p>
            <p className="text-sm text-ink-600 mt-1">
              {defaultAddress.line1}
              {defaultAddress.line2 && `, ${defaultAddress.line2}`}
            </p>
            <p className="text-sm text-ink-600">
              {defaultAddress.area && `${defaultAddress.area}, `}
              {defaultAddress.city}, {defaultAddress.state} {defaultAddress.pincode}
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-500">
            No default address set.{" "}
            <Link
              href="/profile/addresses"
              className="text-kesari-600 hover:underline"
            >
              Add one
            </Link>
          </p>
        )}
      </Card>

      <Card className="mb-6 p-6">
        <h2 className="mb-3 text-base font-semibold text-ink-900">
          Marketing messages
        </h2>
        <MarketingConsentToggle
          initialGranted={marketingConsent.granted}
          lastChangedAt={marketingConsent.lastChangedAt}
        />
      </Card>

      <div className="mb-6">
        <NotificationPreferences initial={preferences} />
      </div>

      <Card className="p-6">
        <h2 className="mb-3 text-base font-semibold text-ink-900">
          Notifications
        </h2>
        {notifications.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-cream-200">
            {notifications.map((n) => (
              <li key={n.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-900">{n.title}</p>
                    <p className="text-sm text-ink-600">{n.body}</p>
                  </div>
                  {!n.readAt ? <Badge tone="info">new</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-ink-400">
                  {new Date(n.createdAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
