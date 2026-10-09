import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { count, eq, sql } from "drizzle-orm";

import { AuditLogView } from "@/components/audit-log-view";
import { ComplianceDashboard } from "@/components/compliance-dashboard";
import { DeliveryEarningsConfigManager } from "@/components/delivery-earnings-config-manager";
import { DeliveryPartnerQueue } from "@/components/delivery-partner-queue";
import { GrievanceManager } from "@/components/grievance-manager";
import { GstPanVerificationQueue } from "@/components/gst-pan-verification-queue";
import { MapsUsagePanel } from "@/components/maps-usage-panel";
import { PendingPriceApprovals } from "@/components/pending-price-approvals";
import { ProductApprovalQueue } from "@/components/product-approval-queue";
import { ReferralManager } from "@/components/referral-manager";
import { RegistrationFeeManager } from "@/components/registration-fee-manager";
import { ReleaseMobileForm } from "@/components/release-mobile-form";
import { ShopApprovalPanel } from "@/components/shop-approval-panel";
import { ShopComplianceManager } from "@/components/shop-compliance-manager";
import { ShopFinanceManager } from "@/components/shop-finance-manager";
import { Card, PageHeader, Section } from "@/components/ui";
import { UserRoleManager } from "@/components/user-role-manager";
import { VoucherManager } from "@/components/voucher-manager";
import { VoucherUpload } from "@/components/voucher-upload";
import { formatPaiseCompact } from "@/lib/money";
import { shopTypeLabel } from "@/lib/shop-types";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS, type Permission } from "@/server/authz/permissions";
import { db } from "@/server/db";
import { orders, shops, users, wallets } from "@/server/db/schema";
import { listAuditLog } from "@/server/services/audit-log-query";
import { listPendingProductApprovals } from "@/server/services/catalogue";
import { getComplianceChecklist } from "@/server/services/compliance";
import { getActiveEarningsConfig } from "@/server/services/delivery-earnings";
import { countDeliveryPartnersByStatus, listDeliveryPartners } from "@/server/services/delivery-partners";
import { getGrievanceDashboard, listGrievances } from "@/server/services/grievances";
import { getMaskedPan, listPendingGstPanVerifications } from "@/server/services/gst-pan-verification";
import { getMapsUsageSummary } from "@/server/services/maps-usage";
import { listAllPending } from "@/server/services/price-requests";
import { getReferralPerformance, listReferralCodes } from "@/server/services/referrals";
import { getActiveFee, listFeeHistory } from "@/server/services/registration-fees";
import { listRolesForUsers } from "@/server/services/roles";
import { getRegistrationFeeReport } from "@/server/services/shop-payments";
import { countShopsByLifecycle, getShopOnboarding, type ShopOnboarding } from "@/server/services/shop-onboarding";
import { getRule } from "@/server/services/settings";
import { listShopsByStatus, searchShopsAdmin } from "@/server/services/shops";
import { countSubscriptionsByStatus } from "@/server/services/subscriptions";
import { listUsers } from "@/server/services/users";
import { getVoucherDashboard, listVouchers } from "@/server/services/vouchers";

export const dynamic = "force-dynamic";

/**
 * The sections of the old one-page admin and operator console, each on its
 * own page (Tile Board: no page longer than one screen of menus, and each
 * page loads only its own data). Same components, same data, same checks as
 * before — an operator is refused a section exactly where the console used
 * not to render it.
 */
