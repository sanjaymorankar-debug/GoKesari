import { inArray } from "drizzle-orm";
import { redirect } from "next/navigation";

import { Alert, Card, EmptyState, LinkButton, Money, PageHeader, Section, StatusBadge } from "@/components/ui";
import { L, tr, type Lang, type Text } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders } from "@/server/db/schema";
import {
  getOfferTtlSeconds,
  getMyActiveDeliveryDetail,
  listMyDeliveryHistory,
  toRiderView,
} from "@/server/services/delivery-assignment";
import { listPartnerEarnings } from "@/server/services/delivery-earnings";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { formatScheduledSlot } from "@/lib/scheduled-slots";

export const metadata = { title: "My Deliveries" };
export const dynamic = "force-dynamic";

const ACTIVE_LABEL: Record<string, Text> = {
  OFFERED: L("New offer waiting for your answer", "नया ऑफ़र आपके जवाब का इंतज़ार कर रहा है", "नवीन ऑफर तुमच्या उत्तराची वाट पाहत आहे"),
  ACCEPTED: L("Accepted — head to the shop for pickup", "स्वीकार किया — पिकअप के लिए दुकान जाएँ", "स्वीकारली — पिकअपसाठी दुकानात जा"),
  PICKED_UP: L("Picked up — on the way to the customer", "उठा लिया — ग्राहक की ओर जा रहे हैं", "उचलली — ग्राहकाकडे जात आहात"),
};

/** The partner's account status in words; English keeps the lower-cased code as before. */
const PARTNER_STATUS_TEXT: Record<string, Text> = {
  REGISTERED: L("registered", "पंजीकृत", "नोंदणीकृत"),
  UNDER_REVIEW: L("under review", "जाँच में", "तपासणीत"),
  APPROVED: L("approved", "मंज़ूर", "मंजूर"),
  REJECTED: L("rejected", "अस्वीकृत", "नाकारलेले"),
  SUSPENDED: L("suspended", "निलंबित", "निलंबित"),
  DEACTIVATED: L("deactivated", "निष्क्रिय", "निष्क्रिय"),
};

