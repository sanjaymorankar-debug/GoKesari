import Link from "next/link";

import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";

export const metadata = { title: "Become a Delivery Partner" };
export const dynamic = "force-dynamic";

/**
 * Promotional landing page. Deliberately avoids employment language per the
 * brief — a delivery partner is an independent partner, not staff.
 */
export default async function BecomeDeliveryPartnerPage() {
  const user = await getCurrentUser();
  const existing = user ? await getMyDeliveryPartnerProfile(user.id) : null;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Become a GoKesari Delivery Partner"
        description="Join GoKesari as an independent delivery partner."
      />

      <Card className="mb-6 p-6">
        <ul className="space-y-3 text-sm text-ink-700">
          <li>
            <strong>Flexible working</strong> — choose when you go online and
            when you don&apos;t. There are no fixed shifts.
          </li>
          <li>
            <strong>Earn per delivery</strong> — a transparent, delivery-wise
            earnings statement so you can see exactly what you earned and why.
          </li>
          <li>
            <strong>Additional incentives</strong> — from efficient routes and
            peak-time demand, where available.
          </li>
          <li>
            <strong>Track everything from one place</strong> — your
            applications, deliveries and earnings, all in your account.
          </li>
        </ul>
      </Card>

      <Card className="p-6 text-sm text-ink-600">
        <p className="mb-4">
          Registration takes a few minutes. After you submit, our team
          reviews your details and documents before approval — you&apos;ll be
          notified either way.
        </p>

        {existing ? (
          <Link
            href="/delivery-partner"
            className="inline-block rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            View my application status →
          </Link>
        ) : user ? (
          <Link
            href="/delivery-partner/register"
            className="inline-block rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            Start my application →
          </Link>
        ) : (
          <Link
            href="/signin"
            className="inline-block rounded-lg bg-kesari-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-kesari-800"
          >
            Sign in to apply →
          </Link>
        )}
      </Card>
    </div>
  );
}
