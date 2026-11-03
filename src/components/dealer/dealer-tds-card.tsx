import { Badge, Card } from "@/components/ui";

const rs = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** Gap report D6: the payee's TDS — PAN on file, the rate that applies, TDS this financial year, Form 16A downloads. */
export function DealerTdsCard({
  view,
}: {
  view: {
    tdsOn: boolean;
    panOnFile: boolean;
    rateBp: number | null;
    thresholdPaise: number | null;
    section: string | null;
    financialYear: string;
    grossThisYearPaise: number;
    tdsThisYearPaise: number;
    forms16a: { id: string; financialYear: string; quarter: number; certificateNumber: string }[];
  };
}) {
  return (
    <Card className="space-y-2 p-4" data-testid="dealer-tds">
      <h2 className="text-base font-bold text-ink-900">Tax deducted (TDS)</h2>
      <p className="text-sm text-ink-700">
        PAN {view.panOnFile ? <Badge tone="success">on file</Badge> : <Badge tone="warning">missing — commission is held until it is added</Badge>}
        {view.tdsOn && view.rateBp != null
          ? ` · ${view.rateBp / 100}% once your commission in a year passes ${rs(view.thresholdPaise ?? 0)}${view.section ? ` (${view.section})` : ""}`
          : " · no TDS is deducted at present"}
      </p>
      <p className="text-sm text-ink-700">
        {view.financialYear}: commission paid {rs(view.grossThisYearPaise)}, TDS {rs(view.tdsThisYearPaise)}.
      </p>
      {view.forms16a.length ? (
        <ul className="space-y-1 text-sm">
          {view.forms16a.map((f) => (
            <li key={f.id}>
              <a className="underline" href={`/api/dealer/tds?form16a=${f.id}`}>
                Form 16A {f.financialYear} Q{f.quarter} ({f.certificateNumber})
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-500">No Form 16A yet.</p>
      )}
    </Card>
  );
}