const T = {
  title: L("My Deliveries", "मेरी डिलीवरी", "माझ्या डिलिव्हऱ्या"),
  notPartner: L("You're not a delivery partner yet", "आप अभी डिलीवरी पार्टनर नहीं हैं", "तुम्ही अजून डिलिव्हरी पार्टनर नाही"),
  notPartnerText: L(
    "Apply to deliver with GoKesari. Once you're approved and online, delivery offers are sent to you.",
    "GoKesari के साथ डिलीवरी के लिए आवेदन करें। मंज़ूरी के बाद ऑनलाइन होने पर आपको डिलीवरी ऑफ़र भेजे जाएँगे।",
    "GoKesari सोबत डिलिव्हरीसाठी अर्ज करा. मंजुरीनंतर ऑनलाइन असताना तुम्हाला डिलिव्हरी ऑफर पाठवल्या जातील.",
  ),
  become: L("Become a delivery partner", "डिलीवरी पार्टनर बनें", "डिलिव्हरी पार्टनर व्हा"),
  description: L(
    "Orders are offered to one nearby rider at a time. Accept, pick up and deliver from the rider dashboard.",
    "ऑर्डर एक बार में पास के एक राइडर को दिए जाते हैं। राइडर डैशबोर्ड से स्वीकार करें, उठाएँ और डिलीवर करें।",
    "ऑर्डर एका वेळी जवळच्या एका रायडरला दिल्या जातात. रायडर डॅशबोर्डवरून स्वीकारा, उचला आणि पोहोचवा.",
  ),
  myProfile: L("My profile", "मेरी प्रोफ़ाइल", "माझे प्रोफाइल"),
  dashboard: L("Rider dashboard", "राइडर डैशबोर्ड", "रायडर डॅशबोर्ड"),
  notReceiving: L("Not receiving offers", "ऑफ़र नहीं मिल रहे", "ऑफर मिळत नाहीत"),
  onlyApproved: L(
    "Only approved delivery partners are offered deliveries. Your delivery partner status is currently",
    "डिलीवरी सिर्फ़ मंज़ूर डिलीवरी पार्टनर को दी जाती है। आपकी डिलीवरी पार्टनर स्थिति अभी है:",
    "डिलिव्हरी फक्त मंजूर डिलिव्हरी पार्टनरना दिली जाते. तुमची डिलिव्हरी पार्टनर स्थिती सध्या आहे:",
  ),
  current: L("Current delivery", "मौजूदा डिलीवरी", "सध्याची डिलिव्हरी"),
  assigned: L("Assigned delivery", "सौंपी गई डिलीवरी", "दिलेली डिलिव्हरी"),
  deliver: L("Deliver", "डिलीवरी", "डिलिव्हरी"),
  pickup: L("Pickup", "पिकअप", "पिकअप"),
  drop: L("Drop", "ड्रॉप", "ड्रॉप"),
  addressOnOrder: L("Address on order details", "पता ऑर्डर विवरण में", "पत्ता ऑर्डर तपशिलात"),
  leg: L("Delivery leg", "डिलीवरी दूरी", "डिलिव्हरी अंतर"),
  cod: L("Cash on delivery", "कैश ऑन डिलीवरी", "कॅश ऑन डिलिव्हरी"),
  collect: L("Collect", "वसूलें", "घ्या"),
  acceptReject: L("Accept or reject", "स्वीकार या अस्वीकार करें", "स्वीकारा किंवा नाकारा"),
  continueDelivery: L("Continue delivery", "डिलीवरी जारी रखें", "डिलिव्हरी सुरू ठेवा"),
  movesOne: L(
    "Offers move to the next rider after 1 minute.",
    "1 मिनट बाद ऑफ़र अगले राइडर को चला जाता है।",
    "1 मिनिटानंतर ऑफर पुढच्या रायडरकडे जाते.",
  ),
  movesMany: L(
    "Offers move to the next rider after {n} minutes.",
    "{n} मिनट बाद ऑफ़र अगले राइडर को चला जाता है।",
    "{n} मिनिटांनंतर ऑफर पुढच्या रायडरकडे जाते.",
  ),
  actionsUnavailable: L(
    "Delivery actions are unavailable while your account is {status}. Please contact support about this delivery.",
    "आपका खाता {status} होने तक डिलीवरी के काम उपलब्ध नहीं हैं। इस डिलीवरी के बारे में सपोर्ट से संपर्क करें।",
    "तुमचे खाते {status} असेपर्यंत डिलिव्हरीची कामे उपलब्ध नाहीत. या डिलिव्हरीबद्दल सपोर्टशी संपर्क करा.",
  ),
  onlineWaiting: L(
    "You're online and waiting for a delivery offer.",
    "आप ऑनलाइन हैं और डिलीवरी ऑफ़र का इंतज़ार कर रहे हैं।",
    "तुम्ही ऑनलाइन आहात आणि डिलिव्हरी ऑफरची वाट पाहत आहात.",
  ),
  offlineHint: L(
    "You're offline. Go online from the rider dashboard to receive delivery offers.",
    "आप ऑफ़लाइन हैं। डिलीवरी ऑफ़र पाने के लिए राइडर डैशबोर्ड से ऑनलाइन हों।",
    "तुम्ही ऑफलाइन आहात. डिलिव्हरी ऑफर मिळवण्यासाठी रायडर डॅशबोर्डवरून ऑनलाइन व्हा.",
  ),
  goOnline: L("Go online", "ऑनलाइन हों", "ऑनलाइन व्हा"),
  noActive: L("No active delivery.", "कोई चालू डिलीवरी नहीं।", "सध्या कोणतीही डिलिव्हरी नाही."),
  history: L("Delivery history", "डिलीवरी इतिहास", "डिलिव्हरी इतिहास"),
  noneYet: L("No deliveries yet", "अभी कोई डिलीवरी नहीं", "अजून डिलिव्हरी नाही"),
  noneYetText: L(
    "Deliveries assigned to you are listed here once they're completed, failed or cancelled.",
    "आपको दी गई डिलीवरी पूरी, असफल या रद्द होने के बाद यहाँ दिखेंगी।",
    "तुम्हाला दिलेल्या डिलिव्हऱ्या पूर्ण, अयशस्वी किंवा रद्द झाल्यावर इथे दिसतील.",
  ),
  order: L("Order", "ऑर्डर", "ऑर्डर"),
} as const;

function partnerStatusText(status: string, lang: Lang): string {
  const english = status.replace(/_/g, " ").toLowerCase();
  if (lang === "en") return english;
  const text = PARTNER_STATUS_TEXT[status];
  return text ? tr(text, lang) : english;
}

function formatWhen(date: Date): string {
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}

function formatKm(distanceKm: string | null): string | null {
  return distanceKm ? `${Number(distanceKm).toFixed(1)} km` : null;
}

