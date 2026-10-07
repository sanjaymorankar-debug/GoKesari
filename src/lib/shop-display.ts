/**
 * How a shop is written on customer screens. Pure — safe on client and server.
 */

/**
 * A shop's name as typed by its owner, with words left entirely in lower case
 * given a capital ("Asmy super market" → "Asmy Super Market"). Words that
 * already carry a capital anywhere ("eBay", "DMart", "ASMY") are not touched,
 * so a deliberate spelling survives. Display only: the stored name, and
 * everything that matches on it, is unchanged.
 */
export function displayShopName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) =>
      /^\p{Ll}/u.test(word) && word === word.toLowerCase()
        ? word.charAt(0).toUpperCase() + word.slice(1)
        : word,
    )
    .join(" ");
}

/** Days a newly approved shop carries the "New" badge. */
export const NEW_SHOP_DAYS = 30;

export function isNewShop(createdAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!createdAt) return false;
  const created = typeof createdAt === "string" ? new Date(createdAt) : createdAt;
  const age = now.getTime() - created.getTime();
  return age >= 0 && age <= NEW_SHOP_DAYS * 86_400_000;
}
