/**
 * Retired checks. Adding a category used to fill the shop's inventory (NEW-009);
 * since docs/shop-product-setup-2026-11 it lists nothing, so these cases have no
 * behaviour left to check. They stay declared so the register shows why.
 */
import { manual } from "../lib/record";

const RETIRED = "retired: adding a category no longer creates listings (docs/shop-product-setup-2026-11)";

manual(
  [
    "TC-CAT-037", "TC-CAT-038", "TC-CAT-039", "TC-CAT-040", "TC-CAT-041", "TC-CAT-042", "TC-CAT-043",
    "TC-CAT-044", "TC-CAT-045", "TC-CAT-046", "TC-CAT-047", "TC-CAT-048", "TC-CAT-049", "TC-CAT-050",
    "TC-CAT-051", "TC-CAT-052", "TC-CAT-053", "TC-CAT-055", "TC-CAT-056",
  ],
  "adding a category fills the shop's inventory",
  RETIRED,
  { tier: "local" },
);
