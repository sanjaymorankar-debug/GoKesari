import { redirect } from "next/navigation";
import { Card, PageHeader } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Edit Profile" };
export const dynamic = "force-dynamic";

export default async function EditProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  async function handleUpdate(formData: FormData) {
    "use server";
    const name = formData.get("name") as string;
    const gender = formData.get("gender") as string;

    if (!name.trim()) {
      return { error: "Name is required" };
    }

    try {
      await db
        .update(users)
        .set({
          name: name.trim(),
          ...(gender && { gender: gender as "MALE" | "FEMALE" | "OTHER" }),
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      redirect("/profile");
    } catch (error) {
      return { error: "Failed to update profile" };
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Edit Profile" />

      <Card className="p-6">
        <form action={handleUpdate} className="space-y-4">
          <div>
            <label htmlFor="name" className="block text-sm font-medium text-ink-900 mb-1">
              Full Name *
            </label>
            <input
              type="text"
              id="name"
              name="name"
              defaultValue={user.name ?? ""}
              placeholder="Your full name"
              className="w-full rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
              required
            />
          </div>

          <div>
            <label htmlFor="gender" className="block text-sm font-medium text-ink-900 mb-1">
              Gender
            </label>
            <select
              id="gender"
              name="gender"
              defaultValue={user.gender ?? ""}
              className="w-full rounded-lg border border-cream-200 px-3 py-2 text-sm focus:border-kesari-500 focus:outline-none"
            >
              <option value="">Prefer not to say</option>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-ink-900 mb-1">
              Email (read-only)
            </label>
            <input
              type="email"
              value={user.email}
              disabled
              className="w-full rounded-lg border border-cream-200 bg-cream-50 px-3 py-2 text-sm text-ink-600"
            />
            <p className="mt-1 text-xs text-ink-500">
              Email cannot be changed from here. Please contact support to update your email.
            </p>
          </div>

          <div className="flex gap-2 pt-4">
            <button
              type="button"
              onClick={() => window.history.back()}
              className="flex-1 rounded-lg border border-cream-200 px-4 py-2 text-sm font-medium text-ink-700 hover:bg-cream-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 rounded-lg bg-kesari-600 px-4 py-2 text-sm font-medium text-white hover:bg-kesari-700"
            >
              Save Changes
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
