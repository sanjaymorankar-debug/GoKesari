/**
 * Turns the service's rows (Date fields) into the plain shapes the Rider pay plans page and its API
 * answer with. Pure: no database, no server-only imports.
 */
import { describePlan, type PaySlab } from "@/lib/rider-pay-plan";

import type { ScopeType } from "./format";
import type { PlanRow, PlanStatus, SimulationView, SurgeReason, SurgeRow } from "./types";

interface PlanLike {
  id: string;
  planKey: string;
  version: number;
  name: string;
  scopeType: string;
  city: string | null;
  zoneId: string | null;
  status: string;
  effectiveFrom: Date | null;
  publishedAt: Date | null;
  note: string | null;
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
  simulation: Record<string, unknown> | null;
  simulatedAt: Date | null;
  updatedAt: Date;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toPlanRow(plan: PlanLike, extra: { inForce?: boolean; words?: string[]; label?: string } = {}): PlanRow {
  return {
    id: plan.id,
    planKey: plan.planKey,
    version: plan.version,
    name: plan.name,
    label: extra.label ?? `${plan.name} v${plan.version}`,
    scopeType: plan.scopeType as ScopeType,
    city: plan.city,
    zoneId: plan.zoneId,
    status: plan.status as PlanStatus,
    inForce: extra.inForce ?? false,
    effectiveFrom: iso(plan.effectiveFrom),
    publishedAt: iso(plan.publishedAt),
    note: plan.note,
    words: extra.words ?? describePlan(plan),
    baseFeePaise: plan.baseFeePaise,
    baseIncludedM: plan.baseIncludedM,
    slabs: plan.slabs,
    freeFirstMileM: plan.freeFirstMileM,
    firstMileRatePaise: plan.firstMileRatePaise,
    firstMileCapPaise: plan.firstMileCapPaise,
    freeWaitMin: plan.freeWaitMin,
    waitRatePaise: plan.waitRatePaise,
    waitCapPaise: plan.waitCapPaise,
    extraDropFeePaise: plan.extraDropFeePaise,
    longDistanceM: plan.longDistanceM,
    longDistanceBonusPaise: plan.longDistanceBonusPaise,
    minGuaranteePaise: plan.minGuaranteePaise,
    maxPerOrderPaise: plan.maxPerOrderPaise,
    rerouteTolerancePct: plan.rerouteTolerancePct,
    simulation: (plan.simulation as SimulationView | null) ?? null,
    // The service refuses to publish when simulatedAt < updatedAt (an edit after the run).
    simulationCurrent: Boolean(plan.simulation && plan.simulatedAt && plan.simulatedAt >= plan.updatedAt),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

interface SurgeLike {
  id: string;
  city: string | null;
  zoneId: string | null;
  multiplierBp: number;
  flatPaise: number;
  reason: string;
  note: string | null;
  startsAt: Date;
  endsAt: Date;
  endedAt: Date | null;
}

export function toSurgeRow(s: SurgeLike): SurgeRow {
  return {
    id: s.id,
    city: s.city,
    zoneId: s.zoneId,
    multiplierBp: s.multiplierBp,
    flatPaise: s.flatPaise,
    reason: s.reason as SurgeReason,
    note: s.note,
    startsAt: s.startsAt.toISOString(),
    endsAt: s.endsAt.toISOString(),
    endedAt: iso(s.endedAt),
  };
}
