import { JoinForm } from "@/components/registration/join-form";
import { Alert, PageHeader } from "@/components/ui";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Register your shop" };
export const dynamic = "force-dynamic";

/** Module 3: public shop self-registration. */
export default async function JoinPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const open = (await getRule("selfRegistration")).enabled;
  const code = typeof params.code === "string" ? params.code.toUpperCase().slice(0, 32) : "";
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Register your shop" description="Shop name, mobile number, the referral code from your distributor, and the fee. Your shop goes live as soon as the payment is confirmed." />
      {open ? <JoinForm initialCode={code} /> : <Alert tone="info">Self-registration is not open yet. Please contact GoKesari or your distributor.</Alert>}
    </div>
  );
}
