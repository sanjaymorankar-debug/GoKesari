import { redirect } from "next/navigation";

import { LiveClock } from "@/components/live-clock";
import { SafeImage } from "@/components/safe-image";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { vehicleTypeText } from "@/lib/vehicle-types";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { getMyRiderIdCard } from "@/server/services/rider-files";

export const metadata = { title: "Rider ID card" };
export const dynamic = "force-dynamic";

const T = {
  title: L("Rider ID card", "राइडर ID कार्ड", "रायडर ID कार्ड"),
  notAvailable: L("Your ID card is not available", "आपका ID कार्ड उपलब्ध नहीं है", "तुमचे ID कार्ड उपलब्ध नाही"),
  notAvailableText: L(
    "The ID card is issued to approved delivery partners.",
    "ID कार्ड मंज़ूर डिलीवरी पार्टनर को दिया जाता है।",
    "ID कार्ड मंजूर डिलिव्हरी पार्टनरना दिले जाते.",
  ),
  myProfile: L("My delivery profile", "मेरी डिलीवरी प्रोफ़ाइल", "माझे डिलिव्हरी प्रोफाइल"),
  showAtGate: L("Show this at the society gate.", "इसे सोसाइटी गेट पर दिखाएँ।", "हे सोसायटीच्या गेटवर दाखवा."),
  partner: L("GoKesari delivery partner", "GoKesari डिलीवरी पार्टनर", "GoKesari डिलिव्हरी पार्टनर"),
  verifiedRider: L("Verified rider", "सत्यापित राइडर", "पडताळलेला रायडर"),
  photoOf: L("Photo of {name}", "{name} की फ़ोटो", "{name} यांचा फोटो"),
  name: L("Name", "नाम", "नाव"),
  riderId: L("Rider ID", "राइडर ID", "रायडर ID"),
  vehicle: L("Vehicle", "वाहन", "वाहन"),
  addPhoto: L(
    "Add your photo on your delivery profile so the gate can check it.",
    "अपनी डिलीवरी प्रोफ़ाइल पर फ़ोटो जोड़ें ताकि गेट पर जाँच हो सके।",
    "गेटवर तपासता यावे म्हणून तुमच्या डिलिव्हरी प्रोफाइलवर फोटो जोडा.",
  ),
  approvedFor: L("Approved for societies", "इन सोसाइटियों के लिए मंज़ूर", "या सोसायट्यांसाठी मंजूर"),
  noSociety: L(
    "No society has added you to its rider list yet.",
    "अभी किसी सोसाइटी ने आपको अपनी राइडर सूची में नहीं जोड़ा है।",
    "अजून कोणत्याही सोसायटीने तुम्हाला तिच्या रायडर यादीत जोडलेले नाही.",
  ),
  preferred: L("(preferred)", "(पसंदीदा)", "(पसंतीचा)"),
  statusChecked: L("Status checked", "स्थिति जाँची गई", "स्थिती तपासली"),
  now: L("Now:", "अभी:", "आता:"),
} as const;

/**
 * C5: the rider's digital ID card to show at a society gate — photo, name,
 * rider ID and the verified societies that list the rider, built fresh from
 * the server on every visit (the live clock shows it is not a screenshot).
 */
export default async function RiderIdCardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.DELIVERY_PARTNER_VIEW_OWN)) redirect("/delivery-partner");

  const [card, lang] = await Promise.all([getMyRiderIdCard(user.id), getBoardLang()]);
  if (!card) {
    return (
      <div className="mx-auto max-w-md">
        <PageHeader title={tr(T.title, lang)} />
        <EmptyState
          title={tr(T.notAvailable, lang)}
          description={tr(T.notAvailableText, lang)}
          action={<LinkButton href="/gig/profile">{tr(T.myProfile, lang)}</LinkButton>}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md pb-10">
      <PageHeader title={tr(T.title, lang)} description={tr(T.showAtGate, lang)} />
      <Card className="overflow-hidden" data-testid="rider-id-card">
        <div className="bg-kesari-600 px-5 py-3 text-white">
          <p className="text-xs uppercase tracking-wide">{tr(T.partner, lang)}</p>
          <p className="text-lg font-semibold">{tr(T.verifiedRider, lang)}</p>
        </div>
        <div className="flex gap-4 p-5">
          <SafeImage
            src={card.photoUrl}
            alt={tr(T.photoOf, lang).replace("{name}", card.fullName)}
            className="h-28 w-24 flex-none rounded-lg border border-cream-200 object-cover"
          />
          <dl className="space-y-1 text-sm">
            <div>
              <dt className="text-xs text-ink-500">{tr(T.name, lang)}</dt>
              <dd className="font-semibold text-ink-900" data-testid="rider-id-name">{card.fullName}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{tr(T.riderId, lang)}</dt>
              <dd className="font-mono font-semibold text-ink-900" data-testid="rider-id-code">{card.riderId}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{tr(T.vehicle, lang)}</dt>
              <dd className="text-ink-700">
                {vehicleTypeText(card.vehicleType, lang)}
                {card.vehicleRegistrationNumber ? ` · ${card.vehicleRegistrationNumber}` : ""}
              </dd>
            </div>
          </dl>
        </div>
        {!card.photoUrl ? (
          <p className="px-5 pb-3 text-xs text-amber-700">{tr(T.addPhoto, lang)}</p>
        ) : null}
        <div className="border-t border-cream-100 px-5 py-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">{tr(T.approvedFor, lang)}</p>
          {card.societies.length === 0 ? (
            <p className="text-sm text-ink-500" data-testid="rider-id-no-societies">{tr(T.noSociety, lang)}</p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="rider-id-societies">
              {card.societies.map((s) => (
                <li key={`${s.name}-${s.city}`}>
                  <span className="font-medium text-ink-900">{s.name}</span>
                  <span className="text-ink-500">{` — ${[s.area, s.city].filter(Boolean).join(", ")}`}</span>
                  {s.preferred ? <span className="ml-1 text-xs text-leaf-700">{tr(T.preferred, lang)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-cream-100 bg-cream-50 px-5 py-3 text-xs text-ink-500">
          {tr(T.statusChecked, lang)} {card.issuedAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}.
          {tr(T.now, lang)} <LiveClock />
        </div>
      </Card>
    </div>
  );
}
