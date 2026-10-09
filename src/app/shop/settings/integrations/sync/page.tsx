import { SyncLog } from "@/components/integrations/sync-log";
import { LinkButton, PageHeader } from "@/components/ui";
import { describeError } from "@/server/integrations/errors";
import { listJobs, listSyncLog } from "@/server/integrations/jobs";
import { integrationPageShop } from "@/server/integrations/page-context";

export const metadata = { title: "Sync log" };
export const dynamic = "force-dynamic";

/** Module 2: what was sent and read, what failed and how to fix it. */
export default async function SyncPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { actor, shop } = await integrationPageShop(params.shop);
  const [jobs, log] = await Promise.all([listJobs(shop.id, { status: ["DEAD", "FAILED", "PENDING", "CLAIMED"], limit: 200 }), listSyncLog(shop.id, 100)]);
  const rows = jobs.map((j) => ({
    id: j.id,
    kind: j.kind,
    status: j.status,
    number: (j.payload.number as string | undefined) ?? ((j.payload.document as { number?: string } | undefined)?.number ?? null),
    attempts: j.attempts,
    nextAttemptAt: j.nextAttemptAt.toISOString(),
    externalRef: j.externalRef,
    error: j.errorCode ? { code: j.errorCode, message: j.errorMessage ?? describeError(j.errorCode).message, fix: describeError(j.errorCode).fix } : null,
    errorDetail: actor.via === "SUPPORT" ? j.errorDetail : null,
    createdAt: j.createdAt.toISOString(),
  }));
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Sync log"
        description={`${shop.name} — invoices and credit notes sent to your software, items read from it, and anything that needs you.`}
        action={<LinkButton href={`/shop/settings/integrations?shop=${shop.id}`} variant="secondary">Back</LinkButton>}
      />
      <SyncLog shopId={shop.id} jobs={rows} log={JSON.parse(JSON.stringify(log.map((l) => ({ id: l.id, level: l.level, message: l.message, createdAt: l.createdAt }))))} />
    </div>
  );
}
