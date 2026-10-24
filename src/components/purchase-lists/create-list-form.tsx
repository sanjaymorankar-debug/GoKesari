"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, Field, inputClass } from "@/components/ui";
import { FREQUENCY_LABEL, KIND_EMOJI, KIND_LABEL, LIST_LIMITS, type ListFrequency, type ListKind } from "@/lib/purchase-lists";

const NAME_HINT: Record<ListKind, string> = {
  SHOPPING: "e.g. Monthly groceries, Weekly dairy",
  MEDICINE: "e.g. Papa's BP medicines, Monthly vitamins",
};

/** A two- or three-way choice as large tap targets (works the same on a phone). */
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
  name,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium text-ink-700">{label}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup">
        {options.map((option) => (
          <label
            key={option.value}
            className={`flex min-h-11 cursor-pointer items-center rounded-lg border px-3 text-sm font-medium ${
              value === option.value ? "border-kesari-500 bg-kesari-50 text-kesari-800" : "border-cream-200 text-ink-700 hover:border-kesari-300"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function CreateListForm({ defaultKind = "SHOPPING" }: { defaultKind?: ListKind }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ListKind>(defaultKind);
  const [frequency, setFrequency] = useState<ListFrequency>("MONTHLY");
  const [remind, setRemind] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/purchase-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, kind, frequency, remind }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(payload?.error?.message ?? "Could not create the list.");
        setBusy(false);
        return;
      }
      // Stays busy while the new list opens, so a second tap cannot create it twice.
      router.push(`/lists/${payload.id}`);
    } catch {
      setError("Could not create the list. Check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="create-list-form">
      <Choice
        label="What is it for?"
        name="list-kind"
        value={kind}
        onChange={setKind}
        options={(["SHOPPING", "MEDICINE"] as const).map((k) => ({ value: k, label: `${KIND_EMOJI[k]} ${KIND_LABEL[k]}` }))}
      />
      <Field label="List name" hint={NAME_HINT[kind]}>
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={LIST_LIMITS.nameLength}
          required
          name="list-name"
          placeholder={NAME_HINT[kind].replace(/^e\.g\. /, "").split(",")[0]}
        />
      </Field>
      <Choice
        label="How often do you buy it?"
        name="list-frequency"
        value={frequency}
        onChange={setFrequency}
        options={(["WEEKLY", "MONTHLY"] as const).map((f) => ({ value: f, label: FREQUENCY_LABEL[f] }))}
      />
      <label className="flex min-h-11 items-center gap-2 text-sm text-ink-700">
        <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} className="h-4 w-4" />
        Remind me when it is due again
      </label>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={busy || !name.trim()} className="w-full">
        {busy ? "Creating…" : "Create list"}
      </Button>
    </form>
  );
}
