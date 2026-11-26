import { notFound, redirect } from "next/navigation";

import { InsuranceClaimForm } from "@/components/rider-insurance/insurance-claim-form";
import { NomineeForm } from "@/components/rider-insurance/nominee-form";
import { Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { L, tr } from "@/lib/board/i18n";
import { formatPaiseCompact } from "@/lib/money";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { getMyInsuranceView } from "@/server/services/rider-insurance";

export const metadata = { title: "My insurance" };
export const dynamic = "force-dynamic";

const T = {
  title: L("My insurance", "मेरा बीमा", "माझा विमा"),
  comingSoonTitle: L("Rider insurance — coming soon", "राइडर बीमा — जल्द आ रहा है", "रायडर विमा — लवकरच येत आहे"),
  comingSoon: L(
    "We are arranging health and accident cover for GoKesari riders. You will be told here as soon as it starts.",
    "हम GoKesari राइडर्स के लिए स्वास्थ्य और दुर्घटना बीमा की व्यवस्था कर रहे हैं। शुरू होते ही आपको यहाँ बताया जाएगा।",
    "आम्ही GoKesari रायडर्ससाठी आरोग्य आणि अपघात विम्याची व्यवस्था करत आहोत. सुरू होताच तुम्हाला इथे कळवले जाईल.",
  ),
  coverage: L("Your coverage", "आपका बीमा कवर", "तुमचे विमा संरक्षण"),
  self: L("Coverage for self", "स्वयं के लिए कवर", "स्वतःसाठी संरक्षण"),
  rider: L("Rider", "राइडर", "रायडर"),
  health: L("Health cover", "स्वास्थ्य कवर", "आरोग्य संरक्षण"),
  accident: L("Accidental death cover", "दुर्घटना मृत्यु कवर", "अपघाती मृत्यू संरक्षण"),
  opd: L("OPD cover", "OPD कवर", "OPD संरक्षण"),
  status: L("Status", "स्थिति", "स्थिती"),
  active: L("Active", "सक्रिय", "सक्रिय"),
  inactive: L("Inactive", "निष्क्रिय", "निष्क्रिय"),
  policyNo: L("Policy no.", "पॉलिसी नं.", "पॉलिसी क्र."),
  insurer: L("Insurer", "बीमा कंपनी", "विमा कंपनी"),
  valid: L("Valid", "मान्य", "वैध"),
  to: L("to", "से", "ते"),
  rule: L(
    "You are covered while you complete at least {m} deliveries in the last {d} days. You have {n}.",
    "पिछले {d} दिनों में कम से कम {m} डिलीवरी पूरी करने पर आप कवर रहते हैं। आपकी {n} हैं।",
    "मागील {d} दिवसांत किमान {m} डिलिव्हऱ्या पूर्ण केल्यास तुम्हाला संरक्षण मिळते. तुमच्या {n} आहेत.",
  ),
  short: L("{s} more deliveries to become active.", "सक्रिय होने के लिए {s} और डिलीवरी।", "सक्रिय होण्यासाठी आणखी {s} डिलिव्हऱ्या."),
  outsideDates: L("The policy is not valid today.", "पॉलिसी आज मान्य नहीं है।", "पॉलिसी आज वैध नाही."),
  nominee: L("Nominee", "नॉमिनी", "नॉमिनी"),
  hospitals: L("Network hospitals", "नेटवर्क अस्पताल", "नेटवर्क रुग्णालये"),
  allHospitals: L("See all network hospitals", "सभी नेटवर्क अस्पताल देखें", "सर्व नेटवर्क रुग्णालये पाहा"),
  noHospitals: L("The hospital list will be added soon.", "अस्पतालों की सूची जल्द जोड़ी जाएगी।", "रुग्णालयांची यादी लवकरच जोडली जाईल."),
  claim: L("Raise a claim", "क्लेम करें", "क्लेम करा"),
  claimHelp: L("How to claim", "क्लेम कैसे करें", "क्लेम कसा करायचा"),
  back: L("Back", "वापस", "परत"),
} as const;

const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${String(d).padStart(2, "0")}-${months[m - 1]}-${y}`;
}

/** Rider App v2 (rule riderInsurance): the rider's insurance card, nominee, hospitals and claims. */
export default async function RiderInsurancePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?callbackUrl=/delivery-partner/insurance");
  const [view, lang] = await Promise.all([getMyInsuranceView(user.id), getBoardLang()]);
  if (!view) redirect("/delivery-partner/register");
  if (!view.enabled) notFound();
  const t = (text: (typeof T)[keyof typeof T]) => tr(text, lang);

  const back = (
    <div className="mt-6">
      <LinkButton href="/delivery-partner" variant="secondary">
        {t(T.back)}
      </LinkButton>
    </div>
  );

  if (!view.policy || !view.eligibility) {
    return (
      <div className="mx-auto max-w-lg">
        <PageHeader title={t(T.title)} />
        <Card className="p-5" data-testid="insurance-coming-soon">
          <h2 className="text-lg font-semibold text-ink-900">{t(T.comingSoonTitle)}</h2>
          <p className="mt-2 text-sm text-ink-600">{t(T.comingSoon)}</p>
        </Card>
        {back}
      </div>
    );
  }

  const { policy, eligibility } = view;
  const rows: [string, string][] = [
    [t(T.rider), view.riderName],
    [t(T.health), formatPaiseCompact(policy.healthCoverPaise)],
    [t(T.accident), formatPaiseCompact(policy.accidentCoverPaise)],
    [t(T.opd), formatPaiseCompact(policy.opdCoverPaise)],
    [t(T.policyNo), policy.policyNumber],
    [t(T.insurer), policy.insurer],
    [t(T.valid), `${formatDay(policy.validFrom)} ${t(T.to)} ${formatDay(policy.validTo)}`],
  ];

  return (
    <div className="mx-auto max-w-lg space-y-5">
      <PageHeader title={t(T.title)} />

      <Card className="p-5" data-testid="insurance-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-ink-900">{t(T.coverage)}</h2>
            <p className="text-xs text-ink-500">{t(T.self)}</p>
          </div>
          <Badge tone={eligibility.active ? "success" : "warning"}>
            {t(T.status)}: {eligibility.active ? t(T.active) : t(T.inactive)}
          </Badge>
        </div>
        <dl className="mt-4 divide-y divide-cream-200 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-3 py-2">
              <dt className="text-ink-500">{label}</dt>
              <dd className="text-right font-medium text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-ink-600">
          {fill(t(T.rule), { m: policy.minDeliveries, d: policy.lookbackDays, n: view.deliveredInWindow })}
          {!eligibility.withinDates ? ` ${t(T.outsideDates)}` : eligibility.deliveriesShort > 0 ? ` ${fill(t(T.short), { s: eligibility.deliveriesShort })}` : ""}
        </p>
      </Card>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">{t(T.nominee)}</h2>
        <NomineeForm initial={view.nominee} lang={lang} />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">{t(T.hospitals)}</h2>
        <Card className="p-5 text-sm">
          {policy.hospitals.length ? (
            <ul className="divide-y divide-cream-200" data-testid="insurance-hospitals">
              {policy.hospitals.map((h, i) => (
                <li key={`${h.name}-${i}`} className="py-2">
                  <p className="font-medium text-ink-900">{h.name}</p>
                  <p className="text-ink-600">{[h.address, h.city].filter(Boolean).join(", ")}</p>
                  {h.phone ? (
                    <a href={`tel:${h.phone.replace(/[^\d+]/g, "")}`} className="text-kesari-700 underline">
                      {h.phone}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : !policy.hospitalsUrl ? (
            <p className="text-ink-600">{t(T.noHospitals)}</p>
          ) : null}
          {policy.hospitalsUrl ? (
            <a href={policy.hospitalsUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block font-medium text-kesari-700 underline">
              {t(T.allHospitals)}
            </a>
          ) : null}
        </Card>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold text-ink-900">{t(T.claim)}</h2>
        {policy.claimHelp ? (
          <Card className="mb-3 p-4 text-sm">
            <p className="font-medium text-ink-900">{t(T.claimHelp)}</p>
            <p className="mt-1 whitespace-pre-line text-ink-700">{policy.claimHelp}</p>
          </Card>
        ) : null}
        <InsuranceClaimForm lang={lang} />
      </section>
      {back}
    </div>
  );
}
