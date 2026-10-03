import { redirect } from "next/navigation";
import { ProfileCompletionForm } from "@/components/profile-completion-form";
import { Card } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Complete Your Profile" };
export const dynamic = "force-dynamic";

export default async function CompleteProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  // Check if profile is already complete
  const [dbUser] = await db.select().from(users).where(eq(users.id, user.id));
  if (dbUser?.profileCompletedAt) redirect("/");

  async function handleComplete(data: Record<string, unknown>) {
    "use server";
    try {
      const response = await fetch("http://localhost:3000/api/profile/complete", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error("Profile completion failed:", error);
      }

      redirect("/");
    } catch (error) {
      console.error("Profile completion error:", error);
      redirect("/");
    }
  }

  async function handleSkip() {
    "use server";
    redirect("/");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Card className="p-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-ink-900">Welcome to GoKesari!</h1>
          <p className="mt-2 text-ink-600">
            Help us serve you better by completing your profile. You can update this anytime.
          </p>
        </div>

        <ProfileCompletionForm
          onComplete={handleComplete}
          onSkip={handleSkip}
        />
      </Card>
    </div>
  );
}
