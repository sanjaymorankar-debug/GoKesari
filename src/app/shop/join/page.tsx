import { JoinForm } from "@/components/registration/join-form";
import { Alert, PageHeader } from "@/components/ui";
import { isReferralRequired } from "@/server/services/referral-settings";
import { getRule } from "@/server/services/settings";

export const metadata = { title: "Register your shop" };
export const dynamic = "force-dynamic";

/** Module 3: public shop self-registration. */
export default async function JoinPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const open = (await getRule("selfRegistration")).enabled;
  // docs/nearby-referral-2026-10: Mandatory / Optional by the admin's setting, read live.
  const referralRequired = await isReferralRequired("shop");
  // ?code= (distributors' links) or ?ref= (dealer share links, docs/dealer-programme).
  const given = typeof params.code === "string" ? params.code : typeof params.ref === "string" ? params.ref : "";
  const code = given.toUpperCase().slice(0, 32);
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title="Register your shop" description={`Shop name, mobile number, ${referralRequired ? "the referral code from your distributor" : "a referral code if you have one"}, and the fee. Your shop goes live as soon as the payment is confirmed.`} />
      {open ? <JoinForm initialCode={code} referralRequired={referralRequired} /> : <Alert tone="info">Self-registration is not open yet. Please contact GoKesari or your distributor.</Alert>}
    </div>
  );
}
