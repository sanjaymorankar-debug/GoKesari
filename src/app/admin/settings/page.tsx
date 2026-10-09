import Link from "next/link";
import { redirect } from "next/navigation";

import { Pager, paginate } from "@/components/board/list-tabs";
import { PlatformSettingsEditor } from "@/components/platform-settings-editor";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getBoardLang } from "@/server/board-lang";
import { getCurrentUser } from "@/server/authz/guards";
import { listRules } from "@/server/services/settings";

export const metadata = { title: "Business rules" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 8;

/**
 * Every configurable business rule with its default and current value (admin only).
 * A searchable list, one line per rule; choosing a rule opens just its editor, so
 * neither view runs past one screen (it used to stack every editor: 35 phone screens).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ rule?: string; q?: string; page?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN") redirect("/");
  const [rules, query, lang] = await Promise.all([listRules(), searchParams, getBoardLang()]);
  const q = (query.q ?? "").trim().toLowerCase();
  const chosen = rules.find((r) => r.key === query.rule);

  if (chosen) {
    return (
      <div className="mx-auto max-w-3xl">
        <Link href={`/admin/settings${q ? `?q=${encodeURIComponent(q)}` : ""}`} className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
          ← All business rules
        </Link>
        <PlatformSettingsEditor
          rules={[{ key: chosen.key, description: chosen.description, defaults: chosen.defaults, value: chosen.value, overridden: chosen.overridden }]}
        />
      </div>
    );
  }

  const matching = q ? rules.filter((r) => `${r.key} ${r.description}`.toLowerCase().includes(q)) : rules;
  const page = paginate(matching, query.page, PAGE_SIZE);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Business rules"
        description="Limits, retries, policies and windows adjustable without a release. Changes are validated, take effect within seconds and are audited."
      />
      <form className="mb-3 flex gap-2" role="search">
        <input
          type="search"
          name="q"
          defaultValue={query.q ?? ""}
          placeholder="Find a rule (e.g. returns, OTP, wallet)"
          aria-label="Find a rule"
          className="min-h-11 min-w-0 flex-1 rounded-lg border border-cream-200 px-3 text-base focus:border-kesari-500 focus:outline-none"
        />
        <button type="submit" className="min-h-11 rounded-lg bg-kesari-700 px-4 text-sm font-bold text-white hover:bg-kesari-800">
          Find
        </button>
      </form>
      <Card className="divide-y divide-cream-200" data-testid="rule-list">
        {page.rows.length === 0 ? <p className="p-4 text-sm text-ink-600">No rule matches “{query.q}”.</p> : null}
        {page.rows.map((r) => (
          <Link
            key={r.key}
            href={`/admin/settings?rule=${encodeURIComponent(r.key)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
            className="flex min-h-12 items-center justify-between gap-3 px-4 py-2 hover:bg-kesari-50"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-ink-900">{r.key}</span>
              <span className="block truncate text-xs text-ink-600">{r.description}</span>
            </span>
            {r.overridden ? <Badge tone="warning">customised</Badge> : <Badge>default</Badge>}
          </Link>
        ))}
      </Card>
      <Pager
        lang={lang}
        page={page.page}
        pageCount={page.pageCount}
        hrefFor={(p) => `/admin/settings?${q ? `q=${encodeURIComponent(q)}&` : ""}page=${p}`}
      />
    </div>
  );
}
