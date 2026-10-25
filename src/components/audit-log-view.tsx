import { Badge, Card, EmptyState } from "@/components/ui";

export interface AuditLogRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  previousValue: unknown;
  newValue: unknown;
  createdAt: string;
}

/**
 * Audit log viewer (§11, §19).
 *
 * Old and new values are rendered as compact JSON rather than prose: the point
 * of an audit trail is to show exactly what was recorded, not a paraphrase.
 */
export function AuditLogView({
  rows,
  limited = false,
}: {
  rows: AuditLogRow[];
  /** True for an operator, whose view is scoped to operational actions (§17). */
  limited?: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyState title="No audit entries yet." />;
  }

  return (
    <div className="space-y-2">
      {limited ? (
        <p className="text-xs text-ink-500">
          Showing operational entries. Full audit history is available to
          administrators.
        </p>
      ) : null}

      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="bg-cream-100 text-xs uppercase text-ink-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Who</th>
              <th className="px-4 py-2">Action</th>
              <th className="px-4 py-2">Entity</th>
              <th className="px-4 py-2">Before → After</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-200">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="whitespace-nowrap px-4 py-2 text-ink-500">
                  {new Date(row.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                </td>
                <td className="px-4 py-2">
                  <span className="text-ink-900">
                    {row.actorName ?? row.actorEmail ?? "System"}
                  </span>
                  {row.actorRole ? (
                    <p className="text-xs text-ink-500">{row.actorRole}</p>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <Badge>{row.action}</Badge>
                </td>
                <td className="px-4 py-2 text-ink-500">
                  {row.entityType}
                  {row.entityId ? (
                    <span className="block text-xs">
                      {row.entityId.slice(0, 8)}
                    </span>
                  ) : null}
                </td>
                <td className="max-w-md px-4 py-2 text-xs text-ink-600">
                  {row.previousValue ? (
                    <code className="block break-all text-ink-500">
                      {JSON.stringify(row.previousValue)}
                    </code>
                  ) : null}
                  {row.newValue ? (
                    <code className="block break-all">
                      {JSON.stringify(row.newValue)}
                    </code>
                  ) : null}
                  {!row.previousValue && !row.newValue ? "—" : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
