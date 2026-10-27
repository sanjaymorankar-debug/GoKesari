"use client";

/**
 * Shop type management: add a type, edit one staff added, switch it on or off.
 * Built-in types (from code) are listed read-only. Each form has one explicit
 * Save, like the shop categories screen.
 */

import { SectionTabs } from "@/components/board/section-tabs";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SaveChangesBar, postJson, useSaveChanges } from "@/components/save-changes-bar";
import { Alert, Badge, Button, Card, Field, inputClass } from "@/components/ui";

export interface ShopTypeRowView {
  key: string;
  label: string;
  standardGoods: string[];
  isFood: boolean;
  builtIn: boolean;
  status: "ACTIVE" | "INACTIVE";
  shopCount: number;
}

const goodsFromText = (text: string) =>
  text.split(/[,\n]/).map((g) => g.trim()).filter(Boolean);

export function ShopTypesAdmin({ types }: { types: ShopTypeRowView[] }) {
  const added = types.filter((t) => !t.builtIn);
  const builtIn = types.filter((t) => t.builtIn);
  return (
    <SectionTabs label="Shop types" labels={[`Added by staff (${added.length})`, `Built-in (${builtIn.length})`, "Add a shop type"]}>
      <section>
        <h2 className="sr-only">Added by staff</h2>
        <Card className="divide-y divide-cream-100">
          {added.length === 0 ? <p className="p-4 text-sm text-ink-500">No types added yet. Use “Add a shop type”.</p> : null}
          {added.map((t) => (
            <TypeEditRow key={t.key} type={t} />
          ))}
        </Card>
      </section>
      <section>
        <h2 className="sr-only">Built-in</h2>
        <Card className="divide-y divide-cream-100">
          {builtIn.map((t) => (
            <div key={t.key} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
              <span className="font-medium text-ink-900">{t.label}</span>
              <span className="text-ink-500">
                {t.isFood ? "Food · " : ""}
                {t.shopCount} shop{t.shopCount === 1 ? "" : "s"}
              </span>
            </div>
          ))}
        </Card>
      </section>
      <CreateType />
    </SectionTabs>
  );
}

function CreateType() {
  const router = useRouter();
  const empty = { label: "", goods: "", isFood: false };
  const [draft, setDraft] = useState(empty);
  const label = draft.label.trim();
  const dirty = draft.label !== "" || draft.goods !== "" || draft.isFood;

  const save = useSaveChanges({
    id: "shop-type:new",
    dirty: dirty && label.length >= 2,
    onSave: async () => {
      await postJson("/api/shop-types", "POST", {
        label,
        standardGoods: goodsFromText(draft.goods),
        isFood: draft.isFood,
      });
      setDraft(empty);
      router.refresh();
      return `Shop type added: ${label}`;
    },
  });

  return (
    <section>
      <h2 className="sr-only">Add a shop type</h2>
      <Card className="space-y-3 p-4">
        <Field label="Name">
          <input className={inputClass} value={draft.label} maxLength={80} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
        </Field>
        <Field label="Typical goods or services (comma separated, optional)">
          <textarea className={inputClass} rows={3} value={draft.goods} onChange={(e) => setDraft((d) => ({ ...d, goods: e.target.value }))} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-ink-700">
          <input type="checkbox" checked={draft.isFood} onChange={(e) => setDraft((d) => ({ ...d, isFood: e.target.checked }))} />
          Sells or prepares food (needs an FSSAI licence)
        </label>
        {dirty && label.length > 0 && label.length < 2 ? <Alert tone="danger">A shop type name needs at least 2 characters.</Alert> : null}
        <SaveChangesBar
          state={save}
          label="Save Changes"
          idleHint="Fill in a name to add a shop type."
          dirtyHint="Not added yet — press Save Changes."
          testId="shop-type-create-save"
        />
      </Card>
    </section>
  );
}

function TypeEditRow({ type }: { type: ShopTypeRowView }) {
  const router = useRouter();
  const initial = { label: type.label, goods: type.standardGoods.join(", "), isFood: type.isFood, status: type.status };
  const [baseline, setBaseline] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);

  const label = draft.label.trim();
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const clientError = label.length < 2 || label.length > 80 ? "A shop type name needs 2–80 characters." : null;

  const save = useSaveChanges({
    id: `shop-type:${type.key}`,
    dirty: dirty && !clientError,
    confirm: () =>
      draft.status !== baseline.status && draft.status === "INACTIVE"
        ? {
            title: `Deactivate "${baseline.label}"?`,
            lines: [`${type.shopCount} shop${type.shopCount === 1 ? "" : "s"} currently use it`],
            body: "Shops that already have this type keep it, but nobody can choose it for a new shop.",
            confirmLabel: "Yes, deactivate",
          }
        : null,
    onSave: async () => {
      await postJson(`/api/shop-types/${type.key}`, "PATCH", {
        label,
        standardGoods: goodsFromText(draft.goods),
        isFood: draft.isFood,
        status: draft.status,
      });
      const settled = { ...draft, label };
      setBaseline(settled);
      setDraft(settled);
      setEditing(false);
      router.refresh();
      return `Shop type updated: ${label}`;
    },
  });

  return (
    <div className="space-y-2 p-3 text-sm" data-testid="shop-type-row">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium text-ink-900">{baseline.label}</span>{" "}
          <Badge tone={baseline.status === "ACTIVE" ? "success" : "neutral"}>{baseline.status.toLowerCase()}</Badge>
          {baseline.isFood ? <Badge>food</Badge> : null}
          <span className="ml-2 text-ink-500">
            {type.shopCount} shop{type.shopCount === 1 ? "" : "s"}
          </span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            if (editing && dirty && !window.confirm("Discard your unsaved changes to this shop type?")) return;
            if (editing) setDraft(baseline);
            setEditing(!editing);
          }}
        >
          {editing ? "Close" : "Edit"}
        </Button>
      </div>
      {editing ? (
        <div className="space-y-3 rounded-lg bg-cream-50 p-3">
          <Field label="Name">
            <input className={inputClass} value={draft.label} maxLength={80} aria-label="Shop type name" onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
          </Field>
          <Field label="Typical goods or services (comma separated)">
            <textarea className={inputClass} rows={3} value={draft.goods} onChange={(e) => setDraft((d) => ({ ...d, goods: e.target.value }))} />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={draft.isFood} onChange={(e) => setDraft((d) => ({ ...d, isFood: e.target.checked }))} />
            Sells or prepares food (needs an FSSAI licence)
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" checked={draft.status === "ACTIVE"} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.checked ? "ACTIVE" : "INACTIVE" }))} />
            Active — can be chosen for a new shop
          </label>
          {clientError ? <Alert tone="danger">{clientError}</Alert> : null}
          <SaveChangesBar state={save} label="Save Changes" testId={`shop-type-save-${type.key}`}>
            <Button variant="ghost" disabled={!dirty || save.busy} onClick={() => setDraft(baseline)}>
              Discard
            </Button>
          </SaveChangesBar>
        </div>
      ) : null}
    </div>
  );
}
