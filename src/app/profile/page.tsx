import Link from "next/link";
import { redirect } from "next/navigation";

import { MarketingConsentToggle } from "@/components/marketing-consent-toggle";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { getCurrentUser } from "@/server/authz/guards";
import { getMarketingConsentStatus } from "@/server/services/consents";
import { listNotifications } from "@/server/services/notifications";
import { signOut } from "@/server/auth";

export const metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [notifications, marketingConsent] = await Promise.all([
    listNotifications(user.id, { limit: 20 }),
    getMarketingConsentStatus(user.id),
  ]);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Profile" />

      <Card className="mb-6 p-6">
        <p className="text-lg font-semibold text-ink-900">
          {user.name ?? user.email}
        </p>
        <p className="text-sm text-ink-500">{user.email}</p>
        <div className="mt-2">
          <Badge tone="info">{ROLE_LABELS[user.role]}</Badge>
        </div>

        <Link
          href="/profile/addresses"
          className="mt-4 inline-block text-sm font-medium text-kesari-600 hover:underline"
        >
          My Addresses →
        </Link>

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
