/**
 * Shop staff roles and permissions (Module 10, docs/shop-staff-roles-2026-11).
 *
 * Shop-side only: what a person a shop owner added to their shop may do in
 * THAT shop. Not the platform's own staff roles (RBAC v2, rbac_v2_*).
 *
 * A permission is `<resource>.<action>`, plus two flags:
 *   financial_visibility  money figures: wallet, payouts, GST returns, invoices;
 *                         every billing.* permission needs it as well.
 *   config_access         shop settings: settings.create / edit / delete need it.
 *
 * Pure: no database, safe to import on the client (the staff manager's matrix).
 */

export const SHOP_STAFF_RESOURCES = [
  "catalogue",
  "inventory",
  "orders",
  "billing",
  "delivery",
  "customers",
  "settings",
  "staff",
  "reports",
] as const;
export type ShopStaffResource = (typeof SHOP_STAFF_RESOURCES)[number];

export const SHOP_STAFF_ACTIONS = ["view", "create", "edit", "delete", "approve", "cancel", "export"] as const;
export type ShopStaffAction = (typeof SHOP_STAFF_ACTIONS)[number];

export const SHOP_STAFF_FLAGS = ["financial_visibility", "config_access"] as const;
export type ShopStaffFlag = (typeof SHOP_STAFF_FLAGS)[number];

export type ShopStaffPermission = `${ShopStaffResource}.${ShopStaffAction}` | ShopStaffFlag;

export const ALL_SHOP_STAFF_PERMISSIONS: readonly ShopStaffPermission[] = [
  ...SHOP_STAFF_RESOURCES.flatMap((r) => SHOP_STAFF_ACTIONS.map((a) => `${r}.${a}` as ShopStaffPermission)),
  ...SHOP_STAFF_FLAGS,
];

const PERMISSION_SET = new Set<string>(ALL_SHOP_STAFF_PERMISSIONS);

export function isShopStaffPermission(value: unknown): value is ShopStaffPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export const SHOP_STAFF_ROLES = [
  "MANAGER",
  "CATALOGUE_MANAGER",
  "ORDER_MANAGER",
  "BILLING_MANAGER",
  "INVENTORY_MANAGER",
  "DELIVERY_MANAGER",
  "CUSTOMER_SUPPORT",
  "CUSTOM",
] as const;
export type ShopStaffRole = (typeof SHOP_STAFF_ROLES)[number];

/** The role every row had before Module 10 (scope CATALOGUE): product photos and descriptions. */
export const LEGACY_CATALOGUE_ROLE: ShopStaffRole = "CATALOGUE_MANAGER";

export function isShopStaffRole(value: unknown): value is ShopStaffRole {
  return typeof value === "string" && (SHOP_STAFF_ROLES as readonly string[]).includes(value);
}

const all = (resource: ShopStaffResource, actions: readonly ShopStaffAction[] = SHOP_STAFF_ACTIONS) =>
  actions.map((a) => `${resource}.${a}` as ShopStaffPermission);

/**
 * Preset roles. The owner is implicit (every permission) and has no row.
 * MANAGER: everything except settings changes (needs config_access, granted
 * per person) and staff deletion; may add and change staff, but never another
 * MANAGER, and only with permissions they hold themselves (canGrant).
 */
export const SHOP_STAFF_ROLE_PRESETS: Record<Exclude<ShopStaffRole, "CUSTOM">, readonly ShopStaffPermission[]> = {
  MANAGER: [
    ...all("catalogue"),
    ...all("inventory"),
    ...all("orders"),
    ...all("billing"),
    ...all("delivery"),
    ...all("customers"),
    ...all("reports"),
    "settings.view",
    "staff.view",
    "staff.create",
    "staff.edit",
    "financial_visibility",
  ],
  CATALOGUE_MANAGER: [...all("catalogue", ["view", "create", "edit", "delete"]), "inventory.view"],
  ORDER_MANAGER: [...all("orders", ["view", "edit", "approve", "cancel"]), "delivery.view", "customers.view"],
  BILLING_MANAGER: [
    ...all("billing", ["view", "create", "edit", "export"]),
    ...all("reports", ["view", "export"]),
    "orders.view",
    "financial_visibility",
  ],
  INVENTORY_MANAGER: [...all("inventory", ["view", "create", "edit"]), "catalogue.view"],
  DELIVERY_MANAGER: [...all("delivery", ["view", "create", "edit", "approve", "cancel"]), "orders.view"],
  CUSTOMER_SUPPORT: [...all("customers", ["view", "edit"]), "orders.view"],
};

