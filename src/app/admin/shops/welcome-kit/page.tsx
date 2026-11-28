import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminWelcomeKit } from "@/components/admin-welcome-kit";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { welcomeKitAdminSendEnabled } from "@/server/shop-banner/admin-send";
import { listDistricts } from "@/server/services/geo-areas";

export const metadata = { title: "Send welcome kit" };
export const dynamic = "force-dynamic";

/**
 * docs/shop-welcome-kit-2026-11, requirement 7: the welcome kit (two printable QR banners) for
 * shops that went live before it existed. Owner, 28-Nov-2026: Admin, Operator, Operations manager and Support
 * (shop-welcome-kit:send) send / resend one shop and download its banners; bulk runs stay ADMIN. The buttons work once the feature flag
 * shop_welcome_kit_admin_send_enabled is on.
 */
export default async function AdminWelcomeKitPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_WELCOME_KIT_SEND)) redirect("/");
  const [enabled, districts] = await Promise.all([welcomeKitAdminSendEnabled(), listDistricts()]);
  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin/menu/shops" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Shops
      </Link>
      <PageHeader
        title="Send welcome kit"
        description="New shops get the welcome e-mail with their printable QR banners (English, Marathi and Hindi) automatically when they go live. Shops that were live before it get it only from here: one shop, or a city or district. Each shop gets it once, ever."
      />
      <AdminWelcomeKit
        enabled={enabled}
        canBulk={user.role === "ADMIN"}
        districts={districts.filter((d) => d.status === "ACTIVE").map((d) => ({ code: d.code, name: d.name }))}
      />
    </div>
  );
}
