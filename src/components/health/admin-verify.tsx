"use client";

/**
 * Health admin → Verification: doctors (registration certificate + doctor details, checked by hand on
 * the National Medical Register), home-care providers (with police verification), medical stores (drug
 * licence, pharmacist) and equipment stores. Approve / reject with a reason; the owner is told.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Badge, Button, inputClass } from "@/components/ui";
import { api, Chip } from "./api";
import { ADMIN_API, card, Detail, Loading, Nothing, VerificationBadge, type Post } from "./admin-common";

const NMR_URL = "https://www.nmc.org.in/information-desk/indian-medical-register/";
const POLICE = ["NOT_REQUIRED", "PENDING", "VERIFIED", "FAILED"] as const;

type Queue = "DOCTOR" | "CARE" | "PHARMACY" | "EQUIPMENT";
const QUEUES: [Queue, string][] = [
  ["DOCTOR", "Doctors"],
  ["CARE", "Home care"],
  ["PHARMACY", "Medical stores"],
  ["EQUIPMENT", "Equipment stores"],
];

export function Verification({ post }: { post: Post }) {
  const [queue, setQueue] = useState<Queue>("DOCTOR");
  const [status, setStatus] = useState("PENDING");
  const [q, setQ] = useState("");
  return (
    <div className="flex flex-col gap-2" data-testid="health-verify">
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [&>*]:shrink-0">
        {QUEUES.map(([k, l]) => (
          <Chip key={k} active={queue === k} onClick={() => setQueue(k)} testId={`health-verify-queue-${k.toLowerCase()}`}>
            {l}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {["PENDING", "VERIFIED", "REJECTED", "ALL"].map((s) => (
          <Chip key={s} active={status === s} onClick={() => setStatus(s)}>
            {s === "ALL" ? "All" : s[0] + s.slice(1).toLowerCase()}
          </Chip>
        ))}
        <input className={`${inputClass} min-h-10 max-w-xs`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or city" aria-label="Search" />
      </div>
      {queue === "DOCTOR" || queue === "CARE" ? <Providers key={queue} kind={queue} status={status} q={q} post={post} /> : <Stores key={queue} kind={queue} status={status} q={q} post={post} />}
    </div>
  );
}

interface Member {
  id: string;
  name: string;
  docStatus: string;
  registrationNumber: string | null;
  registrationBody: string | null;
  categories: string[];
  documents: number;
  doctor: { fullName: string; practitionerType: string; qualifications: string; specialties: string[]; council: string; registrationNumber: string; registrationYear: number | null; hprId: string | null } | null;
  care: { providerKind: string; gender: string | null; registrationBody: string | null; registrationNumber: string | null; policeVerification: string; servicePincodes: string[]; serviceRadiusKm: number; idCardNumber: string } | null;
}

interface ProviderCard {
  profileId: string;
  shopId: string;
  slug: string;
  name: string;
  shopName: string;
  city: string;
  profileStatus: string;
  verification: string;
  verificationNote: string | null;
  members: Member[];
}

function Providers({ kind, status, q, post }: { kind: "DOCTOR" | "CARE"; status: string; q: string; post: Post }) {
  const [rows, setRows] = useState<ProviderCard[] | null>(null);
  const [docs, setDocs] = useState<Record<string, { id: string; fileName: string; url: string }[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "providers", kind, status });
    if (q.trim()) p.set("q", q.trim());
    setRows((await api<{ providers: ProviderCard[] }>(`${ADMIN_API}?${p.toString()}`)).providers);
  }, [kind, status, q]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the filters change
    void load();
  }, [load]);
  const openDocs = async (memberId: string) => {
    const res = await api<{ documents: { id: string; fileName: string; url: string }[] }>(`${ADMIN_API}?view=documents&member=${memberId}`);
    setDocs((d) => ({ ...d, [memberId]: res.documents }));
  };
  const decide = async (c: ProviderCard, decision: "VERIFIED" | "REJECTED") => {
    const note = notes[c.profileId]?.trim() || null;
    const res = await post({ action: "decideProvider", kind, profileId: c.profileId, decision, note, memberIds: c.members.map((m) => m.id) }, `${c.name}: ${decision === "VERIFIED" ? "approved" : "rejected"}. The owner is told.`);
    if (res) await load();
  };
  const police = async (memberId: string, value: string) => {
    if (await post({ action: "police", memberId, status: value }, "Police verification saved.")) await load();
  };
  if (rows === null) return <Loading />;
  if (!rows.length) return <Nothing>No {kind === "DOCTOR" ? "doctors" : "home-care providers"} here.</Nothing>;
  return (
    <div className="flex flex-col gap-2">
      {kind === "DOCTOR" ? (
        <p className="text-xs text-ink-600">
          Check each registration on the{" "}
          <a href={NMR_URL} target="_blank" rel="noreferrer" className="font-bold text-kesari-800 underline">
            National Medical Register (Indian Medical Register search)
          </a>{" "}
          or the state council&apos;s list before approving.
        </p>
      ) : null}
      {rows.map((c) => (
        <div key={c.profileId} className={card} data-testid="health-provider-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-extrabold">
                <Link href={`/consult/${encodeURIComponent(c.slug)}`} className="hover:underline">
                  {c.name}
                </Link>{" "}
                <span className="text-sm font-normal text-ink-600">
                  ({c.shopName}, {c.city})
                </span>
              </p>
              <p className="flex flex-wrap gap-1 text-xs">
                Practice <VerificationBadge value={c.verification} /> Profile <Badge>{c.profileStatus.toLowerCase()}</Badge>
              </p>
              {c.verificationNote ? <p className="text-xs text-ink-600">Last note: {c.verificationNote}</p> : null}
            </div>
            <Link href={`/shop/consult/setup?shopId=${c.shopId}`} className="text-sm font-bold text-kesari-800 underline">
              Open setup
            </Link>
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {c.members.map((m) => (
              <li key={m.id} className="rounded-xl bg-cream-50 p-2" data-testid="health-provider-member">
                <p className="flex flex-wrap items-center gap-1.5 text-sm">
                  <strong>{m.name}</strong> <VerificationBadge value={m.docStatus} />
                  <span className="text-xs text-ink-600">{m.categories.join(", ")}</span>
                </p>
                {kind === "DOCTOR" ? (
                  m.doctor ? (
                    <div className="mt-1 grid gap-0.5 sm:grid-cols-2">
                      <Detail label="Name as registered">{m.doctor.fullName}</Detail>
                      <Detail label="Qualifications">{m.doctor.qualifications}</Detail>
                      <Detail label="Council">{m.doctor.council}</Detail>
                      <Detail label="Registration">
                        {m.doctor.registrationNumber}
                        {m.doctor.registrationYear ? ` (${m.doctor.registrationYear})` : ""}
                      </Detail>
                      {m.doctor.hprId ? <Detail label="HPR id">{m.doctor.hprId}</Detail> : null}
                      {m.doctor.specialties.length ? <Detail label="Specialties">{m.doctor.specialties.join(", ")}</Detail> : null}
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-amber-800">
                      Doctor details (council, registration number, qualifications) not filled in yet{m.registrationNumber ? ` — consultant profile says ${m.registrationBody ?? ""} No. ${m.registrationNumber}` : ""}. The doctor cannot prescribe until they are.
                    </p>
                  )
                ) : m.care ? (
                  <div className="mt-1 grid gap-0.5 sm:grid-cols-2">
                    <Detail label="Provider">{m.care.providerKind === "AGENCY" ? "Agency" : "Individual"}{m.care.gender ? ` · ${m.care.gender.toLowerCase()}` : ""}</Detail>
                    <Detail label="ID card">{m.care.idCardNumber}</Detail>
                    {m.care.registrationNumber ? <Detail label="Registration">{`${m.care.registrationBody ?? ""} ${m.care.registrationNumber}`.trim()}</Detail> : null}
                    <Detail label="Serves">{m.care.servicePincodes.length ? m.care.servicePincodes.join(", ") : `${m.care.serviceRadiusKm} km`}</Detail>
                    <label className="flex items-center gap-2 text-sm">
                      <span className="text-ink-600">Police verification:</span>
                      <select className={`${inputClass} min-h-10 w-auto`} value={m.care.policeVerification} onChange={(e) => police(m.id, e.target.value)} data-testid="health-police-select">
                        {POLICE.map((p) => (
                          <option key={p} value={p}>
                            {p.replace(/_/g, " ").toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-amber-800">Home-care details (ID card, area served) not filled in yet.</p>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                  {m.documents ? (
                    <button type="button" className="min-h-10 font-bold text-kesari-800 underline" onClick={() => openDocs(m.id)} data-testid="health-provider-docs">
                      {m.documents} certificate(s)
                    </button>
                  ) : (
                    <span className="text-ink-600">No certificate uploaded</span>
                  )}
                  {(docs[m.id] ?? []).map((d) => (
                    <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="text-kesari-800 underline">
                      {d.fileName}
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={`${inputClass} max-w-sm`} placeholder="Note to the provider (needed to reject)" value={notes[c.profileId] ?? ""} onChange={(e) => setNotes({ ...notes, [c.profileId]: e.target.value })} aria-label="Note" />
            <Button size="sm" onClick={() => decide(c, "VERIFIED")} data-testid="health-verify-approve">
              Approve
            </Button>
            <Button size="sm" variant="danger" onClick={() => decide(c, "REJECTED")} data-testid="health-verify-reject">
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

interface StoreCard {
  shopId: string;
  shopName: string;
  slug: string;
  city: string;
  shopStatus: string;
  ownerName: string | null;
  verification: string;
  verificationNote: string | null;
  verifiedAt: string | null;
  createdAt: string;
  details: { label: string; value: string }[];
}

interface Legal {
  enabled: boolean;
  restricted: boolean;
  documents: { label: string; state: string; number: string | null; expiryDate: string | null }[];
}

function Stores({ kind, status, q, post }: { kind: "PHARMACY" | "EQUIPMENT"; status: string; q: string; post: Post }) {
  const [rows, setRows] = useState<StoreCard[] | null>(null);
  const [legal, setLegal] = useState<Record<string, Legal>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: "stores", kind, status });
    if (q.trim()) p.set("q", q.trim());
    setRows((await api<{ stores: StoreCard[] }>(`${ADMIN_API}?${p.toString()}`)).stores);
  }, [kind, status, q]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the filters change
    void load();
  }, [load]);
  const openLegal = async (shopId: string) => {
    const res = await api<Legal>(`${ADMIN_API}?view=legal&shopId=${shopId}`);
    setLegal((l) => ({ ...l, [shopId]: res }));
  };
  const decide = async (s: StoreCard, decision: "VERIFIED" | "REJECTED") => {
    const note = notes[s.shopId]?.trim() || null;
    if (await post({ action: "decideStore", kind, shopId: s.shopId, decision, note }, `${s.shopName}: ${decision === "VERIFIED" ? "verified" : "rejected"}. The owner is told.`)) await load();
  };
  if (rows === null) return <Loading />;
  if (!rows.length) return <Nothing>No {kind === "PHARMACY" ? "medical stores" : "equipment stores"} here.</Nothing>;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((s) => (
        <div key={s.shopId} className={card} data-testid="health-store-card">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-extrabold">
                {s.shopName} <span className="text-sm font-normal text-ink-600">({s.city}{s.ownerName ? ` · ${s.ownerName}` : ""})</span>
              </p>
              <p className="flex flex-wrap gap-1 text-xs">
                Health <VerificationBadge value={s.verification} /> Shop <Badge>{s.shopStatus.replace(/_/g, " ").toLowerCase()}</Badge>
              </p>
              {s.verificationNote ? <p className="text-xs text-ink-600">Last note: {s.verificationNote}</p> : null}
            </div>
            <Link href={`/admin/legal-documents`} className="text-sm font-bold text-kesari-800 underline">
              Legal documents admin
            </Link>
          </div>
          <div className="mt-2 grid gap-0.5 sm:grid-cols-2">
            {s.details.map((d) => (
              <Detail key={d.label} label={d.label}>
                {d.value}
              </Detail>
            ))}
          </div>
          <div className="mt-1 text-sm">
            {legal[s.shopId] ? (
              <div className="rounded-xl bg-cream-50 p-2" data-testid="health-store-legal">
                {!legal[s.shopId].enabled ? <p className="text-xs text-ink-600">Legal document checks are switched off.</p> : null}
                {legal[s.shopId].restricted ? <p className="text-xs font-bold text-red-700">A required document is blocking this shop&apos;s orders.</p> : null}
                {legal[s.shopId].documents.length ? (
                  <ul className="flex flex-col gap-0.5">
                    {legal[s.shopId].documents.map((d) => (
                      <li key={d.label} className="flex flex-wrap items-center gap-1.5 text-xs">
                        <strong>{d.label}</strong> <Badge tone={d.state === "APPROVED" ? "success" : d.state === "REJECTED" || d.state === "EXPIRED" ? "danger" : "info"}>{d.state.replace(/_/g, " ").toLowerCase()}</Badge>
                        {d.number ? <span>{d.number}</span> : null}
                        {d.expiryDate ? <span>expires {d.expiryDate}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-600">No legal documents on file.</p>
                )}
              </div>
            ) : (
              <button type="button" className="min-h-10 text-xs font-bold text-kesari-800 underline" onClick={() => openLegal(s.shopId)}>
                Show legal documents
              </button>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={`${inputClass} max-w-sm`} placeholder="Note to the store (needed to reject)" value={notes[s.shopId] ?? ""} onChange={(e) => setNotes({ ...notes, [s.shopId]: e.target.value })} aria-label="Note" />
            <Button size="sm" onClick={() => decide(s, "VERIFIED")} data-testid="health-store-approve">
              Approve
            </Button>
            <Button size="sm" variant="danger" onClick={() => decide(s, "REJECTED")} data-testid="health-store-reject">
              Reject
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
