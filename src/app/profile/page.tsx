import Link from "next/link";
import { redirect } from "next/navigation";

import { NotificationPreferences } from "@/components/notification-preferences";
import { PhoneLinkForm } from "@/components/phone-link-form";
import { EmailChangeForm, ProfileDetailsForm } from "@/components/profile-forms";
import type { GenderValue } from "@/components/profile-setup";
import { MarketingConsentToggle } from "@/components/marketing-consent-toggle";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { getCurrentUser } from "@/server/authz/guards";
import { getMarketingConsentStatus } from "@/server/services/consents";
import { getPreferenceMatrix, listNotifications } from "@/server/services/notifications";
import { signOut } from "@/server/auth";
import { listAddresses } from "@/server/services/addresses";
import { getProfile } from "@/server/services/profile";

export const metadata = { title: "My Profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [notifications, marketingConsent, profile, preferences, addresses] = await Promise.all([
    listNotifications(user.id, { limit: 20 }),
    getMarketingConsentStatus(user.id),
    getProfile(user.id),
    getPreferenceMatrix(user.id),
    listAddresses(user.id),
  ]);
  const defaultAddress = addresses.find((a) => a.isDefault) ?? addresses[0] ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="My Profile" />

      <Card className="mb-6 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-lg font-semibold text-ink-900">{profile.name ?? "Your details"}</p>
          <Badge tone="info">{ROLE_LABELS[user.role]}</Badge>
        </div>
        <ProfileDetailsForm initial={{ name: profile.name ?? "", gender: (profile.gender ?? "") as GenderValue | "" }} />
      </Card>

      <Card className="mb-6 grid gap-5 p-6">
        <h2 className="text-base font-semibold text-ink-900">Login &amp; contact</h2>
        <PhoneLinkForm current={profile.phoneE164} />
        <EmailChangeForm current={profile.email} />
      </Card>

      <Card className="mb-6 p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-900">Delivery addresses</h2>
          <Link href="/profile/addresses" className="text-sm font-medium text-kesari-600 hover:underline">
            {addresses.length > 0 ? "Manage →" : "Add address →"}
          </Link>
        </div>
        {defaultAddress ? (
          <div className="rounded-lg border border-cream-200 bg-cream-50 p-3 text-sm">
            <p className="font-medium text-ink-900">
              {defaultAddress.label ?? (defaultAddress.addressType === "WORK" ? "Work" : defaultAddress.addressType === "HOME" ? "Home" : "Address")}
              {defaultAddress.isDefault ? " · Default" : ""}
            </p>
            <p className="text-ink-700">
              {defaultAddress.line1}
              {defaultAddress.line2 ? `, ${defaultAddress.line2}` : ""}
            </p>
            <p className="text-ink-500">
              {[defaultAddress.area, defaultAddress.city, defaultAddress.state].filter(Boolean).join(", ")} — {defaultAddress.pincode}
            </p>
            <p className="mt-1 text-xs text-ink-500">
              {defaultAddress.latitude && defaultAddress.longitude
                ? `Geo-tagged at ${Number(defaultAddress.latitude).toFixed(5)}, ${Number(defaultAddress.longitude).toFixed(5)}`
                : "Not geo-tagged yet — edit it to pin the location."}
            </p>
            {addresses.length > 1 ? <p className="mt-1 text-xs text-ink-500">+ {addresses.length - 1} more saved</p> : null}
          </div>
        ) : (
          <p className="text-sm text-ink-500">No delivery address yet. You&apos;ll need one before your first delivery order.</p>
        )}
      </Card>

      <Card className="mb-6 p-6">
        <form
          className="mt-5"
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
          >
            Sign out
          </button>
        </form>
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
