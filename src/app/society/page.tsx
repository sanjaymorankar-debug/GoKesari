import Link from "next/link";
import { redirect } from "next/navigation";

import { JoinSocietyForm, MemberActions, RegisterSocietyForm } from "@/components/society-actions";
import { Card, PageHeader, Section, StatusBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listMySocieties } from "@/server/services/societies";

export const metadata = { title: "My Society" };
export const dynamic = "force-dynamic";

/**
 * Society home for any signed-in user: memberships (with a link to the
 * dashboard for society admins/operators), join a verified society, or
 * register a new one.
 */
export default async function SocietyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const memberships = await listMySocieties(user.id);

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="My Society"
        description="Join your housing society for gate-friendly deliveries by riders your society trusts."
      />

      <Section title="Your societies">
        {memberships.length === 0 ? (
          <p className="text-sm text-ink-500">You are not in a society yet.</p>
        ) : (
          <Card className="divide-y divide-cream-100">
            {memberships.map(({ membership, society }) => (
              <div key={membership.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <p className="font-medium text-ink-900">{society.name}</p>
                  <p className="text-xs text-ink-500">
                    {membership.role.toLowerCase()}
                    {membership.unitLabel ? ` · ${membership.unitLabel}` : ""} · society {society.status.toLowerCase()}
                  </p>
                </div>
                <span className="flex items-center gap-2">
                  <StatusBadge status={membership.status} />
                  {membership.status === "ACTIVE" && membership.role !== "RESIDENT" ? (
                    <Link href={`/society/${society.id}`} className="text-sm font-medium text-kesari-700 underline">
                      Manage
                    </Link>
                  ) : null}
                  {membership.status === "ACTIVE" && membership.role === "RESIDENT" ? (
                    <>
                      <Link href="/profile/addresses" className="text-xs text-kesari-700 underline">
                        Link my address
                      </Link>
                      <MemberActions memberId={membership.id} status={membership.status} role={membership.role} canSetRole={false} />
                    </>
                  ) : null}
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title="Join a society">
        <Card className="p-4">
          <JoinSocietyForm />
        </Card>
      </Section>

      <Section title="Register your society">
        <Card className="p-4">
          <p className="mb-3 text-sm text-ink-500">
            You become its admin. Our team verifies the society before residents can join.
          </p>
          <RegisterSocietyForm />
        </Card>
      </Section>
    </div>
  );
}
