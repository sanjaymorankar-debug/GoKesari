/** Shapes the Rider pay plans page hands its client components (dates as ISO strings). */
import type { PaySlab, PayQuote, SurgeSource } from "@/lib/rider-pay-plan";

import type { ScopeType } from "./format";

export type PlanStatus = "DRAFT" | "SCHEDULED" | "ACTIVE" | "RETIRED";
export type SurgeReason = "RAIN" | "FESTIVAL" | "EVENT" | "OTHER";

export interface SimulationView {
  days: number;
  from: string;
  to: string;
  orders: number;
  inScope: number;
  draftTotalPaise: number;
  currentTotalPaise: number;
  draftAvgPaise: number;
  currentAvgPaise: number;
  changePaise: number;
  changePct: number | null;
  byArea: { area: string; orders: number; draftTotalPaise: number; currentTotalPaise: number; changePct: number | null }[];
  ranAt: string;
}

export interface PlanRow {
  id: string;
  planKey: string;
  version: number;
  name: string;
  label: string;
  scopeType: ScopeType;
  city: string | null;
  zoneId: string | null;
  status: PlanStatus;
  inForce: boolean;
  effectiveFrom: string | null;
  publishedAt: string | null;
  note: string | null;
  words: string[];
  baseFeePaise: number;
  baseIncludedM: number;
  slabs: PaySlab[];
  freeFirstMileM: number;
  firstMileRatePaise: number;
  firstMileCapPaise: number;
  freeWaitMin: number;
  waitRatePaise: number;
  waitCapPaise: number;
  extraDropFeePaise: number;
  longDistanceM: number | null;
  longDistanceBonusPaise: number;
  minGuaranteePaise: number;
  maxPerOrderPaise: number | null;
  rerouteTolerancePct: number;
  simulation: SimulationView | null;
  /** True when the stored simulator run was made on the draft as it is saved now. */
  simulationCurrent: boolean;
  updatedAt: string;
}

export interface SurgeRow {
  id: string;
  city: string | null;
  zoneId: string | null;
  multiplierBp: number;
  flatPaise: number;
  reason: SurgeReason;
  note: string | null;
  startsAt: string;
  endsAt: string;
  endedAt: string | null;
}

export interface ZoneOption {
  id: string;
  name: string;
  city: string;
  code: string | null;
}

export interface CostRow {
  orderId: string;
  orderNumber: string;
  customerDeliveryFeePaise: number;
  shopDeliveryChargePaise: number;
  riderPayoutPaise: number | null;
  riderQuotePaise: number | null;
  marginPaise: number | null;
}

export interface CalculatorResult {
  plan: { id: string; label: string; status: string };
  surges: SurgeSource[];
  quote: PayQuote;
  waitPaise: number;
  totalPaise: number;
}
