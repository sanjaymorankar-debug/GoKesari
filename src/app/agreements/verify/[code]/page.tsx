import { notFound } from "next/navigation";

import { AgreementVerifyFile } from "@/components/agreements/agreement-verify-file";
import { Card } from "@/components/ui";
import { verifyCodeSummary } from "@/server/legal-agreements/admin";

export const metadata = { title: "Verify a signed agreement", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const LANG: Record<string, string> = { en: "English", mr: "मराठी", hi: "हिंदी" };

/** Public verification of a signed gokesari.com agreement (docs/seller-agreements-2026-11). */
export default async function VerifyAgreementPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const summary = await verifyCodeSummary(code).catch(() => null);
  if (!summary) notFound();
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold text-ink-900">Signed agreement {summary.code}</h1>
      <Card className="space-y-1 text-sm">
        <p><strong>{summary.document}</strong> – version {summary.version}</p>
        <p>Shop: {summary.shopName}</p>
        <p>Signed by {summary.signerName} on {summary.signedAtIst}, accepted electronically with an OTP to the registered mobile.</p>
      </Card>
      <Card className="space-y-2 text-sm">
        <h2 className="font-semibold text-ink-900">Recorded SHA-256 fingerprints</h2>
        <ul className="space-y-1">
          {summary.hashes.map((h) => (
            <li key={`${h.language}-${h.kind}`}>
              {LANG[h.language] ?? h.language} – {h.kind === "CERTIFIED" ? "signed copy with certificate" : "signed agreement (without the certificate page)"}:
              <code className="block break-all text-xs">{h.sha256}</code>
            </li>
          ))}
        </ul>
      </Card>
      <AgreementVerifyFile code={summary.code} />
    </main>
  );
}
