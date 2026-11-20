"use client";

/**
 * A firm's booking setup (docs/consult-booking-2026-11): profile and map pin,
 * cancellation policy and booking rules, team members (categories,
 * languages, registration certificate, slot length, buffer, people per
 * slot), weekly hours with several sessions a day, leave / holidays /
 * blocks / extra hours, services (duration, fee, advance, modes, one-to-one /
 * team / group), and publishing. Used by the owner, consult staff and the
 * operator who onboarded the shop.
 */
import { useCallback, useEffect, useState } from "react";

import { CONSULT_MODES, CONSULT_REQUIRED_DOC_LABELS, CONSULT_TIME_OFF_LABELS, WEEKDAY_SHORT, type ConsultRequiredDoc } from "@/lib/consult/constants";
import { clock, formatIst, istDateKey } from "@/lib/consult/time";
import { MapPicker } from "@/components/map-picker";
import { Alert, Badge, Button, Field, inputClass } from "@/components/ui";
import { api, Chip, MODE_ICON, modeLabel, Panel, rupees } from "./common";

interface Member {
  id: string;
  name: string;
  title: string | null;
  photoUrl: string | null;
  qualifications: string | null;
  experienceYears: number | null;
  languages: string[];
  bio: string | null;
  registrationNumber: string | null;
  registrationBody: string | null;
  docStatus: string;
  docNote: string | null;
  slotMinutes: number;
  bufferMinutes: number;
  maxPerSlot: number;
  color: string;
  isOwner: boolean;
  status: "ACTIVE" | "INACTIVE";
  sortOrder: number;
  categoryIds: string[];
  hours: { weekday: number; startMinute: number; endMinute: number }[];
  documents: number;
  userEmail: string | null;
}
interface Service {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  durationMinutes: number;
  feeType: "FREE" | "FIXED" | "DEPOSIT";
  feePaise: number;
  depositPaise: number;
  modes: string[];
  bookingKind: "INDIVIDUAL" | "TEAM" | "GROUP";
  capacity: number;
  requiredMembers: number;
  memberIds: string[];
  payOnline: boolean;
  payAtVisit: boolean;
  gstRateBp: number;
  status: "ACTIVE" | "INACTIVE";
}
interface Category {
  id: string;
  name: string;
  groupName: string;
  requiredDoc: ConsultRequiredDoc;
  requiredDocLabel: string | null;
}
interface SetupData {
  profile: {
    id: string;
    kind: string;
    displayName: string;
    headline: string | null;
    about: string | null;
    photoUrl: string | null;
    addressLine: string | null;
    latitude: number | null;
    longitude: number | null;
    policyTemplateId: string | null;
    freeCancelHours: number;
    lateCancelRefundPct: number;
    noShowRefundPct: number;
    rescheduleMinHours: number;
    maxReschedules: number;
    policyNote: string | null;
    manualApproval: boolean;
    bookingWindowDays: number;
    minNoticeMinutes: number;
    completionOtp: boolean;
    status: string;
    verification: string;
    verificationNote: string | null;
  };
  shop: { id: string; name: string; status: string; address: string; latitude: string | null; longitude: string | null; gstRegistered: boolean };
  members: Member[];
  services: Service[];
  timeOff: { id: string; memberId: string | null; kind: string; startsAt: string; endsAt: string; reason: string | null }[];
  categories: Category[];
  templates: { id: string; name: string; description: string | null }[];
  problems: { key: string; message: string }[];
}

const blankService = (): Partial<Service> & { feeRupees: number; depositRupees: number; gstRatePct: number } => ({
  name: "",
  description: "",
  categoryId: null,
  durationMinutes: 30,
  feeType: "FIXED",
  feeRupees: 500,
  depositRupees: 0,
  modes: ["IN_PERSON"],
  bookingKind: "INDIVIDUAL",
  capacity: 1,
  requiredMembers: 2,
  memberIds: [],
  payOnline: true,
  payAtVisit: true,
  gstRatePct: 0,
  status: "ACTIVE",
});

