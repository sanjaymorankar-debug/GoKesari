import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/ui";
import { ScanCapture } from "@/components/smart-list/scan-capture";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { activeAiProvider } from "@/server/ai/provider";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Scan my shopping list" };
export const dynamic = "force-dynamic";

/** docs/smart-shopping-2026-11 (Feature 1): photo of a written list → AI reads it → editable wishlist. */
export default async function ScanListPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/wishlist/scan");
  if (!(await isFeatureEnabled("smart_list_scan_enabled"))) notFound();
  const [lang, rule, ai] = await Promise.all([getBoardLang(), getRule("smartShopping"), activeAiProvider()]);
  return (
    <>
      <PageHeader
        title="Scan my shopping list"
        description="Take a photo of your handwritten or printed list — Marathi, Hindi, English, Gujarati and more. We read it, you check it, then compare prices at shops near you."
      />
      {ai ? (
        <ScanCapture lang={lang} maxPages={rule.maxPagesPerScan} lowConfidenceBelow={rule.lowConfidenceBelow} />
      ) : (
        <p className="rounded-xl bg-amber-50 p-4 text-amber-900" data-testid="scan-unavailable">
          Reading photos is not available right now. Please try again later.
        </p>
      )}
      <p className="mt-6 text-xs text-ink-500">
        Your list photos are stored privately and deleted automatically after {rule.photoRetentionDays} days. They are read by an AI service only to make your list.
      </p>
    </>
  );
}