export default async function GigOrdersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [partner, lang] = await Promise.all([getMyDeliveryPartnerProfile(user.id), getBoardLang()]);
  const t = (text: Text) => tr(text, lang);
  if (!partner) {
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
  if (!can(user.role, PERMISSIONS.DELIVERY_ORDER_MANAGE_OWN)) redirect("/delivery-partner");

  const [active, history, earnings] = await Promise.all([
    getMyActiveDeliveryDetail(user.id),
    listMyDeliveryHistory(user.id),
    listPartnerEarnings(partner.id),
  ]);

  const past = history.filter((d) => d.id !== active?.id).map(toRiderView);
  const orderIds = past.map((d) => d.orderId);
  const orderRows =
    orderIds.length > 0
      ? await db
          .select({ id: orders.id, orderNumber: orders.orderNumber })
          .from(orders)
          .where(inArray(orders.id, orderIds))
      : [];
  const orderNumberById = new Map(orderRows.map((o) => [o.id, o.orderNumber]));
  const earnedByDelivery = new Map(earnings.map((e) => [e.deliveryOrderId, e.totalPaise]));
  const offerMinutes = Math.max(1, Math.round((await getOfferTtlSeconds()) / 60));
  const isApproved = partner.status === "APPROVED";
  const statusText = partnerStatusText(partner.status, lang);

  return (
    <div className="mx-auto max-w-3xl pb-10">
      <PageHeader
        title={t(T.title)}
        description={t(T.description)}
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/gig/profile" variant="secondary">
              {t(T.myProfile)}
            </LinkButton>
            <LinkButton href="/delivery-partner">{t(T.dashboard)}</LinkButton>
          </div>
        }
      />

      {isApproved ? null : (
        <div className="mb-6">
          <Alert tone="info" title={t(T.notReceiving)}>
            {t(T.onlyApproved)}{" "}
            {statusText}.
          </Alert>
        </div>
      )}

      <Section title={t(T.current)}>
        {active ? (
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-kesari-600">
                {isApproved ? (ACTIVE_LABEL[active.status] ? t(ACTIVE_LABEL[active.status]) : active.status) : t(T.assigned)}
              </p>
              <StatusBadge status={active.status} />
            </div>
            <p className="mt-2 font-semibold text-ink-900">{active.orderNumber}</p>
            {active.scheduledSlot ? (
              <p className="mt-1 text-sm font-medium text-kesari-700">
                {t(T.deliver)} {formatScheduledSlot(active.scheduledSlot.start, active.scheduledSlot.end)}
              </p>
            ) : null}
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="font-medium text-ink-700">{t(T.pickup)}</dt>
                <dd className="text-ink-500">
                  {active.shopName} — {active.shopAddress}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink-700">{t(T.drop)}</dt>
                <dd className="text-ink-500">{active.customerAddress ?? t(T.addressOnOrder)}</dd>
              </div>
              {formatKm(active.distanceKm) ? (
                <div>
                  <dt className="font-medium text-ink-700">{t(T.leg)}</dt>
                  <dd className="text-ink-500">~{formatKm(active.distanceKm)}</dd>
                </div>
              ) : null}
              {active.cashToCollectPaise != null ? (
                <div>
                  <dt className="font-medium text-ink-700">{t(T.cod)}</dt>
                  <dd className="text-ink-500">
                    {t(T.collect)} <Money paise={active.cashToCollectPaise} />
                  </dd>
                </div>
              ) : null}
            </dl>
            {isApproved ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <LinkButton href="/delivery-partner">
                  {active.status === "OFFERED" ? t(T.acceptReject) : t(T.continueDelivery)}
                </LinkButton>
                {active.status === "OFFERED" ? (
                  <p className="text-xs text-ink-500">
                    {offerMinutes === 1 ? t(T.movesOne) : t(T.movesMany).replace("{n}", String(offerMinutes))}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sm text-ink-500">{t(T.actionsUnavailable).replace("{status}", statusText)}</p>
            )}
          </Card>
        ) : isApproved ? (
          <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-ink-500">
              {partner.isOnline
                ? t(T.onlineWaiting)
                : t(T.offlineHint)}
            </p>
            {partner.isOnline ? null : <LinkButton href="/delivery-partner">{t(T.goOnline)}</LinkButton>}
          </Card>
        ) : (
          <Card className="p-5 text-sm text-ink-500">{t(T.noActive)}</Card>
        )}
      </Section>

      <Section title={t(T.history)}>
        {past.length === 0 ? (
          <EmptyState
            title={t(T.noneYet)}
            description={t(T.noneYetText)}
          />
        ) : (
          <Card className="divide-y divide-cream-100">
            {past.map((d) => {
              const orderNumber = orderNumberById.get(d.orderId);
              const earned = earnedByDelivery.get(d.id);
              const reason = d.status === "FAILED" ? d.failureReason : d.cancellationReason;
              const km = formatKm(d.distanceKm);
              return (
                <div key={d.id} className="flex flex-wrap items-start justify-between gap-2 p-4 text-sm">
                  <div>
                    <p className="font-medium text-ink-900">{orderNumber ?? t(T.order)}</p>
                    <p className="text-xs text-ink-500">
                      {formatWhen(d.deliveredAt ?? d.failedAt ?? d.cancelledAt ?? d.offeredAt)}
                      {km ? ` · ${km}` : ""}
                    </p>
                    {reason ? <p className="mt-1 text-xs text-ink-500">{reason}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    {earned != null ? <Money paise={earned} className="font-medium text-ink-900" /> : null}
                  </div>
                </div>
              );
            })}
          </Card>
        )}
      </Section>
    </div>
  );
}