const SECTIONS = {
  shops: { title: "Shop approvals", needs: [] },
  overview: { title: "Key figures", needs: [] },
  compliance: {
    title: "Compliance, GST & PAN",
    needs: [PERMISSIONS.COMPLIANCE_DASHBOARD_VIEW, PERMISSIONS.SHOP_COMPLIANCE_MANAGE, PERMISSIONS.SHOP_GST_PAN_VERIFY],
  },
  maps: { title: "Maps & location usage", needs: [PERMISSIONS.MAPS_USAGE_VIEW] },
  riders: { title: "Delivery partners", needs: [PERMISSIONS.DELIVERY_PARTNER_MANAGE] },
  grievances: { title: "Grievances", needs: [PERMISSIONS.GRIEVANCE_MANAGE] },
  "price-approvals": { title: "Price approvals", needs: [PERMISSIONS.PRICE_REQUEST_DECIDE_ANY] },
  "product-approvals": { title: "Products awaiting publication", needs: [PERMISSIONS.PRODUCT_APPROVE] },
  "registration-fees": { title: "Registration fees & payments", needs: [] },
  "referral-codes": { title: "Referral codes", needs: [PERMISSIONS.REFERRAL_MANAGE] },
  users: { title: "Users", needs: [PERMISSIONS.USER_VIEW_ANY] },
  vouchers: { title: "Vouchers", needs: [PERMISSIONS.VOUCHER_VIEW] },
  "audit-log": { title: "Audit log", needs: [PERMISSIONS.AUDIT_LOG_VIEW, PERMISSIONS.AUDIT_LOG_VIEW_LIMITED] },
} satisfies Record<string, { title: string; needs: Permission[] }>;

type SectionKey = keyof typeof SECTIONS;

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  return { title: SECTIONS[section as SectionKey]?.title ?? "Admin" };
}