export function ConsultSetup({ shopId }: { shopId: string }) {
  const [data, setData] = useState<SetupData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"profile" | "team" | "services" | "hours">("profile");

  const load = useCallback(async () => {
    try {
      setData(await api<SetupData>(`/api/consult/firm/${shopId}?view=setup`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the setup.");
    }
  }, [shopId]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads server data (an external system) when the view's inputs change
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/consult/firm/${shopId}`, { json: body });
      setNotice(done);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not save.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) return <Alert tone="danger">{error}</Alert>;
  if (!data) return <p className="text-sm text-ink-600">Loading…</p>;
  const p = data.profile;

  return (
    <div className="flex flex-col gap-3" data-testid="consult-setup">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3">
        <div>
          <p className="text-sm font-extrabold text-ink-900">{p.displayName}</p>
          <p className="text-xs text-ink-700">
            Profile <Badge tone={p.status === "LIVE" ? "success" : p.status === "BLOCKED" ? "danger" : "warning"}>{p.status}</Badge>{" "}
            Verification <Badge tone={p.verification === "VERIFIED" ? "success" : p.verification === "REJECTED" ? "danger" : "info"}>{p.verification}</Badge>
            {p.verificationNote ? ` — ${p.verificationNote}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {p.status === "LIVE" ? (
            <Button variant="secondary" onClick={() => post({ action: "pause" }, "Paused: customers cannot book until you publish again.")} disabled={busy}>
              Pause bookings
            </Button>
          ) : (
            <Button onClick={() => post({ action: "publish" }, "Published. Customers can find and book you now.")} disabled={busy || data.problems.length > 0} data-testid="consult-publish">
              Publish
            </Button>
          )}
        </div>
      </div>
      {data.problems.length ? (
        <Alert tone="warning" title="Before you can publish">
          <ul className="list-disc pl-5">
            {data.problems.map((x) => (
              <li key={x.key}>{x.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap gap-1.5" role="tablist">
        {(
          [
            ["profile", "Profile & policy"],
            ["team", `Team (${data.members.length})`],
            ["services", `Services (${data.services.filter((s) => s.status === "ACTIVE").length})`],
            ["hours", "Hours & leave"],
          ] as const
        ).map(([k, label]) => (
          <Chip key={k} active={tab === k} onClick={() => setTab(k)} testId={`consult-setup-tab-${k}`}>
            {label}
          </Chip>
        ))}
      </div>

      {tab === "profile" ? <ProfileForm data={data} busy={busy} post={post} /> : null}
      {tab === "team" ? <TeamForm data={data} busy={busy} post={post} shopId={shopId} reload={load} setError={setError} /> : null}
      {tab === "services" ? <ServicesForm data={data} busy={busy} post={post} /> : null}
      {tab === "hours" ? <HoursForm data={data} busy={busy} post={post} /> : null}
    </div>
  );
}

type Post = (body: Record<string, unknown>, done: string) => Promise<boolean>;

function ProfileForm({ data, busy, post }: { data: SetupData; busy: boolean; post: Post }) {
  const p = data.profile;
  const [f, setF] = useState({ ...p, latitude: p.latitude, longitude: p.longitude });
  const [pin, setPin] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="Profile">
        <div className="flex flex-col gap-2">
          <Field label="Name customers see">
            <input className={inputClass} value={f.displayName} onChange={(e) => set("displayName", e.target.value)} data-testid="consult-display-name" />
          </Field>
          <Field label="One line (speciality, firm type)">
            <input className={inputClass} value={f.headline ?? ""} onChange={(e) => set("headline", e.target.value)} placeholder="Family physician · 15 years" />
          </Field>
          <Field label="About">
            <textarea className={inputClass} rows={3} value={f.about ?? ""} onChange={(e) => set("about", e.target.value)} />
          </Field>
          <Field label="Photo link (optional)">
            <input className={inputClass} value={f.photoUrl ?? ""} onChange={(e) => set("photoUrl", e.target.value)} placeholder="https://…" />
          </Field>
          <Field label="Office address (blank: the shop's address)" hint={data.shop.address}>
            <input className={inputClass} value={f.addressLine ?? ""} onChange={(e) => set("addressLine", e.target.value)} />
          </Field>
          <p className="text-xs text-ink-700">
            Map pin:{" "}
            {f.latitude != null ? `${f.latitude.toFixed(5)}, ${f.longitude?.toFixed(5)}` : data.shop.latitude ? `the shop's pin (${data.shop.latitude}, ${data.shop.longitude})` : "not set"}{" "}
            <button type="button" className="font-bold text-kesari-800 underline" onClick={() => setPin((v) => !v)}>
              {pin ? "Close map" : "Set on map"}
            </button>
          </p>
          {pin ? (
            <MapPicker
              purpose="consult_profile"
              initialCoordinates={f.latitude != null && f.longitude != null ? { latitude: f.latitude, longitude: f.longitude } : data.shop.latitude ? { latitude: Number(data.shop.latitude), longitude: Number(data.shop.longitude) } : null}
              onConfirm={(r) => {
                setF((x) => ({ ...x, latitude: r.latitude, longitude: r.longitude, addressLine: x.addressLine || r.formattedAddress }));
                setPin(false);
              }}
            />
          ) : null}
        </div>
      </Panel>
      <Panel title="Cancellation policy and booking rules">
        <div className="flex flex-col gap-2">
          <Field label="Start from a template">
            <select className={inputClass} value={f.policyTemplateId ?? ""} onChange={(e) => set("policyTemplateId", e.target.value || null)}>
              <option value="">Custom (below)</option>
              {data.templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} — {t.description}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Free cancellation until (hours before)">
              <input className={inputClass} type="number" min={0} value={f.freeCancelHours} onChange={(e) => set("freeCancelHours", num(e.target.value))} />
            </Field>
            <Field label="Refund after that (%)">
              <input className={inputClass} type="number" min={0} max={100} value={f.lateCancelRefundPct} onChange={(e) => set("lateCancelRefundPct", num(e.target.value))} />
            </Field>
            <Field label="No-show refund (%)">
              <input className={inputClass} type="number" min={0} max={100} value={f.noShowRefundPct} onChange={(e) => set("noShowRefundPct", num(e.target.value))} />
            </Field>
            <Field label="Time changes allowed">
              <input className={inputClass} type="number" min={0} max={10} value={f.maxReschedules} onChange={(e) => set("maxReschedules", num(e.target.value))} />
            </Field>
            <Field label="…until (hours before)">
              <input className={inputClass} type="number" min={0} value={f.rescheduleMinHours} onChange={(e) => set("rescheduleMinHours", num(e.target.value))} />
            </Field>
            <Field label="Book up to (days ahead)">
              <input className={inputClass} type="number" min={1} max={365} value={f.bookingWindowDays} onChange={(e) => set("bookingWindowDays", num(e.target.value))} />
            </Field>
            <Field label="Minimum notice (minutes)">
              <input className={inputClass} type="number" min={0} value={f.minNoticeMinutes} onChange={(e) => set("minNoticeMinutes", num(e.target.value))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.manualApproval} onChange={(e) => set("manualApproval", e.target.checked)} /> I accept each booking myself (otherwise confirmed at once)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.completionOtp} onChange={(e) => set("completionOtp", e.target.checked)} /> Ask the customer&apos;s code to complete an in-person / home visit
          </label>
        </div>
      </Panel>
      <div className="md:col-span-2">
        <Button
          disabled={busy}
          data-testid="consult-save-profile"
          onClick={() =>
            post(
              {
                action: "profile",
                profile: {
                  kind: f.kind,
                  displayName: f.displayName,
                  headline: f.headline,
                  about: f.about,
                  photoUrl: f.photoUrl,
                  addressLine: f.addressLine,
                  latitude: f.latitude,
                  longitude: f.longitude,
                  ...(f.policyTemplateId && f.policyTemplateId !== p.policyTemplateId
                    ? { policyTemplateId: f.policyTemplateId }
                    : { freeCancelHours: f.freeCancelHours, lateCancelRefundPct: f.lateCancelRefundPct, noShowRefundPct: f.noShowRefundPct, rescheduleMinHours: f.rescheduleMinHours, maxReschedules: f.maxReschedules }),
                  manualApproval: f.manualApproval,
                  bookingWindowDays: f.bookingWindowDays,
                  minNoticeMinutes: f.minNoticeMinutes,
                  completionOtp: f.completionOtp,
                },
              },
              "Profile saved.",
            )
          }
        >
          Save profile
        </Button>
      </div>
    </div>
  );
}

function TeamForm({ data, busy, post, shopId, reload, setError }: { data: SetupData; busy: boolean; post: Post; shopId: string; reload: () => Promise<void>; setError: (e: string | null) => void }) {
  const [editing, setEditing] = useState<Partial<Member> | null>(null);
  const [langs, setLangs] = useState("");
  const startEdit = (m: Partial<Member> | null) => {
    setEditing(m);
    setLangs(m?.languages?.join(", ") ?? "English, Hindi");
  };
  const groups = new Map<string, Category[]>();
  for (const c of data.categories) groups.set(c.groupName, [...(groups.get(c.groupName) ?? []), c]);
  const uploadDoc = async (memberId: string, file: File) => {
    const form = new FormData();
    form.set("memberId", memberId);
    form.set("file", file);
    try {
      await api(`/api/consult/firm/${shopId}/document`, { method: "POST", body: form });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {data.members.map((m) => {
        const need = data.categories.filter((c) => m.categoryIds.includes(c.id) && c.requiredDoc !== "NONE");
        return (
          <div key={m.id} className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="consult-member">
            <div className="min-w-0">
              <p className="font-extrabold" style={{ color: m.color }}>
                {m.name} {m.isOwner ? <Badge>Owner</Badge> : null} {m.status === "INACTIVE" ? <Badge tone="warning">Inactive</Badge> : null}
              </p>
              <p className="text-sm text-ink-700">{[m.title, m.qualifications, m.experienceYears != null ? `${m.experienceYears} yrs` : null].filter(Boolean).join(" · ")}</p>
              <p className="text-xs text-ink-600">
                {data.categories.filter((c) => m.categoryIds.includes(c.id)).map((c) => c.name).join(", ") || "No category"} · 🗣 {m.languages.join(", ") || "—"} · {m.slotMinutes}-min slots, {m.bufferMinutes} min buffer
                {m.maxPerSlot > 1 ? `, ${m.maxPerSlot} per slot` : ""} {m.userEmail ? `· signs in as ${m.userEmail}` : ""}
              </p>
              {need.length ? (
                <p className="mt-1 text-xs">
                  {CONSULT_REQUIRED_DOC_LABELS[need[0].requiredDoc]}: <Badge tone={m.docStatus === "VERIFIED" ? "success" : m.docStatus === "SUBMITTED" ? "info" : "warning"}>{m.docStatus}</Badge> {m.registrationNumber ? `No. ${m.registrationNumber}` : ""}
                  {m.docNote ? ` — ${m.docNote}` : ""}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {need.length ? (
                <label className="inline-flex min-h-10 cursor-pointer items-center rounded-lg border border-cream-200 bg-white px-3 text-sm font-medium text-ink-700 hover:bg-cream-100">
                  {m.documents ? "Replace certificate" : "Upload certificate"}
                  <input type="file" className="sr-only" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadDoc(m.id, e.target.files[0])} data-testid="consult-member-doc" />
                </label>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => startEdit(m)}>
                Edit
              </Button>
            </div>
          </div>
        );
      })}
      {!editing ? (
        <div>
          <Button onClick={() => startEdit({ name: "", categoryIds: [], slotMinutes: 30, bufferMinutes: 0, maxPerSlot: 1, color: "#0f766e", status: "ACTIVE" })} data-testid="consult-add-member">
            + Add team member
          </Button>
        </div>
      ) : (
        <Panel title={editing.id ? `Edit ${editing.name}` : "New team member"}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Name">
              <input className={inputClass} value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="consult-member-name" />
            </Field>
            <Field label="Title">
              <input className={inputClass} value={editing.title ?? ""} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Senior Advocate, Dentist…" />
            </Field>
            <Field label="Qualifications">
              <input className={inputClass} value={editing.qualifications ?? ""} onChange={(e) => setEditing({ ...editing, qualifications: e.target.value })} placeholder="MBBS, MD / LLB / FCA" />
            </Field>
            <Field label="Experience (years)">
              <input className={inputClass} type="number" min={0} max={80} value={editing.experienceYears ?? ""} onChange={(e) => setEditing({ ...editing, experienceYears: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Languages (comma separated)">
              <input className={inputClass} value={langs} onChange={(e) => setLangs(e.target.value)} />
            </Field>
            <Field label="Their GoKesari e-mail (to run their own calendar)">
              <input className={inputClass} value={editing.userEmail ?? ""} onChange={(e) => setEditing({ ...editing, userEmail: e.target.value })} />
            </Field>
            <Field label="Registration number">
              <input className={inputClass} value={editing.registrationNumber ?? ""} onChange={(e) => setEditing({ ...editing, registrationNumber: e.target.value })} />
            </Field>
            <Field label="Registered with">
              <input className={inputClass} value={editing.registrationBody ?? ""} onChange={(e) => setEditing({ ...editing, registrationBody: e.target.value })} placeholder="Maharashtra Medical Council, Bar Council of Maharashtra & Goa, ICAI…" />
            </Field>
            <Field label="Slot length (minutes)">
              <input className={inputClass} type="number" min={5} max={480} value={editing.slotMinutes ?? 30} onChange={(e) => setEditing({ ...editing, slotMinutes: Number(e.target.value) })} />
            </Field>
            <Field label="Buffer after each (minutes)">
              <input className={inputClass} type="number" min={0} max={240} value={editing.bufferMinutes ?? 0} onChange={(e) => setEditing({ ...editing, bufferMinutes: Number(e.target.value) })} />
            </Field>
            <Field label="People per slot">
              <input className={inputClass} type="number" min={1} max={50} value={editing.maxPerSlot ?? 1} onChange={(e) => setEditing({ ...editing, maxPerSlot: Number(e.target.value) })} />
            </Field>
            <Field label="Calendar colour">
              <input type="color" className="h-11 w-20 rounded-lg border border-cream-200" value={editing.color ?? "#0f766e"} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
            </Field>
            <div className="sm:col-span-2">
              <p className="mb-1 text-sm font-medium text-ink-700">Categories</p>
              <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-lg border border-cream-200 p-2">
                {[...groups.entries()].map(([g, list]) => (
                  <div key={g}>
                    <p className="text-xs font-bold text-ink-600">{g}</p>
                    <div className="flex flex-wrap gap-1">
                      {list.map((c) => (
                        <Chip key={c.id} active={editing.categoryIds?.includes(c.id)} onClick={() => setEditing({ ...editing, categoryIds: editing.categoryIds?.includes(c.id) ? editing.categoryIds.filter((x) => x !== c.id) : [...(editing.categoryIds ?? []), c.id] })}>
                          {c.name}
                          {c.requiredDoc !== "NONE" ? " *" : ""}
                        </Chip>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-xs text-ink-600">* needs the professional registration certificate uploaded before publishing.</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.status !== "INACTIVE"} onChange={(e) => setEditing({ ...editing, status: e.target.checked ? "ACTIVE" : "INACTIVE" })} /> Taking bookings
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              disabled={busy}
              data-testid="consult-save-member"
              onClick={async () => {
                const ok = await post(
                  {
                    action: "member",
                    member: {
                      id: editing.id,
                      name: editing.name,
                      title: editing.title,
                      qualifications: editing.qualifications,
                      experienceYears: editing.experienceYears,
                      languages: langs.split(",").map((x) => x.trim()).filter(Boolean),
                      registrationNumber: editing.registrationNumber,
                      registrationBody: editing.registrationBody,
                      categoryIds: editing.categoryIds ?? [],
                      slotMinutes: editing.slotMinutes,
                      bufferMinutes: editing.bufferMinutes,
                      maxPerSlot: editing.maxPerSlot,
                      color: editing.color,
                      userEmail: editing.userEmail ?? undefined,
                      status: editing.status,
                    },
                  },
                  "Team member saved.",
                );
                if (ok) setEditing(null);
              }}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function ServicesForm({ data, busy, post }: { data: SetupData; busy: boolean; post: Post }) {
  const [editing, setEditing] = useState<ReturnType<typeof blankService> | null>(null);
  return (
    <div className="flex flex-col gap-3">
      {data.services.map((s) => (
        <div key={s.id} className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border-2 border-[var(--gk-line)] bg-white p-3" data-testid="consult-service-row">
          <div>
            <p className="font-extrabold text-ink-900">
              {s.name} {s.status === "INACTIVE" ? <Badge tone="warning">Hidden</Badge> : null}
            </p>
            <p className="text-sm text-ink-700">
              {s.durationMinutes} min · {s.feeType === "FREE" ? "Free" : s.feeType === "DEPOSIT" ? `${rupees(s.feePaise)}, advance ${rupees(s.depositPaise)}` : rupees(s.feePaise)} · {s.modes.map((m) => `${MODE_ICON[m]} ${modeLabel(m)}`).join(", ")}
            </p>
            <p className="text-xs text-ink-600">
              {s.bookingKind === "GROUP" ? `Group, up to ${s.capacity}` : s.bookingKind === "TEAM" ? `Team of ${s.requiredMembers}` : "One-to-one"} ·{" "}
              {s.memberIds.length ? data.members.filter((m) => s.memberIds.includes(m.id)).map((m) => m.name).join(", ") : "everyone"} · {[s.payOnline ? "online" : null, s.payAtVisit ? "at visit" : null].filter(Boolean).join(" or ") || "no payment"}
              {s.gstRateBp ? ` · GST ${s.gstRateBp / 100}% included` : ""}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setEditing({ ...s, feeRupees: s.feePaise / 100, depositRupees: s.depositPaise / 100, gstRatePct: s.gstRateBp / 100 })}>
            Edit
          </Button>
        </div>
      ))}
      {!editing ? (
        <div>
          <Button onClick={() => setEditing(blankService())} data-testid="consult-add-service">
            + Add service
          </Button>
        </div>
      ) : (
        <Panel title={editing.id ? `Edit ${editing.name}` : "New service"}>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Service name">
              <input className={inputClass} value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Consultation, Tax filing, Site visit…" data-testid="consult-service-name" />
            </Field>
            <Field label="Category">
              <select className={inputClass} value={editing.categoryId ?? ""} onChange={(e) => setEditing({ ...editing, categoryId: e.target.value || null })}>
                <option value="">—</option>
                {data.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Description (optional)">
              <input className={inputClass} value={editing.description ?? ""} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </Field>
            <Field label="Duration (minutes)">
              <input className={inputClass} type="number" min={5} max={600} value={editing.durationMinutes} onChange={(e) => setEditing({ ...editing, durationMinutes: Number(e.target.value) })} />
            </Field>
            <Field label="Fee">
              <select className={inputClass} value={editing.feeType} onChange={(e) => setEditing({ ...editing, feeType: e.target.value as Service["feeType"] })} data-testid="consult-fee-type">
                <option value="FREE">Free</option>
                <option value="FIXED">Fixed fee</option>
                <option value="DEPOSIT">Advance now, balance later</option>
              </select>
            </Field>
            {editing.feeType !== "FREE" ? (
              <Field label="Fee (₹, GST included)">
                <input className={inputClass} type="number" min={0} value={editing.feeRupees} onChange={(e) => setEditing({ ...editing, feeRupees: Number(e.target.value) })} data-testid="consult-fee" />
              </Field>
            ) : null}
            {editing.feeType === "DEPOSIT" ? (
              <Field label="Advance paid online (₹)">
                <input className={inputClass} type="number" min={0} value={editing.depositRupees} onChange={(e) => setEditing({ ...editing, depositRupees: Number(e.target.value) })} />
              </Field>
            ) : null}
            {data.shop.gstRegistered && editing.feeType !== "FREE" ? (
              <Field label="GST in the fee (%)" hint="Health care services are usually exempt (0%). Professional services 18%.">
                <input className={inputClass} type="number" min={0} max={28} value={editing.gstRatePct} onChange={(e) => setEditing({ ...editing, gstRatePct: Number(e.target.value) })} />
              </Field>
            ) : null}
            <div className="sm:col-span-2">
              <p className="mb-1 text-sm font-medium text-ink-700">How to meet</p>
              <div className="flex flex-wrap gap-1.5">
                {CONSULT_MODES.map((m) => (
                  <Chip key={m} active={editing.modes?.includes(m)} onClick={() => setEditing({ ...editing, modes: editing.modes?.includes(m) ? editing.modes.filter((x) => x !== m) : [...(editing.modes ?? []), m] })}>
                    {MODE_ICON[m]} {modeLabel(m)}
                  </Chip>
                ))}
              </div>
            </div>
            <Field label="Kind of booking">
              <select className={inputClass} value={editing.bookingKind} onChange={(e) => setEditing({ ...editing, bookingKind: e.target.value as Service["bookingKind"] })}>
                <option value="INDIVIDUAL">One-to-one</option>
                <option value="TEAM">Team (several consultants together)</option>
                <option value="GROUP">Group (class, workshop, family)</option>
              </select>
            </Field>
            {editing.bookingKind === "GROUP" ? (
              <Field label="Places per session">
                <input className={inputClass} type="number" min={2} max={500} value={editing.capacity} onChange={(e) => setEditing({ ...editing, capacity: Number(e.target.value) })} />
              </Field>
            ) : null}
            {editing.bookingKind === "TEAM" ? (
              <Field label="Consultants needed together">
                <input className={inputClass} type="number" min={2} max={20} value={editing.requiredMembers} onChange={(e) => setEditing({ ...editing, requiredMembers: Number(e.target.value) })} />
              </Field>
            ) : null}
            {data.members.length > 1 ? (
              <div className="sm:col-span-2">
                <p className="mb-1 text-sm font-medium text-ink-700">Offered by (none chosen: everyone)</p>
                <div className="flex flex-wrap gap-1.5">
                  {data.members.map((m) => (
                    <Chip key={m.id} active={editing.memberIds?.includes(m.id)} onClick={() => setEditing({ ...editing, memberIds: editing.memberIds?.includes(m.id) ? editing.memberIds.filter((x) => x !== m.id) : [...(editing.memberIds ?? []), m.id] })}>
                      {m.name}
                    </Chip>
                  ))}
                </div>
              </div>
            ) : null}
            {editing.feeType === "FIXED" ? (
              <div className="flex flex-wrap gap-3 sm:col-span-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.payOnline} onChange={(e) => setEditing({ ...editing, payOnline: e.target.checked })} /> Pay online when booking
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editing.payAtVisit} onChange={(e) => setEditing({ ...editing, payAtVisit: e.target.checked })} /> Pay at the visit
                </label>
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editing.status !== "INACTIVE"} onChange={(e) => setEditing({ ...editing, status: e.target.checked ? "ACTIVE" : "INACTIVE" })} /> Shown to customers
            </label>
          </div>
          <div className="mt-2 flex gap-2">
            <Button
              disabled={busy}
              data-testid="consult-save-service"
              onClick={async () => {
                const { feePaise: _f, depositPaise: _d, gstRateBp: _g, ...rest } = editing as Service & { feeRupees: number; depositRupees: number; gstRatePct: number };
                void _f;
                void _d;
                void _g;
                if (await post({ action: "service", service: rest }, "Service saved.")) setEditing(null);
              }}
            >
              Save service
            </Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

function HoursForm({ data, busy, post }: { data: SetupData; busy: boolean; post: Post }) {
  const [memberId, setMemberId] = useState(data.members[0]?.id ?? "");
  const rowsOf = (id: string) => (data.members.find((m) => m.id === id)?.hours ?? []).map((h) => ({ weekday: h.weekday, start: clock(h.startMinute), end: clock(h.endMinute) }));
  const [rows, setRows] = useState<{ weekday: number; start: string; end: string }[]>(() => rowsOf(memberId));
  const chooseMember = (id: string) => {
    setMemberId(id);
    setRows(rowsOf(id));
  };
  const today = istDateKey(new Date());
  const [off, setOff] = useState({ memberId: "", kind: "LEAVE", fromDate: today, toDate: today, fromTime: "13:00", toTime: "14:00", reason: "" });
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Panel title="Weekly hours">
        {data.members.length > 1 ? (
          <select className={`${inputClass} mb-2`} value={memberId} onChange={(e) => chooseMember(e.target.value)} aria-label="Consultant">
            {data.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : null}
        <div className="flex flex-col gap-1.5" data-testid="consult-hours">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => {
            const dayRows = rows.map((r, i) => ({ ...r, i })).filter((r) => r.weekday === d);
            return (
              <div key={d} className="flex flex-wrap items-center gap-1.5">
                <span className="w-10 text-sm font-bold">{WEEKDAY_SHORT[d]}</span>
                {dayRows.length ? null : <span className="text-xs text-ink-500">Closed</span>}
                {dayRows.map((r) => (
                  <span key={r.i} className="flex items-center gap-1">
                    <input className="min-h-10 w-24 rounded-lg border border-cream-200 px-1 text-sm" type="time" value={r.start} onChange={(e) => setRows(rows.map((x, j) => (j === r.i ? { ...x, start: e.target.value } : x)))} aria-label={`${WEEKDAY_SHORT[d]} from`} />
                    –
                    <input className="min-h-10 w-24 rounded-lg border border-cream-200 px-1 text-sm" type="time" value={r.end} onChange={(e) => setRows(rows.map((x, j) => (j === r.i ? { ...x, end: e.target.value } : x)))} aria-label={`${WEEKDAY_SHORT[d]} to`} />
                    <button type="button" className="px-1 text-red-700" onClick={() => setRows(rows.filter((_, j) => j !== r.i))} aria-label="Remove session">
                      ✕
                    </button>
                  </span>
                ))}
                <button type="button" className="rounded-lg border border-cream-200 px-2 text-xs font-bold" onClick={() => setRows([...rows, { weekday: d, start: dayRows.length ? "17:00" : "10:00", end: dayRows.length ? "20:00" : "13:00" }])}>
                  + session
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex gap-2">
          <Button disabled={busy || !memberId} onClick={() => post({ action: "hours", memberId, rows }, "Hours saved.")} data-testid="consult-save-hours">
            Save hours
          </Button>
          <Button variant="ghost" onClick={() => setRows([1, 2, 3, 4, 5, 6].flatMap((weekday) => [{ weekday, start: "10:00", end: "13:00" }, { weekday, start: "17:00", end: "20:00" }]))}>
            Mon–Sat 10–1, 5–8
          </Button>
        </div>
      </Panel>
      <Panel title="Leave, holidays and one-off changes">
        <div className="grid grid-cols-2 gap-2">
          <Field label="What">
            <select className={inputClass} value={off.kind} onChange={(e) => setOff({ ...off, kind: e.target.value, memberId: e.target.value === "HOLIDAY" ? "" : off.memberId || memberId })}>
              {Object.entries(CONSULT_TIME_OFF_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          {off.kind !== "HOLIDAY" ? (
            <Field label="Who">
              <select className={inputClass} value={off.memberId || memberId} onChange={(e) => setOff({ ...off, memberId: e.target.value })}>
                {data.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div />
          )}
          <Field label="From">
            <input className={inputClass} type="date" value={off.fromDate} min={today} onChange={(e) => setOff({ ...off, fromDate: e.target.value, toDate: off.toDate < e.target.value ? e.target.value : off.toDate })} />
          </Field>
          <Field label="To">
            <input className={inputClass} type="date" value={off.toDate} min={off.fromDate} onChange={(e) => setOff({ ...off, toDate: e.target.value })} />
          </Field>
          {off.kind === "BLOCK" || off.kind === "EXTRA" ? (
            <>
              <Field label="From time">
                <input className={inputClass} type="time" value={off.fromTime} onChange={(e) => setOff({ ...off, fromTime: e.target.value })} />
              </Field>
              <Field label="To time">
                <input className={inputClass} type="time" value={off.toTime} onChange={(e) => setOff({ ...off, toTime: e.target.value })} />
              </Field>
            </>
          ) : null}
          <Field label="Reason (optional)">
            <input className={inputClass} value={off.reason} onChange={(e) => setOff({ ...off, reason: e.target.value })} />
          </Field>
        </div>
        <Button className="mt-2" disabled={busy} onClick={() => post({ action: "time-off", timeOff: { ...off, memberId: off.kind === "HOLIDAY" ? null : off.memberId || memberId } }, "Saved.")} data-testid="consult-add-timeoff">
          Add
        </Button>
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {data.timeOff.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span>
                <strong>{CONSULT_TIME_OFF_LABELS[t.kind as keyof typeof CONSULT_TIME_OFF_LABELS]}</strong> {t.memberId ? `(${data.members.find((m) => m.id === t.memberId)?.name ?? ""})` : "(whole firm)"} {formatIst(t.startsAt)} → {formatIst(t.endsAt)}
                {t.reason ? ` — ${t.reason}` : ""}
              </span>
              <button type="button" className="text-red-700" onClick={() => post({ action: "time-off-delete", id: t.id }, "Removed.")} aria-label="Remove">
                ✕
              </button>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
