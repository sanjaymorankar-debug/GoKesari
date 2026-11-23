import Link from "next/link";
import { redirect } from "next/navigation";

import { NotificationPreferences } from "@/components/notification-preferences";
import { PhoneLinkForm } from "@/components/phone-link-form";
import { EmailChangeForm, ProfileDetailsForm } from "@/components/profile-forms";
import type { GenderValue } from "@/components/profile-setup";
import { MarketingConsentToggle } from "@/components/marketing-consent-toggle";
import { HashRedirect } from "@/components/board/hash-redirect";
import { Icon } from "@/components/board/icons";
import { ListTabs, Pager, paginate } from "@/components/board/list-tabs";
import { Badge, Card, PageHeader } from "@/components/ui";
import { L, tr, UI } from "@/lib/board/i18n";
import { pickTab } from "@/lib/board/status-groups";
import { CUSTOMER_MENUS } from "@/lib/board/menus";
import { getBoardLang } from "@/server/board-lang";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { getCurrentUser } from "@/server/authz/guards";
import { getMarketingConsentStatus } from "@/server/services/consents";
import { getPreferenceMatrix, listNotifications } from "@/server/services/notifications";
import { signOut } from "@/server/auth";
import { listAddresses } from "@/server/services/addresses";
import { getProfile } from "@/server/services/profile";
import { customerBankPrompt } from "@/server/services/bank-accounts";
import { BANK_STATUS_LABELS } from "@/lib/bank-accounts";

export const metadata = { title: "My Profile" };
export const dynamic = "force-dynamic";

/** Module 6 (docs/hindi-marathi-2026-11): My Profile's wording. */
const T = {
  title: L("My Profile", "मेरी प्रोफ़ाइल", "माझे प्रोफाइल"),
  myDetails: L("My details", "मेरी जानकारी", "माझी माहिती"),
  notifications: L("Notifications", "सूचनाएँ", "सूचना"),
  offers: L("Offers", "ऑफ़र", "ऑफर"),
  yourDetails: L("Your details", "आपकी जानकारी", "तुमची माहिती"),
  loginContact: L("Login & contact", "लॉग इन और संपर्क", "लॉग इन आणि संपर्क"),
  bankTitle: L("Bank account for refunds", "रिफंड के लिए बैंक खाता", "परताव्यासाठी बँक खाते"),
  bankNone: L(
    "Not added — needed for refunds to your bank (refunds normally go to your wallet).",
    "नहीं जोड़ा — बैंक में रिफंड के लिए ज़रूरी (रिफंड आमतौर पर वॉलेट में जाता है)।",
    "जोडलेले नाही — बँकेत परताव्यासाठी आवश्यक (परतावा साधारणपणे वॉलेटमध्ये जातो).",
  ),
  add: L("Add →", "जोड़ें →", "जोडा →"),
  manage: L("Manage →", "संभालें →", "व्यवस्थापित करा →"),
  verify: L("Verify →", "सत्यापित करें →", "पडताळा →"),
  addresses: L("Delivery addresses", "डिलीवरी पते", "डिलिव्हरी पत्ते"),
  addAddress: L("Add address →", "पता जोड़ें →", "पत्ता जोडा →"),
  work: L("Work", "ऑफ़िस", "ऑफिस"),
  home: L("Home", "घर", "घर"),
  address: L("Address", "पता", "पत्ता"),
  default: L(" · Default", " · मुख्य", " · मुख्य"),
  geoTagged: L("Geo-tagged at {coords}", "नक्शे पर लगा: {coords}", "नकाशावर दाखवले: {coords}"),
  notGeoTagged: L(
    "Not geo-tagged yet — edit it to pin the location.",
    "अभी नक्शे पर नहीं लगा — लोकेशन लगाने के लिए इसे बदलें।",
    "अजून नकाशावर दाखवलेले नाही — ठिकाण दाखवण्यासाठी हा पत्ता बदला.",
  ),
  moreSaved: L("+ {n} more saved", "+ {n} और सहेजे गए", "+ आणखी {n} जतन केलेले"),
  noAddress: L(
    "No delivery address yet. You'll need one before your first delivery order.",
    "अभी कोई डिलीवरी पता नहीं है। पहले डिलीवरी ऑर्डर से पहले एक पता चाहिए।",
    "अजून डिलिव्हरीचा पत्ता नाही. पहिल्या डिलिव्हरी ऑर्डरपूर्वी एक पत्ता लागेल.",
  ),
  signOut: L("Sign out", "साइन आउट", "साइन आउट"),
  nothingYet: L("Nothing yet.", "अभी कुछ नहीं।", "अजून काही नाही."),
  new: L("new", "नया", "नवीन"),
  offersTitle: L("Offers and promotions", "ऑफ़र और प्रचार", "ऑफर आणि जाहिराती"),
} as const;

const TABS = ["details", "notifications", "offers"] as const;
type ProfileTab = (typeof TABS)[number];

/**
 * My Profile in three tabs (details · notifications · offers) so each view fits
 * about one phone screen; it used to stack every card (5 phone screens).
 */
