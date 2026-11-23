/**
 * Dealership & Franchise Platform (docs/dealer-platform/): a scheme version's terms in plain words. Used on Admin →
 * Dealers → Schemes and on a dealer's page. Server-rendered; no state.
 */
import { CALCULATION_LABELS, describeCharge, describeComponent, type SchemeTerms } from "@/lib/dealer-schemes";

const GEOGRAPHY: Record<SchemeTerms["geography"]["scope"], string> = {
  ALL_INDIA: "All India",
  STATE: "Chosen states",
  DISTRICT: "Chosen districts",
  CITY: "Chosen cities",
  ZONE: "Booked franchise zone",
  CUSTOM: "Custom areas",
};
const EXCLUSIVITY: Record<SchemeTerms["exclusivity"], string> = { NONE: "Not exclusive", SHARED: "Shared", EXCLUSIVE: "Exclusive" };

export function SchemeTermsPanel({ terms, testId }: { terms: SchemeTerms; testId?: string }) {
  const rows: [string, string][] = [
    ["Joining charge", describeCharge(terms.charge)],
    ["Validity", terms.validityMonths ? `${terms.validityMonths} months${terms.renewal.allowed ? ", renewable" : ""}` : "No end date"],
    [
      "Where",
      `${GEOGRAPHY[terms.geography.scope]}${terms.geography.codes.length ? ` (${terms.geography.codes.join(", ")})` : ""} · ${EXCLUSIVITY[terms.exclusivity]}${terms.maxDealersPerTerritory ? ` · up to ${terms.maxDealersPerTerritory} per territory` : ""}`,
    ],
    ["Team building", terms.teamBuilding ? "Yes" : "No"],
    ["Calculation", CALCULATION_LABELS[terms.calculation]],
  ];
  return (
    <div className="text-sm text-ink-700" data-testid={testId}>
      <p>{terms.summary}</p>
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-ink-900">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {terms.components.length ? (
        <>
          <p className="mt-2 font-semibold text-ink-900">Commission</p>
          <ul className="ml-5 list-disc">
            {terms.components.map((c) => (
              <li key={c.id}>{describeComponent(c)}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
