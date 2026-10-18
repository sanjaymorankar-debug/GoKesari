"use client";

/** Admin: create manufacturer accounts and link their users (batch-2026-10 WS-D, F9.1.2). */
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert, Button, inputClass } from "@/components/ui";

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong.");
  return data;
}

export function ManufacturerAdmin({ accounts }: { accounts: { id: string; name: string; sourceKey: string; brandNames: string[]; members: number; activeKeys: number }[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [brands, setBrands] = useState("");
  const [member, setMember] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const run = async (fn: () => Promise<string>) => {
    setMessage(null);
    try {
      setMessage({ tone: "success", text: await fn() });
      router.refresh();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Something went wrong." });
    }
  };

  return (
    <div className="space-y-4">
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      <form
        className="grid gap-2 rounded-xl border border-cream-200 bg-white p-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const a = await post("/api/pmd/manufacturers", { name, brandNames: brands.split(",").map((b) => b.trim()).filter(Boolean) });
            setName("");
            setBrands("");
            return `Created ${a.name} (source ${a.sourceKey}).`;
          });
        }}
      >
        <input className={inputClass} required placeholder="Manufacturer name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={inputClass} placeholder="Brands (comma separated)" value={brands} onChange={(e) => setBrands(e.target.value)} />
        <Button type="submit">Create account</Button>
      </form>
      <ul className="space-y-2">
        {accounts.map((a) => (
          <li key={a.id} className="rounded-xl border border-cream-200 bg-white p-3">
            <p className="font-semibold text-ink-900">{a.name}</p>
            <p className="text-xs text-ink-500">
              {a.sourceKey} · brands {a.brandNames.join(", ") || "—"} · {a.members} member(s) · {a.activeKeys} active key(s)
            </p>
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await post(`/api/pmd/manufacturers/${a.id}/members`, { email: member[a.id] ?? "" });
                  return `Linked ${member[a.id]} to ${a.name}.`;
                });
              }}
            >
              <input className={`${inputClass} max-w-xs`} type="email" placeholder="User's email" value={member[a.id] ?? ""} onChange={(e) => setMember({ ...member, [a.id]: e.target.value })} />
              <Button size="sm" type="submit" variant="secondary">Add user</Button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  );
}
