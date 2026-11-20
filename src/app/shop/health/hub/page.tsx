import clsx from "clsx";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, isNull } from "drizzle-orm";

import { Icon, type IconName } from "@/components/board/icons";
import { TONE_CHIP } from "@/components/board/tiles";
import { PageHeader } from "@/components/ui";
import { ComingSoon } from "@/components/health/page-shell";
import type { Tone } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { consultMembers, consultProfiles, shops } from "@/server/db/schema";
import { healthEnabled } from "@/server/health/access";

export const metadata = { title: "GoKesari Health — for your business" };
export const dynamic = "force-dynamic";

interface HubTile {
  key: string;
  label: string;
  hint: string;
  href: string;
  icon: IconName;
  tone: Tone;
  show: boolean;
}

/**
 * Seller Central → Orders → Health: the role entry points on one screen (Theme 1 Tile Board) — clinic
 * Today and pad, clinic reception, prescription requests (medical stores), home-care visits, equipment
 * rentals, Prime — shown for the shop types the user runs.
 */
export default async function ShopHealthHub() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/shop/health/hub");
  if (!(await healthEnabled())) return <ComingSoon title="GoKesari Health" />;
  const owned = await db.select({ id: shops.id, type: shops.shopType }).from(shops).where(and(eq(shops.ownerId, user.id), isNull(shops.deletedAt)));
  const profiles = await db.select({ shopId: consultProfiles.shopId }).from(consultProfiles).innerJoin(shops, eq(shops.id, consultProfiles.shopId)).where(eq(shops.ownerId, user.id));
  const memberOf = await db.select({ id: consultMembers.id }).from(consultMembers).where(and(eq(consultMembers.userId, user.id), eq(consultMembers.status, "ACTIVE"))).limit(1);
  const types = new Set(owned.map((s) => s.type));
  const practice = profiles.length > 0 || memberOf.length > 0;
  const tiles: HubTile[] = [
    { key: "today", label: "Clinic — Today", hint: "Who is coming, queue, consult, prescribe", href: "/shop/health", icon: "calendar-clock", tone: "kesari", show: practice },
    { key: "settings", label: "Doctor & print settings", hint: "Registration, signature, letterhead", href: "/shop/health/settings", icon: "settings", tone: "blue", show: practice },
    { key: "care", label: "Home-care visits", hint: "Accept, on my way, OTP check-in", href: "/shop/health/care", icon: "house", tone: "pink", show: practice },
    { key: "prescriptions", label: "Prescription requests", hint: "Quote, pack, pickup / deliver", href: "/shop/health/prescriptions", icon: "scroll-text", tone: "green", show: types.has("PHARMACY") },
    { key: "pharmacy", label: "Pharmacy profile", hint: "Drug licence, pharmacist", href: "/shop/health/pharmacy", icon: "badge-check", tone: "teal", show: types.has("PHARMACY") },
    { key: "equipment", label: "Equipment rentals", hint: "Listings, deliveries, returns", href: "/shop/health/equipment", icon: "boxes", tone: "amber", show: types.has("MEDICAL_EQUIPMENT") },
    { key: "prime", label: "Health Prime", hint: "Instant booking, priority, call tracking", href: "/shop/health/prime", icon: "sparkles", tone: "violet", show: practice || types.has("MEDICAL_EQUIPMENT") },
    { key: "setup", label: "Appointments setup", hint: "Team, services, hours, certificates", href: "/shop/consult/setup", icon: "users", tone: "teal", show: true },
  ];
  const visible = tiles.filter((t) => t.show);
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="GoKesari Health" description="Everything for your clinic, practice, medical store or equipment store." />
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="shop-health-tiles">
        {visible.map((t) => (
          <li key={t.key}>
            <Link href={t.href} className="flex min-h-28 flex-col gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3 hover:border-kesari-400" data-testid={`shop-health-tile-${t.key}`}>
              <span className={clsx("inline-flex h-10 w-10 items-center justify-center rounded-xl", TONE_CHIP[t.tone])}>
                <Icon name={t.icon} size={22} />
              </span>
              <span className="text-base font-extrabold leading-tight text-ink-900">{t.label}</span>
              <span className="text-xs text-ink-600">{t.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
      {!practice && !types.has("PHARMACY") && !types.has("MEDICAL_EQUIPMENT") ? (
        <p className="mt-4 text-sm text-ink-700">
          To take part, register a clinic / practice (shop type Doctor or Consultant firm), a Pharmacy, or a Medical equipment store, then open the matching tile here.
        </p>
      ) : null}
    </div>
  );
}
