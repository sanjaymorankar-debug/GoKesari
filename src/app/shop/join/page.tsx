import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Module 3's self-registration form used to live here. Since the owner's brief of 30 Oct 2026 there
 * is a single registration, /shop/register, so this address only forwards there — keeping the
 * referral code of a distributor's (?code=) or dealer's (?ref=) link. A registration already
 * started here is still followed on its private page, /shop/join/{token}.
 */
export default async function JoinPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const given = typeof params.code === "string" ? params.code : typeof params.ref === "string" ? params.ref : "";
  const code = given.toUpperCase().slice(0, 32);
  redirect(code ? `/shop/register?ref=${encodeURIComponent(code)}` : "/shop/register");
}