export const SHOP_STAFF_ROLE_LABELS: Record<ShopStaffRole, string> = {
  MANAGER: "Manager",
  CATALOGUE_MANAGER: "Catalogue manager",
  ORDER_MANAGER: "Order manager",
  BILLING_MANAGER: "Billing manager",
  INVENTORY_MANAGER: "Inventory manager",
  DELIVERY_MANAGER: "Delivery manager",
  CUSTOMER_SUPPORT: "Customer support",
  CUSTOM: "Custom",
};

export const SHOP_STAFF_RESOURCE_LABELS: Record<ShopStaffResource, string> = {
  catalogue: "Catalogue",
  inventory: "Inventory / stock",
  orders: "Orders",
  billing: "Billing / finance",
  delivery: "Delivery",
  customers: "Customers / support",
  settings: "Shop settings",
  staff: "Staff",
  reports: "Reports",
};

/** Sanitises a stored or submitted list: known permissions only, no duplicates, stable order. */
export function normalisePermissions(list: readonly unknown[] | null | undefined): ShopStaffPermission[] {
  const wanted = new Set((list ?? []).filter(isShopStaffPermission));
  return ALL_SHOP_STAFF_PERMISSIONS.filter((p) => wanted.has(p));
}

/**
 * What a staff row grants: the role's preset plus any extra grants
 * (`permissions`), or for CUSTOM the explicit list alone.
 */
export function effectivePermissions(role: string | null | undefined, extra: readonly unknown[] | null | undefined): ShopStaffPermission[] {
  const r = isShopStaffRole(role) ? role : LEGACY_CATALOGUE_ROLE;
  const base = r === "CUSTOM" ? [] : SHOP_STAFF_ROLE_PRESETS[r];
  return normalisePermissions([...base, ...(extra ?? [])]);
}

/** The flag a permission also needs, if any. */
export function requiredFlagFor(permission: ShopStaffPermission): ShopStaffFlag | null {
  if (permission.startsWith("billing.")) return "financial_visibility";
  if (permission === "settings.create" || permission === "settings.edit" || permission === "settings.delete") return "config_access";
  return null;
}

/** Whether a set of permissions allows `permission` (with its flag). */
export function permissionAllows(held: readonly ShopStaffPermission[], permission: ShopStaffPermission): boolean {
  if (!held.includes(permission)) return false;
  const flag = requiredFlagFor(permission);
  return flag ? held.includes(flag) : true;
}

/** Whether this role/extra combination allows `permission`. */
export function roleAllows(role: string | null | undefined, extra: readonly unknown[] | null | undefined, permission: ShopStaffPermission): boolean {
  return permissionAllows(effectivePermissions(role, extra), permission);
}

/**
 * Whether a staff manager holding `granterPermissions` may give someone
 * `role` + `extra` (no escalation): never MANAGER, and nothing they do not
 * hold themselves. The owner (granterPermissions = null) may give anything.
 */
export function canGrant(
  granterPermissions: readonly ShopStaffPermission[] | null,
  role: ShopStaffRole,
  extra: readonly unknown[] | null | undefined,
): boolean {
  if (granterPermissions === null) return true;
  if (role === "MANAGER") return false;
  return effectivePermissions(role, extra).every((p) => granterPermissions.includes(p));
}

/** Board sections a staff member sees, in board order. */
export const SHOP_STAFF_SECTIONS: readonly { key: ShopStaffResource; permission: ShopStaffPermission }[] = [
  { key: "orders", permission: "orders.view" },
  { key: "catalogue", permission: "catalogue.edit" },
  { key: "inventory", permission: "inventory.view" },
  { key: "delivery", permission: "delivery.view" },
  { key: "customers", permission: "customers.view" },
  { key: "billing", permission: "billing.view" },
  { key: "reports", permission: "reports.view" },
  { key: "settings", permission: "settings.view" },
  { key: "staff", permission: "staff.view" },
];

export function visibleSections(held: readonly ShopStaffPermission[]): ShopStaffResource[] {
  return SHOP_STAFF_SECTIONS.filter((s) => permissionAllows(held, s.permission)).map((s) => s.key);
}
