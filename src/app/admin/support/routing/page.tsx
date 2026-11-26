import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { Card, inputClass, PageHeader } from "@/components/ui";
import { ticketCategoryLabel } from "@/lib/support-ticket-states";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { flowF17On, listAssignableStaff } from "@/server/aftercare/support-tickets";
import { addRoutingRule, listRoutingRules, removeRoutingRule, ROUTABLE_CATEGORIES } from "@/server/aftercare/ticket-routing";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Ticket routing" };
export const dynamic = "force-dynamic";

async function manager() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SUPPORT_QUEUE_MANAGE)) redirect("/");
  return user;
}

/**
 * Admin → Support → Routing (docs/flows-v3/wave1.md, F17; flag flow_f17 — 404 while it is off): who receives new
 * tickets automatically, by category and the shop's district. The least-loaded person of the best match gets the
 * ticket; no match leaves it in the manual queue.
 */
export default async function SupportRoutingPage() {
  const user = await manager();
  if (!(await flowF17On())) notFound();
  const [rules, staff, flows] = await Promise.all([listRoutingRules(user), listAssignableStaff(), getRule("supportFlows")]);

  async function add(formData: FormData) {
    "use server";
    const actor = await manager();
    await addRoutingRule(
      {
        category: String(formData.get("category") ?? ""),
        districtCode: String(formData.get("districtCode") ?? "") || null,
        userId: String(formData.get("userId") ?? ""),
      },
      actor,
    );
    revalidatePath("/admin/support/routing");
  }

  async function remove(formData: FormData) {
    "use server";
    const actor = await manager();
    await removeRoutingRule(String(formData.get("id") ?? ""), actor);
    revalidatePath("/admin/support/routing");
  }

  return (
    <>
      <PageHeader
        title="Ticket routing"
        description={`New tickets go to the least-loaded person named here for their category and the shop's district (exact district, then state, then every area). Automatic assignment is ${flows.autoAssign ? "on" : "off"} (rule supportFlows).`}
      />
      <Card className="mb-6 p-5">
        <form action={add} className="grid gap-3 sm:grid-cols-4" data-testid="routing-form">
          <select name="category" className={inputClass} required defaultValue="">
            <option value="">Category</option>
            {ROUTABLE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ticketCategoryLabel(c)}
              </option>
            ))}
          </select>
          <input name="districtCode" className={inputClass} placeholder="District (e.g. MH-PUN) — empty = all" maxLength={20} />
          <select name="userId" className={inputClass} required defaultValue="">
            <option value="">Assign to</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button type="submit" className="min-h-11 rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800">
            Add rule
          </button>
        </form>
      </Card>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="routing-rules">
          <thead className="bg-cream-50 text-left text-xs text-ink-500">
            <tr>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2">Area</th>
              <th className="px-3 py-2">Assign to</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-cream-100">
            {rules.length === 0 ? (
              <tr>
                <td className="px-3 py-4 text-ink-500" colSpan={5}>
                  No rules yet: every new ticket waits in the manual queue.
                </td>
              </tr>
            ) : (
              rules.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">{ticketCategoryLabel(r.category)}</td>
                  <td className="px-3 py-2">{r.districtCode ?? "Every area"}</td>
                  <td className="px-3 py-2">{r.userLabel}</td>
                  <td className="px-3 py-2">{r.active ? "Active" : "Off"}</td>
                  <td className="px-3 py-2 text-right">
                    {r.active ? (
                      <form action={remove}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" className="min-h-11 text-sm font-semibold text-red-700 underline">
                          Switch off
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
