import { redirect } from "next/navigation";
import { ProfileCompletionForm } from "@/components/profile-completion-form";
import { Card } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";

export const metadata = { title: "Complete Your Profile" };
export const dynamic = "force-dynamic";

export default async function CompleteProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  // If profile is already complete, redirect to home
  if (user.profileCompletedAt) redirect("/");

  async function handleComplete(data: any) {
    "use server";
    try {
      const response = await fetch("/api/profile/complete", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to save profile");
      }

      redirect("/");
    } catch (error) {
      throw error instanceof Error ? error : new Error("Unknown error");
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
