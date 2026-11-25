/**
 * Tax register (docs/tax-register/README.md): the pure rules — which settings are tax settings,
 * who may decide, how CA items move and when a switch is cleared. No database access here.
 */
import type { UserRole } from "@/server/db/schema";
import type { CaItemStatus } from "@/server/db/tax-register-schema";

/**
 * Tax fields kept in the admin settings (src/server/config/rules.ts). With flag tax_register on,
 * these fields change only through an approved change request.
 */
export const TAX_RULE_FIELDS = {
  invoicing: ["defaultGstRateBp", "applyCess", "missingTaxData"],
  riderPayouts: ["tdsEnabled", "tdsRatePanBp", "tdsRateNoPanBp", "singlePaymentThresholdPaise", "annualThresholdPaise"],
  billing: [
    "tcsWhenShopCollects",
    "tdsWhenShopCollects",
    "shopDeliveryIsShopSupply",
    "compositionInterStateAllowed",
    "panOnlyServiceRule",
    "compositionRateBp",
    "compositionRestaurantRateBp",
  ],
  platformTaxProfile: ["gstin", "pan", "stateCode", "sacCodes"],
  health: ["primeGstBp"],
  dealerPayoutTds: ["enabled"],
} as const;
export type TaxRuleKey = keyof typeof TAX_RULE_FIELDS;
export const TAX_RULE_KEYS = Object.keys(TAX_RULE_FIELDS) as TaxRuleKey[];

export const isTaxRuleKey = (key: string): key is TaxRuleKey => key in TAX_RULE_FIELDS;

export function isTaxRuleField(ruleKey: string, field: string): boolean {
  const fields = (TAX_RULE_FIELDS as Record<string, readonly string[]>)[ruleKey];
  return !!fields && fields.includes(field);
}

/** Register key of a settings field, e.g. rule:riderPayouts.tdsRatePanBp. */
export const ruleParamKey = (ruleKey: string, field: string) => `rule:${ruleKey}.${field}`;

/** Order-independent JSON, so {a,b} and {b,a} compare equal. */
export function stableJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}
export const sameValue = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

/** The tax fields of a settings write that differ from the current value. */
export function changedTaxFields(ruleKey: string, current: Record<string, unknown>, next: Record<string, unknown>): string[] {
  const fields = (TAX_RULE_FIELDS as Record<string, readonly string[]>)[ruleKey] ?? [];
  return fields.filter((f) => f in next && !sameValue(current[f], next[f]));
}

/** Only the CA decides, and never on what they proposed or answered themselves. */
export function decisionRefusal(actor: { id: string; role: UserRole }, makerId: string | null): string | null {
  if (actor.role !== "CA") return "Only the CA approves or sends back.";
  if (makerId && makerId === actor.id) return "You cannot decide on your own proposal or answer.";
  return null;
}

export type CaItemAction = "SUBMIT" | "APPROVE" | "SEND_BACK" | "CLOSE" | "REOPEN";

/** The status an action leads to, or null when the action is not allowed from this status. */
export function nextCaItemStatus(current: CaItemStatus, action: CaItemAction): CaItemStatus | null {
  switch (action) {
    case "SUBMIT":
      return current === "OPEN" || current === "NEEDS_INFO" || current === "SUBMITTED" ? "SUBMITTED" : null;
    case "APPROVE":
      return current === "SUBMITTED" ? "APPROVED" : null;
    case "SEND_BACK":
      return current === "SUBMITTED" || current === "APPROVED" ? "NEEDS_INFO" : null;
    case "CLOSE":
      return current === "CLOSED" ? null : "CLOSED";
    case "REOPEN":
      return current === "CLOSED" || current === "APPROVED" ? "OPEN" : null;
  }
}

export interface SwitchClearance {
  key: string;
  cleared: boolean;
  /** Refs of the items still holding it back. */
  waitingOn: string[];
  /** Refs of the approved items that cleared it. */
  approvedBy: string[];
}

/**
 * A switch is cleared by the CA once every open item that names it is approved; closed items
 * do not hold anything back. Nothing is switched on here — an admin still does that.
 */
export function switchClearance(items: { ref: string; status: CaItemStatus; blocks: string[] }[]): SwitchClearance[] {
  const map = new Map<string, SwitchClearance>();
  for (const it of items) {
    if (it.status === "CLOSED") continue;
    for (const key of it.blocks) {
      const s = map.get(key) ?? { key, cleared: true, waitingOn: [], approvedBy: [] };
      if (it.status === "APPROVED") s.approvedBy.push(it.ref);
      else {
        s.cleared = false;
        s.waitingOn.push(it.ref);
      }
      map.set(key, s);
    }
  }
  return [...map.values()].sort((a, b) => Number(a.cleared) - Number(b.cleared) || a.key.localeCompare(b.key));
}
