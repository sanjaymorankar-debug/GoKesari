/**
 * The shop's segment form (GS-052): what is wrong with the typed numbers, if
 * anything. TC-FLD-122: text in a number field used to be dropped, saving the
 * segment as "All customers".
 */
export interface SegmentRulesForm {
  pincodes: string;
  minOrders: string;
  orderedWithinDays: string;
  lapsedForDays: string;
  minSpendRupees: string;
}

const WHOLE_FIELDS: [keyof SegmentRulesForm, string][] = [
  ["minOrders", "Delivered orders"],
  ["orderedWithinDays", "Ordered within (days)"],
  ["lapsedForDays", "Has not ordered for (days)"],
];

export function segmentRulesProblem(form: SegmentRulesForm): string | null {
  for (const [key, label] of WHOLE_FIELDS) {
    const v = form[key].trim();
    if (v && !/^[1-9]\d*$/.test(v)) return `${label}: enter a whole number of 1 or more, or leave it blank.`;
  }
  const spend = form.minSpendRupees.trim();
  if (spend && !/^\d+(\.\d{1,2})?$/.test(spend)) return "Spent at least: enter an amount in rupees, e.g. 500 or 499.50, or leave it blank.";
  return null;
}
