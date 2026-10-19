import { redirect } from "next/navigation";

import { HomeBannerManager } from "@/components/home/home-banner-manager";
import { PageHeader } from "@/components/ui";
import { bannerIsLive } from "@/lib/home-banners";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listAllBanners } from "@/server/services/home-banners";

export const metadata = { title: "Home banners" };
export const dynamic = "force-dynamic";

/**
 * Home hero banners (docs/homepage-uiux-2026-10, F1) for admins and operators
 * (HOME_BANNER_MANAGE): the carousel on the home page, in order. Changes are
 * audited.
 */
export default async function HomeBannersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.HOME_BANNER_MANAGE)) redirect("/");
  const now = new Date();
  const banners = await listAllBanners(user).catch((error) => {
    console.error("[home-banners] list failed", error);
    return [];
  });

  return (
    <div className="mx-auto max-w-5xl space-y-4" data-testid="admin-home-banners">
      <PageHeader
        title="Home banners"
        description="The carousel at the top of the home page: daily deals, seasonal offers, new shops. Up to six live banners rotate, in this order; a banner can be limited to one city or PIN code and to a date range."
      />
      <HomeBannerManager
        banners={banners.map((b) => ({
          id: b.id,
          title: b.title,
          subtitle: b.subtitle,
          imageUrl: b.imageUrl,
          ctaLabel: b.ctaLabel,
          ctaHref: b.ctaHref,
          kind: b.kind,
          city: b.city,
          pincode: b.pincode,
          startsAt: b.startsAt?.toISOString() ?? null,
          endsAt: b.endsAt?.toISOString() ?? null,
          active: b.active,
          // "Live" ignores targeting: a city banner is live for that city.
          liveNow: bannerIsLive({ ...b, city: null, pincode: null }, now, { pincode: null, cities: [] }),
        }))}
      />
    </div>
  );
}
