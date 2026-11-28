import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { DealerAdminDetail } from "@/components/dealer/dealer-admin-detail";
import { DealerCommissionRates } from "@/components/dealer/dealer-commission-rates";
import { PromotionConfirmations } from "@/components/dealer/promotion-confirmations";
import { isShopOwnerPromotion, pendingPromotionFor, PROMOTION_CONFIRMER_ROLES } from "@/server/dealers/promotion";
import { SuperFranchiseeAdmin } from "@/components/dealer/super-franchisee-admin";
import { SchemeTermsPanel } from "@/components/dealer/scheme-terms";
import { Badge, Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { isDealerStaff } from "@/server/dealers/staff-access";
import { getCommissionSettings, ratingView } from "@/server/dealers/commission";
import { eq } from "drizzle-orm";
import { db } from "@/server/db";
import { dealerSchemeVersions } from "@/server/db/schema";
import { dealerCustomFilesFor, reportableAnswers } from "@/server/dealers/custom-fields";
import { dealerSchemeHistory } from "@/server/dealers/schemes";
import { superFranchiseeView } from "@/server/dealers/super-franchisee";
import { dealerAccountEmail, dealerView, getDealer, listSalespeople } from "@/server/dealers/service";
import { isFeatureEnabled } from "@/server/services/feature-flags";

export const metadata = { title: "Dealer" };
export const dynamic = "force-dynamic";

/**
 * One dealer for staff (docs/dealer-programme, GKS-DR-002/003/004): details
 * masked, documents, codes, employees. Admin: review documents, reveal PAN /
 * account (audited), approve / reject / suspend / reactivate / terminate,
 * replace a code. Operator: reads only.
 */
export default async function AdminDealerPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isFeatureEnabled("dealer_programme_enabled"))) notFound();
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!isDealerStaff(user.role)) redirect("/");
  const id = z.string().uuid().safeParse((await params).id);
  if (!id.success) notFound();
  const dealer = await getDealer(id.data).catch(() => null);
  if (!dealer) notFound();
  const [view, email, employees, rating, settings, ratingOn, schemes] = await Promise.all([
    dealerView(dealer),
    dealerAccountEmail(dealer),
    listSalespeople(dealer.id),
    dealer.status === "DRAFT" || dealer.status === "PENDING" || dealer.isInternal ? Promise.resolve(null) : ratingView(dealer.id),
    getCommissionSettings(),
    isFeatureEnabled("dealer_rating_bonus_enabled"),
    dealerSchemeHistory(dealer.id),
  ]);
  const scheme = schemes.find((h) => h.status === "ACTIVE") ?? null;
  // Owner, 28-Nov-2026: a shop owner's promotion is approved by one admin and confirmed by a different admin / operator.
  const [promotion, pendingPromotion] = dealer.status === "PENDING" ? await Promise.all([isShopOwnerPromotion(dealer), pendingPromotionFor(dealer.id)]) : [false, null];
  // 0226 super franchisee: his team, or the team he is in (not for GoKesari's own dealer account).
  const superView = dealer.isInternal ? null : await superFranchiseeView(dealer.id);
  // Phase 5: his answers to the scheme's own questions (fields marked for reports).
  // An applicant's answers belong to the scheme he applied for (his assignment changes only on approval).
  const [requested] = dealer.requestedVersionId && ["DRAFT", "PENDING", "REJECTED"].includes(dealer.status) ? await db.select({ terms: dealerSchemeVersions.terms }).from(dealerSchemeVersions).where(eq(dealerSchemeVersions.id, dealer.requestedVersionId)) : [];
  const answerTerms = requested?.terms ?? scheme?.terms ?? null;
  const answers = answerTerms ? reportableAnswers(answerTerms, dealer.customValues ?? {}, await dealerCustomFilesFor(dealer.id)) : [];

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/admin/dealers" className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-kesari-800 hover:underline">
        ← Dealers
      </Link>
      <PageHeader title={dealer.legalName} description={`${dealer.contactName}${email ? ` · ${email}` : ""}`} />
      {pendingPromotion ? (
        <PromotionConfirmations items={[pendingPromotion]} viewerId={user.id} canDecide={PROMOTION_CONFIRMER_ROLES.includes(user.role)} showDealerLink={false} />
      ) : null}
      <DealerAdminDetail
        isAdmin={user.role === "ADMIN"}
        operatorMayDecide={user.role === "OPERATOR" && promotion}
        promotion={{ fourEye: promotion, pending: !!pendingPromotion }}
        dealer={JSON.parse(JSON.stringify(view))}
        employees={JSON.parse(JSON.stringify(employees))}
        today={new Date().toISOString().slice(0, 10)}
        rating={rating ? JSON.parse(JSON.stringify(rating)) : null}
      />
      {dealer.isInternal ? null : (
        <Card className="mt-4 p-4" data-testid="dealer-scheme">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-ink-900">Scheme</h2>
            {scheme ? (
              <>
                <Badge tone="info">{scheme.schemeName}</Badge>
                <span className="text-sm text-ink-600">
                  version {scheme.version}
                  {scheme.versionLabel ? ` · ${scheme.versionLabel}` : ""} · since {formatIstDate(scheme.startsAt)}
                </span>
              </>
            ) : (
              <span className="text-sm text-ink-600">No scheme recorded.</span>
            )}
          </div>
          {scheme ? <div className="mt-2"><SchemeTermsPanel terms={scheme.terms} /></div> : null}
          {answers.length ? (
            <p className="mt-3 text-sm font-semibold text-ink-900">Answers to the scheme&apos;s questions</p>
          ) : null}
          {answers.length ? (
            <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]" data-testid="dealer-scheme-answers">
              {answers.map((a) => (
                <div key={a.label} className="contents">
                  <dt className="font-semibold text-ink-900">{a.label}</dt>
                  <dd className="break-words">{a.fileId ? <a className="underline" href={`/api/dealer/custom-files/${a.fileId}`}>{a.value}</a> : a.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {schemes.length > 1 ? (
            <details className="mt-3 text-sm">
              <summary className="min-h-11 cursor-pointer font-semibold text-kesari-800">Scheme history ({schemes.length})</summary>
              <ul className="mt-1 space-y-1">
                {schemes.map((h) => (
                  <li key={h.assignmentId}>
                    {h.schemeName} v{h.version} — {formatIstDate(h.startsAt)}
                    {h.endsAt ? ` to ${formatIstDate(h.endsAt)}` : " (current)"}
                    {h.endReason ? ` · ${h.endReason}` : h.reason ? ` · ${h.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
      )}
      {dealer.isInternal ? null : (
        <div className="mt-4">
          <DealerCommissionRates
            dealerId={dealer.id}
            isAdmin={user.role === "ADMIN"}
            model={settings.commissionModel}
            ownBasePercentBp={dealer.commissionPercentBp}
            ownRatingStepBp={dealer.ratingStepBp}
            defaults={{ basePercentBp: settings.basePercentBp, ratingStepBp: settings.ratingStepBp }}
            rating={Number(dealer.rating)}
            ratingOn={ratingOn}
          />
        </div>
      )}
      {superView ? (
        <div className="mt-4">
          <SuperFranchiseeAdmin dealerId={dealer.id} dealerName={dealer.legalName} isAdmin={user.role === "ADMIN"} view={superView} />
        </div>
      ) : null}
    </div>
  );
}

function formatIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
}
