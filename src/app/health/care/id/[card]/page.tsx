import { PageHeader } from "@/components/ui";
import { publicIdCard } from "@/server/health/care";

export const metadata = { title: "Check a GoKesari care provider ID" };
export const dynamic = "force-dynamic";

/** Public page behind the QR on a home-care provider's ID card: name, photo and verified status only. */
export default async function CareIdCheckPage({ params }: { params: Promise<{ card: string }> }) {
  const { card } = await params;
  const id = await publicIdCard(decodeURIComponent(card).slice(0, 40)).catch(() => null);
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Care provider ID check" />
      {!id ? (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 text-red-900" data-testid="care-id-check">
          <p className="text-lg font-extrabold">Not a GoKesari ID</p>
          <p className="text-sm">No GoKesari care provider has this ID number. Do not let the person in; call GoKesari support.</p>
        </div>
      ) : (
        <div className={`rounded-2xl border-2 p-4 ${id.verified ? "border-leaf-300 bg-leaf-50" : "border-amber-300 bg-amber-50"}`} data-testid="care-id-check">
          <div className="flex items-center gap-4">
            {id.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- provider photo URL from the practice's setup
              <img src={id.photoUrl} alt={`Photo of ${id.name}`} className="h-24 w-24 rounded-full border-2 border-white object-cover" />
            ) : (
              <span className="inline-flex h-24 w-24 items-center justify-center rounded-full bg-white text-3xl font-extrabold">{id.name.slice(0, 1)}</span>
            )}
            <div>
              <p className="text-xl font-extrabold text-ink-900">{id.name}</p>
              <p className="font-mono text-sm">{id.idCardNumber}</p>
              <p className={`mt-1 text-sm font-extrabold ${id.verified ? "text-leaf-700" : "text-amber-800"}`}>{id.verified ? "✓ Verified by GoKesari" : "Not verified — do not proceed"}</p>
              {id.verified && id.policeVerified ? <p className="text-xs font-bold text-leaf-700">✓ Police verified</p> : null}
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-600">Check that the face matches the person at your door.</p>
        </div>
      )}
    </div>
  );
}
