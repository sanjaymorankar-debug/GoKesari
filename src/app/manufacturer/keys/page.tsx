import { redirect } from "next/navigation";

import { ApiKeys } from "@/components/batch-d/api-keys";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { listApiKeys, manufacturerAccountsForUser } from "@/server/pmd/manufacturers";

export const metadata = { title: "API keys" };
export const dynamic = "force-dynamic";

export default async function ManufacturerKeysPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  const [account] = await manufacturerAccountsForUser(user.id);
  if (!account) redirect("/manufacturer");
  const keys = await listApiKeys(account.id);
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4">
      <PageHeader title="API keys" description={`${account.name} — for POST /api/pmd/v1/manufacturer/products. A key is shown once; revoke it at once if it leaks.`} />
      <ApiKeys keys={JSON.parse(JSON.stringify(keys))} />
    </div>
  );
}
