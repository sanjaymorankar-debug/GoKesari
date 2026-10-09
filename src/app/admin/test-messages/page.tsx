import { redirect } from "next/navigation";

import { Alert, Card, PageHeader, inputClass } from "@/components/ui";
import { getCurrentUser } from "@/server/authz/guards";
import { can, PERMISSIONS } from "@/server/authz/permissions";
import { listTestMessages } from "@/server/registration/admin";
import { textChannelMode } from "@/server/messaging/sms-whatsapp";

export const metadata = { title: "Test SMS and WhatsApp" };
export const dynamic = "force-dynamic";

/** Module 3: what the MOCK SMS / WhatsApp provider would have sent (test site) — testers read OTPs and links here. */
export default async function TestMessagesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (!can(user.role, PERMISSIONS.SHOP_REGISTRATION_MANAGE)) redirect("/");
  const params = await searchParams;
  const to = typeof params.to === "string" ? params.to : undefined;
  const rows = await listTestMessages(to);
  const smsMode = textChannelMode("SMS");
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Test SMS and WhatsApp" description="Messages written by the test (mock) provider instead of being sent. Real numbers receive nothing until an SMS / WhatsApp provider is connected." />
      {smsMode !== "mock" ? <Alert tone="info">SMS is not in test mode on this server (SMS_PROVIDER={smsMode}).</Alert> : null}
      <form className="flex gap-2">
        <input name="to" defaultValue={to ?? ""} placeholder="Filter by mobile number" className={inputClass} />
        <button className="rounded-lg border border-cream-200 px-3 text-sm" type="submit">Filter</button>
      </form>
      <Card className="divide-y divide-cream-200">
        {rows.map((m) => (
          <div key={m.id} className="p-3 text-sm">
            <p className="text-xs text-ink-500">{m.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} · {m.channel} · {m.toAddress} · {m.purpose}</p>
            <p className="mt-1 break-words text-ink-900">{m.body}</p>
          </div>
        ))}
        {rows.length === 0 ? <p className="p-6 text-center text-sm text-ink-500">No messages.</p> : null}
      </Card>
    </div>
  );
}