export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const query = await searchParams;
  const tab = pickTab<ProfileTab>(query.tab, TABS, "details");
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
  // Bank accounts (docs/four-features-2026-10): refunds-to-bank account and its verification.
  const [bankStatus, lang] = await Promise.all([customerBankPrompt(user.id, "profile"), getBoardLang()]);

  const notePage = paginate(notifications, query.page, 5);
  const tabLabel: Record<ProfileTab, string> = {
    details: tr(T.myDetails, lang),
    notifications: tr(T.notifications, lang),
    offers: tr(T.offers, lang),
  };
  const unreadNotes = notifications.filter((n) => !n.readAt).length;

  return (
    <div className="mx-auto max-w-2xl">
      <HashRedirect map={{ notifications: "/profile?tab=notifications" }} />
      <PageHeader title={tr(T.title, lang)} />

      {/* The board's Profile submenus, first on the page: one tap each. */}
      <nav aria-label={tr(UI.myProfile, lang)} className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="profile-quick-links">
        {(CUSTOMER_MENUS.find((m) => m.key === "profile")?.items ?? []).map((item) => (
          <Link
            key={item.key}
            href={item.href}
            className="flex min-h-12 items-center gap-2 rounded-xl border border-[var(--gk-line)] bg-white px-3 text-sm font-semibold text-ink-900 hover:bg-kesari-50"
          >
            {item.icon ? <Icon name={item.icon} size={18} className="shrink-0 text-kesari-700" /> : null}
            <span className="min-w-0 truncate">{tr(item.label, lang)}</span>
          </Link>
        ))}
      </nav>

      <ListTabs
        label={tr(T.title, lang)}
        active={tab}
        tabs={TABS.map((t) => ({ key: t, label: tabLabel[t], href: `/profile?tab=${t}`, count: t === "notifications" ? unreadNotes : undefined }))}
      />

      {tab === "details" ? (
        <>
      <Card className="mb-6 p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-lg font-semibold text-ink-900">{profile.name ?? tr(T.yourDetails, lang)}</p>
          <Badge tone="info">{ROLE_LABELS[user.role]}</Badge>
        </div>
        <ProfileDetailsForm lang={lang} initial={{ name: profile.name ?? "", gender: (profile.gender ?? "") as GenderValue | "" }} />
      </Card>
      <Card className="mb-6 grid gap-5 p-6">
        <h2 className="text-base font-semibold text-ink-900">{tr(T.loginContact, lang)}</h2>
        <PhoneLinkForm current={profile.phoneE164} />
        <EmailChangeForm current={profile.email} lang={lang} />
      </Card>
      {bankStatus ? (
        <Card className="mb-6 p-6" data-testid="profile-bank-account">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-ink-900">{tr(T.bankTitle, lang)}</h2>
              <p className="text-sm text-ink-500">
                {bankStatus === "NONE" ? tr(T.bankNone, lang) : BANK_STATUS_LABELS[bankStatus]}
              </p>
            </div>
            <Link href="/profile/bank-account" className="text-sm font-medium text-kesari-600 hover:underline">
              {bankStatus === "NONE" ? tr(T.add, lang) : bankStatus === "VERIFIED" ? tr(T.manage, lang) : tr(T.verify, lang)}
            </Link>
          </div>
        </Card>
      ) : null}
      <Card className="mb-6 p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink-900">{tr(T.addresses, lang)}</h2>
          <Link href="/profile/addresses" className="text-sm font-medium text-kesari-600 hover:underline">
            {addresses.length > 0 ? tr(T.manage, lang) : tr(T.addAddress, lang)}
          </Link>
        </div>
        {defaultAddress ? (
          <div className="rounded-lg border border-cream-200 bg-cream-50 p-3 text-sm">
            <p className="font-medium text-ink-900">
              {defaultAddress.label ??
                tr(defaultAddress.addressType === "WORK" ? T.work : defaultAddress.addressType === "HOME" ? T.home : T.address, lang)}
              {defaultAddress.isDefault ? tr(T.default, lang) : ""}
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
                ? tr(T.geoTagged, lang).replace(
                    "{coords}",
                    `${Number(defaultAddress.latitude).toFixed(5)}, ${Number(defaultAddress.longitude).toFixed(5)}`,
                  )
                : tr(T.notGeoTagged, lang)}
            </p>
            {addresses.length > 1 ? (
              <p className="mt-1 text-xs text-ink-500">{tr(T.moreSaved, lang).replace("{n}", String(addresses.length - 1))}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-ink-500">{tr(T.noAddress, lang)}</p>
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
            {tr(T.signOut, lang)}
          </button>
        </form>
      </Card>
        </>
      ) : null}

      {tab === "notifications" ? (
        <>
      <div className="mb-6">
        <NotificationPreferences initial={preferences} />
      </div>
      <Card id="notifications" className="p-6">
        <h2 className="mb-3 text-base font-semibold text-ink-900">
          {tr(T.notifications, lang)}
        </h2>
        {notePage.rows.length === 0 ? (
          <p className="text-sm text-ink-500">{tr(T.nothingYet, lang)}</p>
        ) : (
          <ul className="divide-y divide-cream-200">
            {notePage.rows.map((n) => (
              <li key={n.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-ink-900">{n.title}</p>
                    <p className="text-sm text-ink-600">{n.body}</p>
                  </div>
                  {!n.readAt ? <Badge tone="info">{tr(T.new, lang)}</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {new Date(n.createdAt).toLocaleString("en-IN", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: "Asia/Kolkata",
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Pager lang={lang} page={notePage.page} pageCount={notePage.pageCount} hrefFor={(n) => `/profile?tab=notifications&page=${n}`} />
      </Card>
        </>
      ) : null}

      {tab === "offers" ? (
      <Card className="p-6">
        <h2 className="mb-3 text-base font-semibold text-ink-900">
          {tr(T.offersTitle, lang)}
        </h2>
        <MarketingConsentToggle
          initialGranted={marketingConsent.granted}
          lastChangedAt={marketingConsent.lastChangedAt}
        />
      </Card>
      ) : null}
    </div>
  );
}
