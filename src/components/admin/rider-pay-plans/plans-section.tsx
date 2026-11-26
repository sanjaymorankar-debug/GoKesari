"use client";

import { Fragment, useState } from "react";

import { Badge, Button, Card } from "@/components/ui";

import { formatIstDateTime, type ScopeType } from "./format";
import { PlanEditor, scopeText, STATUS_TONE } from "./plan-editor";
import type { PlanRow, ZoneOption } from "./types";

const SCOPES: { key: ScopeType; title: string; help: string }[] = [
  { key: "DEFAULT", title: "Default", help: "Prices every job that no city or zone plan covers." },
  { key: "CITY", title: "City", help: "Beats the default plan for shops in that city." },
  { key: "ZONE", title: "Zone", help: "Beats city and default plans for shops inside that delivery zone." },
];

/** Plans grouped by scope, each plan with its versions (newest first); opens the editor. */
export function PlansSection({ plans, zones }: { plans: PlanRow[]; zones: ZoneOption[] }) {
  const [open, setOpen] = useState<string | "new" | null>(null);
  const editing = open && open !== "new" ? plans.find((p) => p.id === open) : undefined;

  return (
    <section className="space-y-3" aria-labelledby="pay-plans-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pay-plans-heading" className="text-lg font-semibold text-ink-900">
          Pay plans
        </h2>
        <Button size="sm" onClick={() => setOpen("new")}>
          New plan
        </Button>
      </div>

      {open === "new" ? <PlanEditor key="new" zones={zones} onClose={() => setOpen(null)} onOpen={setOpen} /> : null}
      {open && open !== "new" ? (
        editing ? (
          <PlanEditor key={editing.id} plan={editing} zones={zones} onClose={() => setOpen(null)} onOpen={setOpen} />
        ) : (
          <Card className="p-4 text-sm text-ink-500">Loading the plan…</Card>
        )
      ) : null}

      {SCOPES.map((scope) => {
        const rows = plans.filter((p) => p.scopeType === scope.key);
        const byPlan = new Map<string, PlanRow[]>();
        for (const r of rows) byPlan.set(r.planKey, [...(byPlan.get(r.planKey) ?? []), r]);
        return (
          <Card key={scope.key} className="p-4" data-testid={`pay-plans-${scope.key.toLowerCase()}`}>
            <h3 className="text-base font-semibold text-ink-900">{scope.title}</h3>
            <p className="mb-2 text-xs text-ink-500">{scope.help}</p>
            {byPlan.size === 0 ? <p className="text-sm text-ink-500">No {scope.title.toLowerCase()} plans.</p> : null}
            <div className="space-y-3">
              {[...byPlan.values()].map((versions) => {
                const sorted = [...versions].sort((a, b) => b.version - a.version);
                const head = sorted.find((v) => v.inForce) ?? sorted[0];
                return (
                  <div key={head.planKey} className="rounded-lg border border-cream-200">
                    <div className="border-b border-cream-100 px-3 py-2">
                      <p className="font-medium text-ink-900">{head.name}</p>
                      <p className="text-xs text-ink-500">{scopeText(head, zones)}</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead className="text-xs text-ink-500">
                          <tr>
                            <th className="px-3 py-1">Version</th>
                            <th className="px-3 py-1">Status</th>
                            <th className="px-3 py-1">Effective from</th>
                            <th className="px-3 py-1" />
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((v) => (
                            <Fragment key={v.id}>
                              <tr className="border-t border-cream-100" data-testid="pay-plan-row">
                                <td className="px-3 py-1.5 tabular-nums">v{v.version}</td>
                                <td className="px-3 py-1.5">
                                  <Badge tone={STATUS_TONE[v.status]}>{v.status.toLowerCase()}</Badge>{" "}
                                  {v.inForce ? <Badge tone="success">in force</Badge> : null}
                                </td>
                                <td className="px-3 py-1.5 text-xs">{formatIstDateTime(v.effectiveFrom)}</td>
                                <td className="px-3 py-1.5 text-right">
                                  <Button size="sm" variant={v.status === "DRAFT" ? "primary" : "secondary"} onClick={() => setOpen(v.id)}>
                                    {v.status === "DRAFT" ? "Edit" : "View"}
                                  </Button>
                                </td>
                              </tr>
                              {v.inForce || v.status === "DRAFT" ? (
                                <tr>
                                  <td colSpan={4} className="px-3 pb-2">
                                    <details className="text-xs text-ink-600">
                                      <summary className="cursor-pointer">The plan in words</summary>
                                      <ul className="mt-1 list-disc pl-5">
                                        {v.words.map((w, i) => (
                                          <li key={i}>{w}</li>
                                        ))}
                                      </ul>
                                    </details>
                                  </td>
                                </tr>
                              ) : null}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </section>
  );
}
