import { AgreementsSigner } from "@/components/agreements/agreements-signer";

export const metadata = { title: "Sign your shop agreements", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Owner signing link (docs/seller-agreements-2026-11): sent when staff or a dealer registered the shop. The
 * owner reviews their own personalised documents and signs with the code sent to their registered mobile.
 */
export default async function SignAgreementsByLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <h1 className="text-xl font-semibold text-ink-900">Your gokesari.com agreements</h1>
      <p className="text-sm text-ink-600">Read each document to the end, tick it, then sign with the code sent to your registered mobile.</p>
      <AgreementsSigner apiBase={`/api/agreements/link/${encodeURIComponent(token)}`} />
    </main>
  );
}
