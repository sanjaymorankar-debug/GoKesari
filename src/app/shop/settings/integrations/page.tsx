import { FileSync } from "@/components/integrations/file-sync";
import { IntegrationSettings } from "@/components/integrations/integration-settings";
import { PageHeader } from "@/components/ui";
import { getIntegrationView, listConnectorTokens, providerCatalogue } from "@/server/integrations/connections";
import { isCredentialEncryptionConfigured } from "@/server/integrations/credentials";
import { listItemImports } from "@/server/integrations/file-sync";
import { integrationPageShop } from "@/server/integrations/page-context";

export const metadata = { title: "Accounting software" };
export const dynamic = "force-dynamic";

/** Module 2: Shop settings → Integrations. */
export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { actor, shop } = await integrationPageShop(params.shop);
  const integration = await getIntegrationView(shop.id);
  const tokens = integration?.transport === "CONNECTOR" ? await listConnectorTokens(shop.id) : [];
  const recent = integration?.transport === "FILE" ? await listItemImports(shop.id) : [];
  const zoho = typeof params.zoho === "string" ? { outcome: params.zoho, reason: typeof params.reason === "string" ? params.reason : null } : null;
  // Dates become strings for the client components.
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Accounting software"
        description={`${shop.name} — connect Tally, Odoo, Zoho Books, myBillBook, Vyapar or any software that uses Excel. Delivered orders go to it as invoices; your stock and prices come from it.`}
      />
      <IntegrationSettings
        shopId={shop.id}
        providers={providerCatalogue()}
        integration={integration ? plain(integration) : null}
        tokens={plain(tokens)}
        ready={{ encryption: isCredentialEncryptionConfigured(), zoho: Boolean(process.env.ZOHO_CLIENT_ID && process.env.ZOHO_CLIENT_SECRET) }}
        canManage={actor.via === "OWNER" || actor.role === "ADMIN"}
        zohoOutcome={zoho}
      />
      {integration?.transport === "FILE" ? (
        <FileSync shopId={shop.id} label={integration.label} recent={plain(recent)} waiting={integration.jobs.waiting + integration.jobs.retrying} />
      ) : null}
    </div>
  );
}
