import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { GigEarningsCard } from "@/components/gig-earnings-card";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Section, StatusBadge } from "@/components/ui";
import { formatDisplayDate } from "@/lib/dates";
import { L, tr, type Text } from "@/lib/board/i18n";
import { vehicleTypeText } from "@/lib/vehicle-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getPartnerEarningsSummary } from "@/server/services/delivery-earnings";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { getMyLatestChangeRequest } from "@/server/services/rider-profile";
import { RiderProfileEditor } from "@/components/rider-profile-editor";
import { RiderDocumentsPanel } from "@/components/rider-documents-panel";
import { getRule } from "@/server/services/settings";
import { listMyRiderDocuments } from "@/server/services/rider-files";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "My Delivery Profile" };
export const dynamic = "force-dynamic";

const T = {
  title: L("My Delivery Profile", "मेरी डिलीवरी प्रोफ़ाइल", "माझे डिलिव्हरी प्रोफाइल"),
  notPartner: L("You're not a delivery partner yet", "आप अभी डिलीवरी पार्टनर नहीं हैं", "तुम्ही अजून डिलिव्हरी पार्टनर नाही"),
  notPartnerText: L(
    "Apply to deliver with GoKesari. Once you've applied, your profile and earnings show up here.",
    "GoKesari के साथ डिलीवरी के लिए आवेदन करें। आवेदन के बाद आपकी प्रोफ़ाइल और कमाई यहाँ दिखेगी।",
    "GoKesari सोबत डिलिव्हरीसाठी अर्ज करा. अर्ज केल्यानंतर तुमचे प्रोफाइल आणि कमाई इथे दिसेल.",
  ),
  become: L("Become a delivery partner", "डिलीवरी पार्टनर बनें", "डिलिव्हरी पार्टनर व्हा"),
  appliedOn: L("Applied on {date}", "आवेदन की तारीख {date}", "अर्जाची तारीख {date}"),
  myDeliveries: L("My deliveries", "मेरी डिलीवरी", "माझ्या डिलिव्हऱ्या"),
  myWallet: L("My wallet", "मेरा वॉलेट", "माझे वॉलेट"),
  dashboard: L("Rider dashboard", "राइडर डैशबोर्ड", "रायडर डॅशबोर्ड"),
  online: L("Online", "ऑनलाइन", "ऑनलाइन"),
  offline: L("Offline", "ऑफ़लाइन", "ऑफलाइन"),
  onlyApproved: L(
    "Only approved partners receive delivery offers. Check the rider dashboard for your application status.",
    "सिर्फ़ मंज़ूर पार्टनर को डिलीवरी ऑफ़र मिलते हैं। आवेदन की स्थिति राइडर डैशबोर्ड पर देखें।",
    "फक्त मंजूर पार्टनरना डिलिव्हरी ऑफर मिळतात. अर्जाची स्थिती रायडर डॅशबोर्डवर पहा.",
  ),
  earnings: L("Earnings", "कमाई", "कमाई"),
  statement: L("Statement & payouts", "हिसाब और पेआउट", "हिशोब आणि पेआउट"),
  personal: L("Personal details", "निजी जानकारी", "वैयक्तिक माहिती"),
  fullName: L("Full name", "पूरा नाम", "पूर्ण नाव"),
  mobile: L("Mobile", "मोबाइल", "मोबाइल"),
  email: L("Email", "ईमेल", "ईमेल"),
  dob: L("Date of birth", "जन्म तिथि", "जन्मतारीख"),
  encrypted: L(
    "Identity and bank details are stored encrypted and are not shown here.",
    "पहचान और बैंक विवरण एन्क्रिप्ट करके रखे जाते हैं और यहाँ नहीं दिखाए जाते।",
    "ओळख आणि बँक तपशील एन्क्रिप्ट करून ठेवले जातात आणि इथे दाखवले जात नाहीत.",
  ),
  vehicleArea: L("Vehicle & operating area", "वाहन और काम का इलाका", "वाहन आणि कामाचा परिसर"),
  vehicle: L("Vehicle", "वाहन", "वाहन"),
  regNumber: L("Registration number", "रजिस्ट्रेशन नंबर", "नोंदणी क्रमांक"),
  notProvided: L("Not provided", "नहीं दिया", "दिलेला नाही"),
  radius: L("Operating radius", "काम का दायरा", "कामाचा परिघ"),
  base: L("Base location", "मुख्य लोकेशन", "मुख्य ठिकाण"),
  verified: L("Verified", "सत्यापित", "पडताळलेले"),
  notVerified: L("Not verified", "सत्यापित नहीं", "पडताळलेले नाही"),
  idCard: L("Rider ID card", "राइडर ID कार्ड", "रायडर ID कार्ड"),
  idCardText: L(
    "Your photo, name, rider ID and the societies that have approved you — show it at the society gate.",
    "आपकी फ़ोटो, नाम, राइडर ID और आपको मंज़ूर करने वाली सोसाइटियाँ — इसे सोसाइटी गेट पर दिखाएँ।",
    "तुमचा फोटो, नाव, रायडर ID आणि तुम्हाला मंजूर केलेल्या सोसायट्या — हे सोसायटीच्या गेटवर दाखवा.",
  ),
  showIdCard: L("Show my ID card", "मेरा ID कार्ड दिखाएँ", "माझे ID कार्ड दाखवा"),
  idDocs: L("Identity documents", "पहचान दस्तावेज़", "ओळखीची कागदपत्रे"),
  update: L("Update my profile", "मेरी प्रोफ़ाइल अपडेट करें", "माझे प्रोफाइल अपडेट करा"),
} as const satisfies Record<string, Text>;

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

  const [profile, lang] = await Promise.all([getMyDeliveryPartnerProfile(user.id), getBoardLang()]);
  const t = (text: Text) => tr(text, lang);
  if (!profile) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title={t(T.title)} />
        <EmptyState
          title={t(T.notPartner)}
          description={t(T.notPartnerText)}
          action={<LinkButton href="/delivery-partner/apply">{t(T.become)}</LinkButton>}
        />
      </div>
    );
  }
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN)) redirect("/delivery-partner");

  const earnings = await getPartnerEarningsSummary(profile.id);
  const latestChange = await getMyLatestChangeRequest(user.id);
  const isApproved = profile.status === "APPROVED";
  // C5: identity documents and the gate ID card (rule riderFiles).
  const riderFiles = await getRule("riderFiles");
  const documents = riderFiles.kycDocuments ? await listMyRiderDocuments(user.id) : [];
  // docs/gig-bank-payouts-2026-10: unpaid earnings, withdrawals and the bank account.
  const walletOn = await isFeatureEnabled("rider_bank_account_enabled");

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader
        title={t(T.title)}
        description={t(T.appliedOn).replace(
          "{date}",
          profile.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }),
        )}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/gig/orders" variant="secondary">
              {t(T.myDeliveries)}
            </LinkButton>
            {walletOn ? (
              <LinkButton href="/gig/wallet" variant="secondary">
                {t(T.myWallet)}
              </LinkButton>
            ) : null}
            <LinkButton href="/delivery-partner">{t(T.dashboard)}</LinkButton>
          </div>
        }
      />

      <Card className="mb-10 flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={profile.status} />
          {isApproved ? (
            profile.isOnline ? <Badge tone="success">{t(T.online)}</Badge> : <Badge>{t(T.offline)}</Badge>
          ) : null}
        </div>
        {isApproved ? null : (
          <p className="text-sm text-ink-500">{t(T.onlyApproved)}</p>
        )}
      </Card>

      {isApproved || earnings.deliveryCount > 0 ? (
        <Section
          title={t(T.earnings)}
          href={isApproved ? "/delivery-partner" : undefined}
          linkLabel={isApproved ? t(T.statement) : undefined}
        >
          <GigEarningsCard
            earnings={earnings}
            rating={{ avgX100: profile.ratingAvgX100, count: profile.ratingCount }}
            lang={lang}
          />
        </Section>
      ) : null}

      <Section title={t(T.personal)}>
        <Card className="p-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label={t(T.fullName)}>{profile.fullName}</Detail>
            <Detail label={t(T.mobile)}>{profile.mobile}</Detail>
            {profile.email ? <Detail label={t(T.email)}>{profile.email}</Detail> : null}
            {profile.dateOfBirth ? (
              <Detail label={t(T.dob)}>{formatDisplayDate(profile.dateOfBirth)}</Detail>
            ) : null}
          </dl>
          <p className="mt-4 text-xs text-ink-500">{t(T.encrypted)}</p>
        </Card>
      </Section>

      <Section title={t(T.vehicleArea)}>
        <Card className="p-5">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Detail label={t(T.vehicle)}>{vehicleTypeText(profile.vehicleType, lang)}</Detail>
            <Detail label={t(T.regNumber)}>
              {profile.vehicleRegistrationNumber ? (
                <span className="font-mono">{profile.vehicleRegistrationNumber}</span>
              ) : (
                t(T.notProvided)
              )}
            </Detail>
            <Detail label={t(T.radius)}>{profile.operatingRadiusKm} km</Detail>
            <Detail label={t(T.base)}>
              {profile.locationVerified ? <Badge tone="success">{t(T.verified)}</Badge> : <Badge tone="warning">{t(T.notVerified)}</Badge>}
            </Detail>
          </dl>
        </Card>
      </Section>
      {riderFiles.idCard && isApproved ? (
        <Section title={t(T.idCard)}>
          <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-ink-500">{t(T.idCardText)}</p>
            <LinkButton href="/gig/id-card">{t(T.showIdCard)}</LinkButton>
          </Card>
        </Section>
      ) : null}

      {riderFiles.kycDocuments && profile.status !== "DEACTIVATED" ? (
        <Section title={t(T.idDocs)}>
          <RiderDocumentsPanel
            documents={documents.map((d) => ({
              id: d.id,
              docType: d.docType,
              label: d.label,
              status: d.status,
              rejectionReason: d.rejectionReason,
              createdAt: d.createdAt.toISOString(),
            }))}
            lang={lang}
          />
        </Section>
      ) : null}

      {profile.status !== "DEACTIVATED" ? (
        <Section title={t(T.update)}>
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
            lang={lang}
          />
        </Section>
      ) : null}
    </div>
  );
}
