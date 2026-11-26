import Link from "next/link";
import { redirect } from "next/navigation";
import clsx from "clsx";

import { LanguageSwitch } from "@/components/board/board-header";
import { Icon, type IconName } from "@/components/board/icons";
import { TONE_CHIP } from "@/components/board/tiles";
import { PageHeader } from "@/components/ui";
import { L, tr, type Text } from "@/lib/board/i18n";
import type { Tone } from "@/lib/board/menus";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { signOutAction } from "@/server/sign-out-action";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "More" };
export const dynamic = "force-dynamic";

const T = {
  title: L("More", "और", "अधिक"),
  account: L("My account", "मेरा खाता", "माझे खाते"),
  safety: L("Safety & support", "सुरक्षा और सहायता", "सुरक्षा आणि सहाय्य"),
  settings: L("Settings & legal", "सेटिंग और कानूनी", "सेटिंग आणि कायदेशीर"),
  profile: L("Profile", "प्रोफ़ाइल", "प्रोफाइल"),
  vehicle: L("Vehicle", "वाहन", "वाहन"),
  kyc: L("KYC", "KYC", "KYC"),
  bank: L("Bank account", "बैंक खाता", "बँक खाते"),
  documents: L("Documents", "दस्तावेज़", "कागदपत्रे"),
  societies: L("Societies", "सोसाइटी", "सोसायटी"),
  idCard: L("ID card", "आईडी कार्ड", "ओळखपत्र"),
  ratings: L("Ratings", "रेटिंग", "रेटिंग"),
  tier: L("Tier details", "टियर विवरण", "टियर तपशील"),
  emergency: L("Emergency contacts", "आपातकालीन संपर्क", "आपत्कालीन संपर्क"),
  insurance: L("Insurance", "बीमा", "विमा"),
  help: L("Help & tickets", "सहायता और टिकट", "मदत आणि तिकिटे"),
  language: L("Language", "भाषा", "भाषा"),
  agreement: L("Rider Agreement (Terms)", "राइडर अनुबंध (शर्तें)", "रायडर करार (अटी)"),
  location: L("Location Tracking policy", "लोकेशन ट्रैकिंग नीति", "लोकेशन ट्रॅकिंग धोरण"),
  logout: L("Log out", "लॉग आउट", "लॉग आउट"),
} as const;

interface Item {
  href: string;
  label: Text;
  icon: IconName;
  tone: Tone;
}

const GROUPS: { title: Text; items: Item[] }[] = [
  {
    title: T.account,
    items: [
      { href: "/gig/profile", label: T.profile, icon: "user", tone: "kesari" },
      { href: "/gig/profile", label: T.vehicle, icon: "bike", tone: "teal" },
      { href: "/delivery-partner/kyc", label: T.kyc, icon: "badge-check", tone: "blue" },
      { href: "/gig/wallet", label: T.bank, icon: "landmark", tone: "green" },
      { href: "/delivery-partner/documents", label: T.documents, icon: "file-check", tone: "violet" },
      { href: "/delivery-partner/societies", label: T.societies, icon: "house", tone: "amber" },
      { href: "/gig/id-card", label: T.idCard, icon: "user-check", tone: "pink" },
      { href: "/gig/profile", label: T.ratings, icon: "star", tone: "amber" },
      { href: "/delivery-partner/tier", label: T.tier, icon: "trending-up", tone: "kesari" },
    ],
  },
  {
    title: T.safety,
    items: [
      { href: "/delivery-partner/emergency-contacts", label: T.emergency, icon: "life-buoy", tone: "pink" },
      { href: "/delivery-partner/insurance", label: T.insurance, icon: "shield-check", tone: "blue" },
      { href: "/support", label: T.help, icon: "headset", tone: "teal" },
    ],
  },
  {
    title: T.settings,
    items: [
      { href: "/legal/terms", label: T.agreement, icon: "scroll-text", tone: "violet" },
      { href: "/legal/privacy-policy", label: T.location, icon: "locate-fixed", tone: "green" },
    ],
  },
];

/** Rider App v2 (rule riderAppV2): everything that is not Home, Earnings, My Slots or Refer. */
export default async function RiderMorePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!(await getRule("riderAppV2")).enabled) redirect("/delivery-partner");
  const lang = await getBoardLang();
  const t = (text: Text) => tr(text, lang);

  return (
    <div className="mx-auto max-w-2xl space-y-5" data-testid="rider-more">
      <PageHeader title={t(T.title)} />
      {GROUPS.map((group) => (
        <section key={group.title.en}>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">{t(group.title)}</h2>
          <ul className="divide-y divide-cream-100 overflow-hidden rounded-xl border border-cream-200 bg-white shadow-sm">
            {group.items.map((item) => (
              <li key={item.label.en}>
                <Link href={item.href} className="flex min-h-14 items-center gap-3 px-4 py-2 text-sm font-medium text-ink-900 hover:bg-cream-50">
                  <span className={clsx("grid h-9 w-9 shrink-0 place-items-center rounded-full", TONE_CHIP[item.tone])}>
                    <Icon name={item.icon} size={18} />
                  </span>
                  <span className="min-w-0 flex-1">{t(item.label)}</span>
                  <Icon name="chevron-right" size={18} className="text-ink-500" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.language)}</h2>
        <LanguageSwitch lang={lang} variant="buttons" />
      </section>
      <form action={signOutAction}>
        <button
          type="submit"
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 hover:bg-red-50"
          data-testid="rider-logout"
        >
          <Icon name="log-out" size={18} />
          {t(T.logout)}
        </button>
      </form>
    </div>
  );
}
