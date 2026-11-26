import { Card, LinkButton, PageHeader } from "@/components/ui";
import { ShopStaffInviteAccept } from "@/components/shop-staff-invite-accept";
import { SHOP_STAFF_ROLE_LABELS } from "@/lib/shop-staff/permissions";
import { getCurrentUser } from "@/server/authz/guards";
import { findInvitationByToken } from "@/server/services/shop-staff";
import { shopStaffRolesEnabled } from "@/server/services/shop-staff-access";

export const metadata = { title: "Shop staff invitation", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Module 10 (docs/shop-staff-roles-2026-11): the page an invitation e-mail links to.
 * Outside /shop so a signed-out visitor sees it: they sign in with the e-mailed code
 * (with the address the invitation went to) and accept — here, or on "Shops I help with",
 * which lists invitations to their e-mail address too.
 */
export default async function StaffInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const enabled = await shopStaffRolesEnabled();
  const invitation = enabled && token ? await findInvitationByToken(token) : null;
  const user = await getCurrentUser();

  if (!invitation) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <PageHeader title="Invitation not found" description="This invitation link is not valid any more — it may have been accepted or cancelled. Ask the shop owner to invite you again." />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-lg p-4">
      <PageHeader title={`Join ${invitation.shopName}`} description={`You are invited to the shop's staff as ${SHOP_STAFF_ROLE_LABELS[invitation.role]}.`} />
      <Card className="space-y-3 p-4 text-sm">
        {invitation.expired ? (
          <p className="text-ink-700">This invitation has expired. Ask the shop owner to invite you again.</p>
        ) : user ? (
          <>
            <p className="text-ink-700">Signed in as {user.email}. Accept to start helping with this shop.</p>
            <ShopStaffInviteAccept token={token} label="Accept invitation" />
          </>
        ) : (
          <>
            <p className="text-ink-700">
              Sign in with the e-mail address this invitation was sent to — we e-mail you a sign-in code. Then open this link again, or go to
              “Shops I help with”, and accept.
            </p>
            <LinkButton href="/signin">Sign in</LinkButton>
          </>
        )}
      </Card>
    </div>
  );
}
