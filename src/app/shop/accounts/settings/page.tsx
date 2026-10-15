import Link from "next/link";

import { AccountsHeader, AccountsNav } from "@/components/accounts/accounts-nav";
import { AccountsSettingsForm } from "@/components/accounts/settings-form";
import { Badge } from "@/components/ui";
import { tr } from "@/lib/board/i18n";
import { ACCOUNTS_TILES } from "@/lib/accounts/menu";
import { getSettings } from "@/server/accounts/books";
import { storageDescription } from "@/server/accounts/files";
import { getPortalLink, providerSummary } from "@/server/accounts/gst";
import { billEmailAddress } from "@/server/accounts/inbound";
import { loadAccountsPage } from "@/server/accounts/page";

export const metadata = { title: "Accounts settings" };
export const dynamic = "force-dynamic";

/** docs/inventory-accounting-2026-10: the module's settings and how bills reach it. */
export default async function AccountsSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { shop, lang, shopQuery } = await loadAccountsPage(params);
  const tile = ACCOUNTS_TILES.find((t) => t.key === "settings")!;
  const [settings, link] = await Promise.all([getSettings(shop.id), getPortalLink(shop.id)]);
  const email = billEmailAddress(shop.id);
  const storage = storageDescription();
  const provider = providerSummary();

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AccountsNav lang={lang} current="settings" shopQuery={shopQuery} />
      <AccountsHeader title={tr(tile.label, lang)} subtitle={`${shop.name} · ${tr(tile.hint, lang)}`} />

      <div className="grid gap-3 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="settings-books" className="rounded-2xl border border-[var(--gk-line)] bg-white p-3 sm:p-4">
          <h2 id="settings-books" className="mb-3 text-base font-bold text-ink-900">
            Books and GST
          </h2>
          <AccountsSettingsForm
            shopId={shop.id}
            initial={{
              valuationMethod: settings.valuationMethod,
              purchaseChannel: settings.purchaseChannel,
              filingFrequency: settings.filingFrequency,
              salesInvoicePrefix: settings.salesInvoicePrefix,
              reminderDaysBefore: settings.reminderDaysBefore,
              expiryAlertDays: settings.expiryAlertDays,
            }}
          />
        </section>

        <aside className="space-y-3 text-sm">
          <section aria-labelledby="settings-email" className="rounded-2xl bg-kesari-50 p-3 ring-1 ring-[var(--gk-line)]">
            <h2 id="settings-email" className="mb-1 text-base font-bold text-ink-900">
              Forward bills by email
            </h2>
            {email ? (
              <>
                <p className="text-ink-700">Forward a supplier&apos;s email with the bill attached (PDF, photo, Excel or e-invoice JSON) to:</p>
                <p className="my-1.5 select-all break-all rounded-lg bg-white px-2 py-1.5 font-mono text-sm text-ink-900" data-testid="bill-email">
                  {email}
                </p>
                <p className="text-xs text-ink-600">It is read and waits under &quot;To check&quot;. Keep this address private — anything sent to it lands in your books for review.</p>
              </>
            ) : (
              <p className="text-ink-700">
                Not set up yet: needs <code className="font-mono text-xs">INBOUND_EMAIL_SECRET</code> and <code className="font-mono text-xs">INBOUND_EMAIL_DOMAIN</code> on the server.
              </p>
            )}
          </section>

          <section aria-labelledby="settings-share" className="rounded-2xl bg-teal-50 p-3 ring-1 ring-[var(--gk-line)]">
            <h2 id="settings-share" className="mb-1 text-base font-bold text-ink-900">
              Bills from WhatsApp
            </h2>
            <ol className="list-decimal space-y-0.5 pl-5 text-ink-700">
              <li>Install GoKesari on your phone (open the site in Chrome → menu → &quot;Install app&quot; / &quot;Add to Home screen&quot;).</li>
              <li>
                In WhatsApp, long-press the bill (photo or PDF) → <strong>Share</strong> → <strong>GoKesari</strong>.
              </li>
              <li>
                Not installed? Save the file to your phone, then{" "}
                <Link href={`/shop/accounts/capture${shopQuery}`} className="font-semibold text-kesari-700 underline">
                  upload it here
                </Link>
                .
              </li>
            </ol>
          </section>

          <section aria-labelledby="settings-storage" className="rounded-2xl border border-[var(--gk-line)] bg-white p-3">
            <h2 id="settings-storage" className="mb-1 text-base font-bold text-ink-900">
              Where your files are kept
            </h2>
            <p className="text-ink-700">
              Bills and portal files are stored in <strong>{storage}</strong>, private to your shop, and kept with your books.
            </p>
          </section>

          <section aria-labelledby="settings-gst" className="rounded-2xl bg-violet-50 p-3 ring-1 ring-[var(--gk-line)]">
            <h2 id="settings-gst" className="mb-1 text-base font-bold text-ink-900">
              GST portal connection
            </h2>
            <p className="flex flex-wrap items-center gap-1.5 text-ink-700">
              Portal API:{" "}
              {provider.apiAvailable ? <Badge tone="success">On{provider.provider ? ` · ${provider.provider}` : ""}</Badge> : <Badge>Not switched on — upload files from gst.gov.in</Badge>}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-ink-700">
              Your GSTIN:{" "}
              {link ? (
                <Badge tone={link.status === "LINKED" ? "success" : link.status === "OTP_SENT" ? "warning" : "neutral"}>
                  {link.gstin} · {link.status.replace(/_/g, " ").toLowerCase()}
                </Badge>
              ) : (
                <Badge>{shop.gstin ? `${shop.gstin} · not linked` : "no GSTIN on the shop profile"}</Badge>
              )}
            </p>
            <Link href={`/shop/accounts/gst${shopQuery}#gst-link`} className="mt-1.5 inline-flex min-h-10 items-center font-semibold text-violet-800 underline">
              Manage on the GST page
            </Link>
          </section>
        </aside>
      </div>
    </div>
  );
}
