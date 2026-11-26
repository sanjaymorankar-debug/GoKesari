import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { DeliveryPartnerDashboard } from "@/components/delivery-partner-dashboard";
import { RoleSwitcher } from "@/components/role-switcher";
import { Alert, Card, Money, PageHeader, StatusBadge } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { vehicleTypeText } from "@/lib/vehicle-types";
import { getBoardLang } from "@/server/board-lang";
import { getCurrentUser } from "@/server/authz/guards";
import { PERMISSIONS, can } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { deliveryOrders, deliveryPartners, orders, type UserRole } from "@/server/db/schema";
import { getMyActiveDeliveryDetail, getMyOtherActiveDeliveries } from "@/server/services/delivery-assignment";
import { RiderOtherDeliveries } from "@/components/rider-other-deliveries";
import { RiderTripCard } from "@/components/rider-trip-card";
import { getRiderTrip } from "@/server/services/delivery-trips";
import { getMyActiveReturnPickup } from "@/server/services/return-pickups";
import { getRiderEarningsView, listAdjustments, listRiderPayouts } from "@/server/services/finance";
import { getPartnerEarningsSummary } from "@/server/services/delivery-earnings";
import { getAvailabilityGate, getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { RiderVerificationChecklist } from "@/components/rider-verification-checklist";
import { listMyBackgroundDocs } from "@/server/services/rider-background-docs";
import { getMyRiderKyc } from "@/server/services/rider-kyc";
import { listUserRoles } from "@/server/services/roles";
// batch-2026-10 WS-B: broadcast offers, pickup QR, in-app navigation (each behind its own rule).
import { RiderBroadcastOffers } from "@/components/rider-broadcast-offers";
import { getRiderBroadcastSettings } from "@/server/services/dispatch-broadcast";
import { isRiderNavigationEnabled } from "@/server/services/rider-navigation";
import { getRule } from "@/server/services/settings";
import { SOCIETY_JOIN_FLAG } from "@/server/services/delta/society-join-requests";
import { getFeatureFlag } from "@/server/services/feature-flags";
// Rider App v2 (docs/rider-app-v2-2026-11): Home, Available Deliveries and "You earn ₹X" (each behind its rule).
import { AvailableDeliveries } from "@/components/rider-shell/available-deliveries";
import { HighEarningBanner } from "@/components/rider-shell/high-earning-banner";
import { ImportantMessages, IncentiveLadderCard, RiderShortcutTiles } from "@/components/rider-shell/home-sections";
import { getRiderHome } from "@/server/services/rider-home";
import { quoteForOwnOffer } from "@/server/services/rider-job-board";

/** Module 6: this page's words in English, Hindi and Marathi. */
const T = {
  seconds: L("{n} seconds", "{n} सेकंड", "{n} सेकंद"),
  oneMinute: L("1 minute", "1 मिनट", "1 मिनिट"),
  minutes: L("{n} minutes", "{n} मिनट", "{n} मिनिटे"),
  offerLabel: L("New delivery offer — accept within {w}", "नया डिलीवरी ऑफ़र — {w} में स्वीकार करें", "नवीन डिलिव्हरी ऑफर — {w} मध्ये स्वीकारा"),
  title: L("My Delivery Partner Application", "मेरा डिलीवरी पार्टनर आवेदन", "माझा डिलिव्हरी पार्टनर अर्ज"),
  joinSociety: L("Join a housing society's rider list", "किसी हाउसिंग सोसाइटी की राइडर सूची में जुड़ें", "हाउसिंग सोसायटीच्या रायडर यादीत सामील व्हा"),
  reason: L("Reason", "कारण", "कारण"),
  teamNote: L("Note from our team", "हमारी टीम का संदेश", "आमच्या टीमची नोंद"),
  details: L("Application details", "आवेदन का विवरण", "अर्जाचा तपशील"),
  fullName: L("Full name", "पूरा नाम", "पूर्ण नाव"),
  mobile: L("Mobile", "मोबाइल", "मोबाइल"),
  vehicle: L("Vehicle", "वाहन", "वाहन"),
  radius: L("Operating radius", "काम का दायरा", "कामाचा परिसर"),
  switchRoleTitle: L("Switch to your Delivery Partner role", "अपनी डिलीवरी पार्टनर भूमिका पर जाएँ", "तुमच्या डिलिव्हरी पार्टनर भूमिकेवर जा"),
  switchRole1: L(
    "You're browsing with another role, so you can't go online or take deliveries",
    "आप किसी दूसरी भूमिका में हैं, इसलिए ऑनलाइन नहीं हो सकते और डिलीवरी नहीं ले सकते",
    "तुम्ही दुसऱ्या भूमिकेत आहात, त्यामुळे ऑनलाइन होऊ शकत नाही किंवा डिलिव्हरी घेऊ शकत नाही",
  ),
  switchRoleOnline: L(
    " — but you are still marked online and may be offered deliveries",
    " — लेकिन आप अभी भी ऑनलाइन दिख रहे हैं और आपको डिलीवरी ऑफ़र मिल सकते हैं",
    " — पण तुम्ही अजूनही ऑनलाइन दिसत आहात आणि तुम्हाला डिलिव्हरी ऑफर मिळू शकतात",
  ),
  switchRole2: L(
    ". Choose “Delivery Partner” in the “Acting as” menu at the top of the page, or here:",
    "। पेज के ऊपर “भूमिका” मेनू में “डिलीवरी पार्टनर” चुनें, या यहाँ:",
    ". पानाच्या वरच्या “भूमिका” मेनूमध्ये “डिलिव्हरी पार्टनर” निवडा, किंवा इथे:",
  ),
  noRoleTitle: L("Delivery Partner role not active", "डिलीवरी पार्टनर भूमिका सक्रिय नहीं", "डिलिव्हरी पार्टनर भूमिका सक्रिय नाही"),
  noRole: L(
    "Your account no longer holds the Delivery Partner role, so you can't go online or take deliveries. Please contact support.",
    "आपके खाते में अब डिलीवरी पार्टनर भूमिका नहीं है, इसलिए आप ऑनलाइन नहीं हो सकते और डिलीवरी नहीं ले सकते। कृपया सहायता से संपर्क करें।",
    "तुमच्या खात्यात आता डिलिव्हरी पार्टनर भूमिका नाही, त्यामुळे तुम्ही ऑनलाइन होऊ शकत नाही किंवा डिलिव्हरी घेऊ शकत नाही. कृपया सहाय्याशी संपर्क साधा.",
  ),
  earnings: L("Earnings", "कमाई", "कमाई"),
  notPaid: L("Not yet paid out:", "अभी तक भुगतान नहीं हुआ:", "अजून पैसे मिळाले नाहीत:"),
  inclAdj: L("(incl. adjustments", "(समायोजन सहित", "(समायोजनांसह"),
  noEarnings: L("No earnings yet.", "अभी कोई कमाई नहीं।", "अजून कमाई नाही."),
  delivery: L("delivery", "डिलीवरी", "डिलिव्हरी"),
  adjustments: L("Adjustments", "समायोजन", "समायोजने"),
  payouts: L("Payouts", "पेआउट", "पेआउट"),
  noPayouts: L("Earnings are paid out weekly — nothing batched yet.", "कमाई हर हफ़्ते दी जाती है — अभी कुछ जमा नहीं हुआ।", "कमाई दर आठवड्याला दिली जाते — अजून काही जमा झालेले नाही."),
  week: L("Week from {d} · {n} deliveries", "{d} से शुरू हफ़्ता · {n} डिलीवरी", "{d} पासूनचा आठवडा · {n} डिलिव्हऱ्या"),
  homeTitle: L("Home", "होम", "होम"),
  seeEarnings: L("See this week's earnings and payouts", "इस हफ़्ते की कमाई और पेआउट देखें", "या आठवड्याची कमाई आणि पेआउट पाहा"),
} as const;

/** G1: "You earn ₹X" for the rider's own OFFERED delivery (null when none or it cannot be priced). */
async function offerEarnFor(deliveryOrderId: string) {
  const [row] = await db
    .select({ delivery: deliveryOrders, subtotalPaise: orders.subtotalPaise })
    .from(deliveryOrders)
    .innerJoin(orders, eq(orders.id, deliveryOrders.orderId))
    .where(eq(deliveryOrders.id, deliveryOrderId));
  if (!row || row.delivery.status !== "OFFERED") return null;
  return quoteForOwnOffer(row.delivery, row.subtotalPaise);
}

/** "45 seconds" / "1 minute" / "3 minutes" — the offer window from the rules. */
function offerWindowText(seconds: number, lang: Lang): string {
  if (seconds % 60 !== 0) return tr(T.seconds, lang).replace("{n}", String(seconds));
  const minutes = seconds / 60;
  return minutes === 1 ? tr(T.oneMinute, lang) : tr(T.minutes, lang).replace("{n}", String(minutes));
}

export const metadata = { title: "My Delivery Partner Application" };
export const dynamic = "force-dynamic";

const STATUS_MESSAGE: Record<string, ReturnType<typeof L>> = {
  REGISTERED: L(
    "Your application has been received and is waiting to be reviewed.",
    "आपका आवेदन मिल गया है और जाँच का इंतज़ार कर रहा है।",
    "तुमचा अर्ज मिळाला आहे आणि तपासणीची वाट पाहत आहे.",
  ),
  UNDER_REVIEW: L("Our team is reviewing your application.", "हमारी टीम आपका आवेदन देख रही है।", "आमची टीम तुमचा अर्ज तपासत आहे."),
  APPROVED: L("You're approved as a delivery partner.", "आप डिलीवरी पार्टनर के रूप में मंज़ूर हैं।", "तुम्हाला डिलिव्हरी पार्टनर म्हणून मंजुरी मिळाली आहे."),
  REJECTED: L("Your application was not approved.", "आपका आवेदन मंज़ूर नहीं हुआ।", "तुमचा अर्ज मंजूर झाला नाही."),
  SUSPENDED: L("Your delivery partner account is currently suspended.", "आपका डिलीवरी पार्टनर खाता अभी निलंबित है।", "तुमचे डिलिव्हरी पार्टनर खाते सध्या निलंबित आहे."),
  DEACTIVATED: L("Your delivery partner account has been deactivated.", "आपका डिलीवरी पार्टनर खाता बंद कर दिया गया है।", "तुमचे डिलिव्हरी पार्टनर खाते बंद केले आहे."),
};

const APPROVED_CHECKS = L(
  "You're approved — finish {checks} below to start delivering: {list}.",
  "आप मंज़ूर हैं — डिलीवरी शुरू करने के लिए नीचे {checks} पूरी करें: {list}।",
  "तुम्हाला मंजुरी मिळाली आहे — डिलिव्हरी सुरू करण्यासाठी खालील {checks} पूर्ण करा: {list}.",
);
const ONE_CHECK = L("1 more check", "1 और जाँच", "आणखी 1 तपासणी");
const N_CHECKS = L("{n} more checks", "{n} और जाँचें", "आणखी {n} तपासण्या");

/**
 * D-140: one clear status with the next step first. An approved partner who still has checks to
 * pass before going Active hears that, not just "approved" above a list of checks not started.
 */
function statusMessage(status: string, gate: { allowed: boolean; missing: string[] }, lang: Lang): string | undefined {
  if (status === "APPROVED" && !gate.allowed && gate.missing.length > 0) {
    const n = gate.missing.length;
    const checks = n === 1 ? tr(ONE_CHECK, lang) : tr(N_CHECKS, lang).replace("{n}", String(n));
    return tr(APPROVED_CHECKS, lang).replace("{checks}", checks).replace("{list}", gate.missing.join("; "));
  }
  const message = STATUS_MESSAGE[status];
  return message ? tr(message, lang) : undefined;
}

/**
 * Self-service status page — a minimal complement to registration (Slice B).
 * The fuller dashboard (deliveries, earnings, online toggle) is Slice C,
 * once there's an assignment/earnings system for it to show.
 */
export default async function DeliveryPartnerStatusPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const lang = await getBoardLang();
  const t = (text: ReturnType<typeof L>) => tr(text, lang);

  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner/apply");
  const partnerRating = await db.query.deliveryPartners.findFirst({
    where: eq(deliveryPartners.id, partner.id),
    columns: { ratingAvgX100: true, ratingCount: true },
  });

  const [activeDelivery, earnings] =
    partner.status === "APPROVED"
      ? await Promise.all([getMyActiveDeliveryDetail(user.id), getPartnerEarningsSummary(partner.id)])
      : [null, { todayPaise: 0, totalPaise: 0, deliveryCount: 0 }];
  const activeReturnPickup = partner.status === "APPROVED" ? await getMyActiveReturnPickup(user.id) : null;
  const otherDeliveries = partner.status === "APPROVED" ? await getMyOtherActiveDeliveries(user.id) : [];
  // GA-005: the stop order when the rider carries several orders in one trip.
  const trip = partner.status === "APPROVED" ? await getRiderTrip(user.id) : null;
  // Weekly payouts (GS-064) — what has been batched and paid to the rider's bank.
  const [payouts, earningsView, adjustments] =
    partner.status === "APPROVED"
      ? await Promise.all([
          listRiderPayouts({ deliveryPartnerId: partner.id, limit: 12 }),
          getRiderEarningsView(partner.id, 30),
          listAdjustments({ deliveryPartnerId: partner.id, limit: 20 }),
        ])
      : [[], null, []];
  // GS-003: the dashboard's actions all need the Delivery Partner role to be the active one.
  const canDeliver = can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN);
  const [broadcast, pickupQr, inAppNavigation] =
    partner.status === "APPROVED" && canDeliver
      ? await Promise.all([
          getRiderBroadcastSettings(),
          getRule("pickupQr").then((r) => r.enabled),
          isRiderNavigationEnabled(),
        ])
      : [null, false, false];
  const roles: UserRole[] = partner.status === "APPROVED" && !canDeliver ? await listUserRoles(user.id) : [];
  // Gig worker flow: KYC and police verification status, and whether they still block Active / Ready.
  const [kyc, backgroundDocs, gate] = await Promise.all([
    getMyRiderKyc(user.id),
    listMyBackgroundDocs(user.id),
    getAvailabilityGate(partner),
  ]);
  // docs/delta CF-006: link to "Join a society" while the flag is on.
  const societyJoinOn = partner.status === "APPROVED" && (await getFeatureFlag(SOCIETY_JOIN_FLAG)).enabled;
  // Rider App v2: rules riderAppV2 (Home) and riderJobBoard (Available Deliveries); G1 follows the offer card.
  const [appV2, jobBoard, offerEarn] =
    partner.status === "APPROVED" && canDeliver
      ? await Promise.all([
          getRule("riderAppV2").then((r) => r.enabled),
          getRule("riderJobBoard"),
          activeDelivery?.status === "OFFERED" ? offerEarnFor(activeDelivery.id).catch(() => null) : Promise.resolve(null),
        ])
      : [false, null, null];
  const availableDeliveries =
    canDeliver && jobBoard?.enabled ? <AvailableDeliveries initialPollSeconds={jobBoard.pollSeconds} lang={lang} /> : null;
  const dashboard = canDeliver ? (
    <DeliveryPartnerDashboard
      isOnline={partner.isOnline}
      availability={partner.availability}
      gate={{ allowed: gate.allowed, missing: gate.missing }}
      activeDelivery={activeDelivery}
      activeReturnPickup={activeReturnPickup}
      earnings={earnings}
      rating={{ avgX100: partnerRating?.ratingAvgX100 ?? 0, count: partnerRating?.ratingCount ?? 0 }}
      offerLabel={broadcast ? t(T.offerLabel).replace("{w}", offerWindowText(broadcast.singleOfferSeconds, lang)) : undefined}
      pickupQr={pickupQr}
      inAppNavigation={inAppNavigation}
      offerEarn={offerEarn}
      lang={lang}
    />
  ) : null;

  if (appV2) {
    // Rider App v2 Home (the header and bottom bar come from the layout).
    const home = await getRiderHome(partner.id, user.id);
    const online = partner.availability !== "OFFLINE";
    const banner = <HighEarningBanner items={home.banner} online={online} canGoOnline={gate.allowed} lang={lang} />;
    return (
      <div className="mx-auto max-w-2xl space-y-4" data-testid="rider-home-v2">
        <h1 className="sr-only">{t(T.homeTitle)}</h1>
        {!gate.allowed ? <RiderVerificationChecklist kyc={kyc} documents={backgroundDocs} gate={gate} lang={lang} /> : null}
        {activeDelivery ? null : banner}
        {broadcast ? <RiderBroadcastOffers initialPollSeconds={broadcast.pollSeconds} lang={lang} /> : null}
        {availableDeliveries}
        {dashboard}
        {trip ? <RiderTripCard stops={trip.stops} lang={lang} /> : null}
        <RiderOtherDeliveries deliveries={otherDeliveries} lang={lang} />
        {activeDelivery ? banner : null}
        <RiderShortcutTiles lang={lang} />
        {home.ladders.map((ladder) => (
          <IncentiveLadderCard key={ladder.period} ladder={ladder} lang={lang} />
        ))}
        <ImportantMessages messages={home.messages} lang={lang} />
        <p className="text-center text-sm">
          <a className="font-medium text-kesari-700 underline" href="/delivery-partner/earnings">
            {t(T.seeEarnings)}
          </a>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t(T.title)} />
      {societyJoinOn ? (
        <p className="-mt-4 mb-4 text-sm">
          <a className="font-medium text-kesari-700 underline" href="/delivery-partner/societies">
            {t(T.joinSociety)}
          </a>
        </p>
      ) : null}

      <Card className="mb-6 p-6">
        <div className="mb-3 flex items-center gap-2">
          <StatusBadge status={partner.status} />
        </div>
        <p className="text-sm text-ink-700">{statusMessage(partner.status, gate, lang)}</p>

        {partner.status === "REJECTED" && partner.rejectionReason ? (
          <div className="mt-3">
            <Alert tone="danger" title={t(T.reason)}>
              {partner.rejectionReason}
            </Alert>
          </div>
        ) : null}
        {partner.status === "SUSPENDED" && partner.rejectionReason ? (
          <div className="mt-3">
            <Alert tone="warning" title={t(T.reason)}>
              {partner.rejectionReason}
            </Alert>
          </div>
        ) : null}
        {partner.reviewNotes ? (
          <div className="mt-3">
            <Alert tone="info" title={t(T.teamNote)}>
              {partner.reviewNotes}
            </Alert>
          </div>
        ) : null}
      </Card>

      {partner.status !== "DEACTIVATED" && partner.status !== "REJECTED" ? (
        <div className="mb-6">
          <RiderVerificationChecklist kyc={kyc} documents={backgroundDocs} gate={gate} lang={lang} />
        </div>
      ) : null}

      <Card className="p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">
          {t(T.details)}
        </h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-ink-700">{t(T.fullName)}</dt>
            <dd className="text-ink-500">{partner.fullName}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">{t(T.mobile)}</dt>
            <dd className="text-ink-500">{partner.mobile}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">{t(T.vehicle)}</dt>
            <dd className="text-ink-500">{vehicleTypeText(partner.vehicleType, lang)}</dd>
          </div>
          <div>
            <dt className="font-medium text-ink-700">{t(T.radius)}</dt>
            <dd className="text-ink-500">{partner.operatingRadiusKm} km</dd>
          </div>
        </dl>
      </Card>

      {partner.status === "APPROVED" ? (
        <div className="mt-4">
          {canDeliver && broadcast ? (
            <div className="mb-4">
              <RiderBroadcastOffers initialPollSeconds={broadcast.pollSeconds} lang={lang} />
            </div>
          ) : null}
          {availableDeliveries ? <div className="mb-4">{availableDeliveries}</div> : null}
          {dashboard}
          {canDeliver && trip ? <RiderTripCard stops={trip.stops} lang={lang} /> : null}
          {canDeliver ? (
            <RiderOtherDeliveries deliveries={otherDeliveries} lang={lang} />
          ) : roles.includes("DELIVERY_PARTNER") ? (
            <Alert tone="warning" title={t(T.switchRoleTitle)}>
              <p>
                {t(T.switchRole1)}
                {partner.isOnline ? t(T.switchRoleOnline) : ""}
                {t(T.switchRole2)}
              </p>
              <div className="mt-2">
                <RoleSwitcher active={user.role} roles={roles} />
              </div>
            </Alert>
          ) : (
            <Alert tone="warning" title={t(T.noRoleTitle)}>
              {t(T.noRole)}
            </Alert>
          )}
          {earningsView ? (
            <Card className="mt-4 scroll-mt-20 p-5" id="rider-earnings" data-testid="rider-earnings">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.earnings)}</h2>
              <p className="mb-3 text-sm text-ink-600">
                {t(T.notPaid)} <Money paise={earningsView.pendingEarningsPaise + earningsView.pendingAdjustmentsPaise} />
                {earningsView.pendingAdjustmentsPaise !== 0 ? (
                  <span className="text-xs text-ink-500">
                    {" "}
                    {t(T.inclAdj)} <Money paise={earningsView.pendingAdjustmentsPaise} />)
                  </span>
                ) : null}
              </p>
              {earningsView.earnings.length === 0 ? (
                <p className="text-sm text-ink-500">{t(T.noEarnings)}</p>
              ) : (
                <ul className="divide-y divide-cream-100 text-sm">
                  {earningsView.earnings.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        {e.orderNumber}
                        <span className="text-xs text-ink-500"> · {t(T.delivery)} {e.deliveryStatus.toLowerCase()}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <StatusBadge status={e.status} />
                        <Money paise={e.totalPaise} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {adjustments.length > 0 ? (
                <>
                  <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">{t(T.adjustments)}</p>
                  <ul className="divide-y divide-cream-100 text-sm">
                    {adjustments.map(({ adjustment: a, orderNumber }) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>
                          {a.reason}
                          {orderNumber ? <span className="text-xs text-ink-500"> · {orderNumber}</span> : null}
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge status={a.status} />
                          <Money paise={a.amountPaise} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Card>
          ) : null}
          <Card className="mt-4 scroll-mt-20 p-5" id="rider-payouts" data-testid="rider-payouts">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-ink-500">{t(T.payouts)}</h2>
            {payouts.length === 0 ? (
              <p className="text-sm text-ink-500">{t(T.noPayouts)}</p>
            ) : (
              <ul className="divide-y divide-cream-100 text-sm">
                {payouts.map(({ payout }) => (
                  <li key={payout.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {t(T.week).replace("{d}", payout.periodStart).replace("{n}", String(payout.earningsCount))}
                      {payout.paymentReference ? ` · ref ${payout.paymentReference}` : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={payout.status} />
                      <Money paise={payout.amountPaise} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
