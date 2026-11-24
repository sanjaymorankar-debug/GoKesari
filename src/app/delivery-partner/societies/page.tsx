/**
 * docs/delta CF-006: a rider asks housing societies to add them to their rider list.
 * Only while the flag society_rider_join_requests_enabled is on (each request is also checked
 * against the society's district on the server); otherwise this page does not exist.
 */
import { notFound, redirect } from "next/navigation";

import { RiderSocietyJoin } from "@/components/delta/society-join";
import { Alert, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyDeliveryPartnerProfile } from "@/server/services/delivery-partners";
import { SOCIETY_JOIN_FLAG, listMyJoinRequests } from "@/server/services/delta/society-join-requests";
import { getFeatureFlag } from "@/server/services/feature-flags";

export const metadata = { title: "Join a society" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Join a society", "सोसाइटी से जुड़ें", "सोसायटीत सामील व्हा"),
  description: L(
    "Ask a housing society to add you to its rider list.",
    "किसी हाउसिंग सोसाइटी से कहें कि वह आपको अपनी राइडर सूची में जोड़े।",
    "एखाद्या हाउसिंग सोसायटीला तुम्हाला तिच्या रायडर यादीत जोडायला सांगा.",
  ),
  notApproved: L(
    "You can ask societies once your delivery partner account is approved.",
    "डिलीवरी पार्टनर खाता मंज़ूर होने के बाद आप सोसाइटियों से अनुरोध कर सकते हैं।",
    "डिलिव्हरी पार्टनर खाते मंजूर झाल्यावर तुम्ही सोसायट्यांना विनंती करू शकता.",
  ),
} as const;

export default async function RiderSocietiesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/societies");
  if (!(await getFeatureFlag(SOCIETY_JOIN_FLAG)).enabled) notFound();
  const partner = await getMyDeliveryPartnerProfile(user.id);
  if (!partner) redirect("/delivery-partner");

  const [requests, lang] = await Promise.all([listMyJoinRequests(user), getBoardLang()]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={tr(T.title, lang)} description={tr(T.description, lang)} />
      {partner.status !== "APPROVED" ? (
        <Alert tone="warning">{tr(T.notApproved, lang)}</Alert>
      ) : (
        <RiderSocietyJoin
          initialRequests={requests.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))}
        />
      )}
    </div>
  );
}