export default async function AdminConsoleSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ role?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.role !== "ADMIN" && user.role !== "OPERATOR") redirect("/");
  const { section } = await params;
  if (!(section in SECTIONS)) notFound();
  const key = section as SectionKey;
  const needs: readonly Permission[] = SECTIONS[key].needs;
  if (needs.length > 0 && !needs.some((p) => can(user.role, p))) redirect("/admin");

  const header = <PageHeader title={SECTIONS[key].title} />;

  switch (key) {
    case "shops": {
      const [pending, approved, statusModelsRule] = await Promise.all([
        listShopsByStatus("PENDING_APPROVAL"),
        searchShopsAdmin({ status: "APPROVED", limit: 100 }).then((rows) => rows.sort((a, b) => a.name.localeCompare(b.name))),
        getRule("statusModels"),
      ]);
      const onboarding = await getShopOnboarding(pending.map((s) => s.id));
      return (
        <>
          {header}
          <ShopApprovalPanel
            pending={pending.map((s) => serialiseShop(s, onboarding.get(s.id)))}
            approved={approved.map((s) => serialiseShop(s))}
            approvalGateOn={statusModelsRule.enforceTransitions}
            canApprove={can(user.role, PERMISSIONS.SHOP_APPROVE)}
            canClassify={can(user.role, PERMISSIONS.SHOP_SET_CLASSIFICATION)}
          />
        </>
      );
    }

    case "overview": {
      const showFinancials = can(user.role, PERMISSIONS.REPORT_VIEW_ALL);
      const [approved, shopCounts, subscriptionCounts, userCount, orderStats, walletTotal] = await Promise.all([
        searchShopsAdmin({ status: "APPROVED", limit: 100 }),
        countShopsByLifecycle(),
        countSubscriptionsByStatus(),
        db.select({ value: count() }).from(users),
        db
          .select({ value: count(), revenue: sql<number>`COALESCE(SUM(${orders.totalPaise}), 0)::bigint` })
          .from(orders)
          .where(eq(orders.status, "DELIVERED")),
        showFinancials
          ? db.select({ total: sql<number>`COALESCE(SUM(${wallets.balancePaise}), 0)::bigint` }).from(wallets)
          : Promise.resolve([{ total: 0 }]),
      ]);
      const kesari = approved.filter((s) => s.classification === "KESARI").length;
      const green = approved.filter((s) => s.classification === "GREEN").length;
      const byType = new Map<string, number>();
      for (const shop of approved) byType.set(shop.shopType, (byType.get(shop.shopType) ?? 0) + 1);
      const topTypes = Array.from(byType.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
      return (
        <>
          {header}
          <section className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Total users" value={userCount[0].value} />
            <Stat label="Approved shops" value={approved.length} />
            <Stat label="KYC pending" value={shopCounts.KYC_PENDING} tone={shopCounts.KYC_PENDING > 0 ? "warning" : "neutral"} />
            <Stat label="Payment pending" value={shopCounts.PAYMENT_PENDING} tone={shopCounts.PAYMENT_PENDING > 0 ? "warning" : "neutral"} />
            <Stat label="Verified — awaiting approval" value={shopCounts.VERIFIED} tone={shopCounts.VERIFIED > 0 ? "warning" : "neutral"} />
            <Stat label="Active subscriptions" value={subscriptionCounts.ACTIVE ?? 0} />
            <Stat
              label="Subscriptions — renewal pending"
              value={subscriptionCounts.RENEWAL_PENDING ?? 0}
              tone={(subscriptionCounts.RENEWAL_PENDING ?? 0) > 0 ? "warning" : "neutral"}
            />
            <Stat label="Kesari shops" value={kesari} />
            <Stat label="Green shops" value={green} />
            {topTypes.map(([type, n]) => (
              <Stat key={type} label={`${shopTypeLabel(type)} shops`} value={n} />
            ))}
            <Stat label="Delivered orders" value={orderStats[0].value} />
            <Stat label="Delivered revenue" value={formatPaiseCompact(Number(orderStats[0].revenue))} />
            {showFinancials ? <Stat label="Wallet float" value={formatPaiseCompact(Number(walletTotal[0].total))} /> : null}
            <Stat
              label="Failed subscription payments"
              value={subscriptionCounts.PAYMENT_PENDING ?? 0}
              tone={(subscriptionCounts.PAYMENT_PENDING ?? 0) > 0 ? "warning" : "neutral"}
            />
          </section>
        </>
      );
    }

    case "compliance": {
      const canViewDashboard = can(user.role, PERMISSIONS.COMPLIANCE_DASHBOARD_VIEW);
      const canManageShopCompliance = can(user.role, PERMISSIONS.SHOP_COMPLIANCE_MANAGE);
      const canVerifyGstPan = can(user.role, PERMISSIONS.SHOP_GST_PAN_VERIFY);
      const [items, financeShops, pendingGstPan] = await Promise.all([
        canViewDashboard ? getComplianceChecklist() : Promise.resolve([]),
        canManageShopCompliance ? searchShopsAdmin({ limit: 500 }) : Promise.resolve([]),
        canVerifyGstPan ? listPendingGstPanVerifications() : Promise.resolve([]),
      ]);
      return (
        <>
          {header}
          {canViewDashboard ? (
            <Section title="Legal & regulatory compliance">
              <ComplianceDashboard items={items} />
            </Section>
          ) : null}
          {canManageShopCompliance ? (
            <Section title="Shop legal & seller information">
              <ShopComplianceManager
                shops={financeShops.map((s) => ({
                  id: s.id,
                  name: s.name,
                  shopType: s.shopType,
                  city: s.city,
                  legalBusinessName: s.legalBusinessName,
                  gstin: s.gstin,
                  fssaiLicenseNumber: s.fssaiLicenseNumber,
                  returnPolicyText: s.returnPolicyText,
                }))}
              />
            </Section>
          ) : null}
          {canVerifyGstPan ? (
            <>
              <Section title="Seller document verification">
                <Card className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm" data-testid="seller-verification-link">
                  <span className="text-ink-600">
                    PAN, GSTIN, Udyam, FSSAI and Shop Act checks the automatic verification couldn&apos;t settle.
                  </span>
                  <Link href="/admin/seller-verification" className="font-medium text-kesari-700 underline">
                    Open review queue →
                  </Link>
                </Card>
              </Section>
              <Section title={`GST & PAN verification (${pendingGstPan.length})`}>
                <GstPanVerificationQueue
                  shops={pendingGstPan.map((s) => ({
                    id: s.id,
                    name: s.name,
                    city: s.city,
                    gstStatus: s.gstStatus,
                    gstin: s.gstin,
                    panStatus: s.panStatus,
                    panMasked: getMaskedPan(s),
                    panHolderName: s.panHolderName,
                  }))}
                />
              </Section>
            </>
          ) : null}
        </>
      );
    }

    case "maps": {
      const summary = await getMapsUsageSummary();
      return (
        <>
          {header}
          <MapsUsagePanel summary={summary} />
        </>
      );
    }

    case "riders": {
      const canManageEarningsConfig = can(user.role, PERMISSIONS.DELIVERY_EARNINGS_CONFIG_MANAGE);
      const [partners, dashboard, earningsConfig] = await Promise.all([
        listDeliveryPartners(),
        countDeliveryPartnersByStatus(),
        canManageEarningsConfig ? getActiveEarningsConfig() : Promise.resolve(null),
      ]);
      return (
        <>
          {header}
          <div id="applications">
            <DeliveryPartnerQueue
              partners={partners.map((p) => ({
                id: p.id,
                fullName: p.fullName,
                mobile: p.mobile,
                email: p.email,
                vehicleType: p.vehicleType,
                vehicleRegistrationNumber: p.vehicleRegistrationNumber,
                operatingRadiusKm: p.operatingRadiusKm,
                locationVerified: p.locationVerified,
                status: p.status,
                reviewNotes: p.reviewNotes,
                rejectionReason: p.rejectionReason,
                createdAt: p.createdAt.toISOString(),
              }))}
              dashboard={dashboard}
            />
          </div>
          {canManageEarningsConfig && earningsConfig ? (
            <Section id="earnings-rate" title="Delivery earnings rate">
              <DeliveryEarningsConfigManager
                active={{
                  baseFeePaise: earningsConfig.baseFeePaise,
                  perKmFeePaise: earningsConfig.perKmFeePaise,
                  note: earningsConfig.note,
                }}
              />
            </Section>
          ) : null}
        </>
      );
    }

    case "grievances": {
      const [list, dashboard] = await Promise.all([listGrievances({ limit: 200 }), getGrievanceDashboard()]);
      return (
        <>
          <PageHeader title={`Grievances (${dashboard.open + dashboard.inProgress} open)`} />
          <GrievanceManager
            grievances={list.map((g) => ({
              id: g.id,
              ticketNumber: g.ticketNumber,
              name: g.name,
              email: g.email,
              category: g.category,
              subject: g.subject,
              description: g.description,
              status: g.status,
              resolutionNotes: g.resolutionNotes,
              createdAt: g.createdAt.toISOString(),
            }))}
            dashboard={dashboard}
          />
        </>
      );
    }

    case "price-approvals": {
      const rows = await listAllPending();
      return (
        <>
          <PageHeader title={`Price approvals (${rows.length})`} />
          <PendingPriceApprovals
            rows={rows.map((r) => ({
              id: r.id,
              productName: r.productName,
              productCode: r.productCode,
              unit: r.unit,
              priceType: r.priceType,
              previousPricePaise: r.previousPricePaise,
              proposedPricePaise: r.proposedPricePaise,
              source: r.source,
              shopName: r.shopName,
              createdAt: r.createdAt.toISOString(),
            }))}
            showShop
            canOverride
          />
        </>
      );
    }

    case "product-approvals": {
      const rows = await listPendingProductApprovals();
      return (
        <>
          <PageHeader title={`Products awaiting publication (${rows.length})`} />
          <ProductApprovalQueue
            rows={rows.map((p) => ({
              id: p.id,
              name: p.name,
              categoryName: p.category.name,
              unit: p.unit,
              description: p.description,
              createdByName: p.createdByName,
              createdAt: p.createdAt.toISOString(),
            }))}
          />
        </>
      );
    }

    case "registration-fees": {
      const canManageFee = can(user.role, PERMISSIONS.REGISTRATION_FEE_MANAGE);
      const [feeReport, financeShops, activeFee, feeHistory] = await Promise.all([
        getRegistrationFeeReport(),
        searchShopsAdmin({ limit: 500 }),
        canManageFee ? getActiveFee() : Promise.resolve(undefined),
        canManageFee ? listFeeHistory() : Promise.resolve([]),
      ]);
      return (
        <>
          {header}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Fees expected" value={formatPaiseCompact(feeReport.expectedPaise)} />
            <Stat label="Fees collected" value={formatPaiseCompact(feeReport.collectedPaise)} />
            <Stat label="Fees pending" value={formatPaiseCompact(feeReport.pendingPaise)} tone={feeReport.pendingPaise > 0 ? "warning" : "neutral"} />
            <Stat label="Fully paid shops" value={feeReport.fullyPaid} />
            <Stat label="Partially paid" value={feeReport.partiallyPaid} />
            <Stat label="Unpaid" value={feeReport.unpaid} />
            <Stat label="Refunded" value={formatPaiseCompact(feeReport.refundedPaise)} />
            <Stat label="Total shops" value={feeReport.totalShops} />
          </div>
          <Section id="shop-finance" title="Payments by shop">
            <ShopFinanceManager
              shops={financeShops.map((s) => ({
                id: s.id,
                name: s.name,
                registrationNumber: s.registrationNumber,
                ownerName: s.ownerName,
                phone: s.phone,
                city: s.city,
                registrationDate: s.registrationDate,
                registrationFeePaise: s.registrationFeePaise,
                amountPaidPaise: s.amountPaidPaise,
                feePaymentStatus: s.feePaymentStatus,
                referralCode: s.referralCode,
                status: s.status,
              }))}
              canRecordPayment={can(user.role, PERMISSIONS.PAYMENT_RECORD)}
            />
          </Section>
          {canManageFee ? (
            <Section id="fee-configuration" title="Registration fee configuration">
              <RegistrationFeeManager
                active={
                  activeFee
                    ? { id: activeFee.id, amountPaise: activeFee.amountPaise, effectiveFrom: activeFee.effectiveFrom, isActive: activeFee.isActive }
                    : null
                }
                history={feeHistory.map((h) => ({
                  id: h.id,
                  previousAmountPaise: h.previousAmountPaise,
                  newAmountPaise: h.newAmountPaise,
                  effectiveFrom: h.effectiveFrom,
                  reason: h.reason,
                  createdAt: h.createdAt.toISOString(),
                }))}
              />
            </Section>
          ) : null}
        </>
      );
    }

    case "referral-codes": {
      const [codes, performance] = await Promise.all([listReferralCodes(), getReferralPerformance()]);
      return (
        <>
          {header}
          <ReferralManager
            codes={codes.map((c) => ({
              id: c.id,
              code: c.code,
              label: c.label,
              referrerName: c.referrerName,
              status: c.status,
              expiresAt: c.expiresAt,
              shopCount: c.shopCount,
            }))}
            performance={performance.map((p) => ({
              id: p.id,
              code: p.code,
              referrerName: p.referrerName,
              shopCount: p.shopCount,
              feesAttributedPaise: Number(p.feesAttributedPaise),
            }))}
          />
        </>
      );
    }

    case "users": {
      const { role: roleFilter } = await searchParams;
      const userList = await listUsers({ limit: 100 });
      const userRoles = await listRolesForUsers(userList.map((u) => u.id));
      const STAFF_ROLES = ["ADMIN", "OPERATOR"];
      const shown = userList.filter((u) =>
        roleFilter === "STAFF" ? STAFF_ROLES.includes(u.role) : roleFilter ? u.role === roleFilter : true,
      );
      const tabs = [
        { key: "", label: "All" },
        { key: "CUSTOMER", label: "Customers" },
        { key: "SHOP_OWNER", label: "Shop owners" },
        { key: "STAFF", label: "Staff" },
      ];
      return (
        <>
          <PageHeader title={`Users (${shown.length})`} />
          <nav aria-label="Filter users" className="mb-4 flex flex-wrap gap-2" data-testid="list-tabs">
            {tabs.map((t) => (
              <Link
                key={t.key}
                href={t.key ? `/admin/console/users?role=${t.key}` : "/admin/console/users"}
                aria-current={(roleFilter ?? "") === t.key ? "page" : undefined}
                className={
                  (roleFilter ?? "") === t.key
                    ? "flex h-11 items-center rounded-xl bg-kesari-700 px-4 text-sm font-bold text-white"
                    : "flex h-11 items-center rounded-xl border border-[var(--gk-line)] bg-white px-4 text-sm font-semibold text-ink-900 hover:bg-kesari-50"
                }
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <div id="privileges">
            <UserRoleManager
              users={shown.map((u) => ({
                id: u.id,
                name: u.name,
                email: u.email,
                role: u.role,
                status: u.status,
                otherRoles: (userRoles.get(u.id) ?? []).filter((r) => r !== u.role),
              }))}
              currentUserId={user.id}
              canSetRole={can(user.role, PERMISSIONS.USER_SET_ROLE)}
            />
          </div>
          {can(user.role, PERMISSIONS.USER_SUSPEND) ? (
            <Section id="release-mobile" title="Release a mobile number">
              <p className="mb-3 text-sm text-ink-600">
                Mobile numbers are not SMS-verified. If someone added a number that belongs to another person, release it here so
                the real owner can add it. The holder is notified and must add a number again before ordering.
              </p>
              <ReleaseMobileForm />
            </Section>
          ) : null}
        </>
      );
    }

    case "vouchers": {
      const [list, dashboard] = await Promise.all([listVouchers(), getVoucherDashboard()]);
      return (
        <>
          {header}
          <div id="redemptions">
            <VoucherManager
              vouchers={list.map((v) => ({
                id: v.id,
                name: v.name,
                code: v.code,
                applyMode: v.applyMode,
                bonusPercent: v.bonusPercent,
                minimumTopupPaise: v.minimumTopupPaise,
                maximumBonusPaise: v.maximumBonusPaise,
                startDate: v.startDate,
                endDate: v.endDate,
                usageLimit: v.usageLimit,
                perCustomerLimit: v.perCustomerLimit,
                totalBudgetPaise: v.totalBudgetPaise,
                budgetUsedPaise: v.budgetUsedPaise,
                redemptionCount: v.redemptionCount,
                status: v.status,
              }))}
              dashboard={dashboard}
              canManage={can(user.role, PERMISSIONS.VOUCHER_MANAGE)}
            />
          </div>
          {can(user.role, PERMISSIONS.VOUCHER_UPLOAD) ? (
            <div id="voucher-upload" className="mt-4">
              <VoucherUpload />
            </div>
          ) : null}
        </>
      );
    }

    case "audit-log": {
      const rows = await listAuditLog(user.role, { limit: 100 });
      return (
        <>
          {header}
          <AuditLogView
            rows={rows.map((r) => ({
              id: r.id,
              action: r.action,
              entityType: r.entityType,
              entityId: r.entityId,
              actorName: r.actorName,
              actorEmail: r.actorEmail,
              actorRole: r.actorRole,
              previousValue: r.previousValue,
              newValue: r.newValue,
              createdAt: r.createdAt.toISOString(),
            }))}
            limited={user.role !== "ADMIN"}
          />
        </>
      );
    }
  }
}

function serialiseShop(shop: typeof shops.$inferSelect, onboarding?: ShopOnboarding) {
  return {
    id: shop.id,
    name: shop.name,
    slug: shop.slug,
    ownerName: shop.ownerName,
    phone: shop.phone,
    city: shop.city,
    area: shop.area,
    pincode: shop.pincode,
    shopType: shop.shopType,
    status: shop.status,
    classification: shop.classification,
    createdAt: shop.createdAt.toISOString(),
    // GS-008: approval is gated on the fee, so the queue shows it up front.
    feePaymentStatus: shop.feePaymentStatus,
    registrationFeePaise: shop.registrationFeePaise,
    amountPaidPaise: shop.amountPaidPaise,
    // SM-002: stage, missing documents and fee owed drive the badge and "Next".
    onboardingStage: onboarding?.stage ?? null,
    missingDocuments: onboarding?.missingDocuments ?? [],
    feeOutstandingPaise: onboarding?.feeOutstandingPaise ?? 0,
  };
}

function Stat({ label, value, tone = "neutral" }: { label: string; value: string | number; tone?: "neutral" | "warning" }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-ink-600">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone === "warning" ? "text-kesari-700" : "text-ink-900"}`}>{value}</p>
    </Card>
  );
}
