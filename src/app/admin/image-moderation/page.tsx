import { redirect } from "next/navigation";

import { ImageModerationQueue } from "@/components/image-moderation-queue";
import { PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listPendingImages } from "@/server/services/product-images";

export const metadata = { title: "Image moderation" };
export const dynamic = "force-dynamic";

/** F10: shop owners' product photos waiting for approval before customers see them. */
export default async function ImageModerationPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.PRODUCT_MANAGE)) redirect("/");
  const rows = await listPendingImages();
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Image moderation"
        description="Photos shop owners added. Nothing here is shown to customers until you approve it."
      />
      <ImageModerationQueue
        rows={rows.map((r) => ({
          id: r.id,
          url: r.url,
          productName: r.productName,
          shopName: r.shopName,
          createdAt: r.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
