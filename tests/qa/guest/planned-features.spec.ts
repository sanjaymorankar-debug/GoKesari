/**
 * Cases and journeys for features that are planned but not built yet (20-Nov-2026,
 * docs/testing/manual/README.md): onboarding Wave 2 / 3 (WP6 … WP10) and the R3 items
 * D-130, D-136, D-138, D-141, D-144. They are in the plan so the manual workbook and the
 * register list them; each is declared here as manual with the release it waits for.
 * When a feature reaches test.gokesari.com, check its cases against the built screens
 * and replace its manual() lines with real checks.
 */
import { manual } from "../lib/record";

// Planned - R4 / WP6, not built yet (20-Nov-2026)
manual("TC-ONB-089", "No code? Find the dealer who covers my PIN and use their code in one tap", "feature not on staging yet (R4 – WP6)", { tier: "guest" });
manual("TC-ONB-090", "A dealer's phone is shown only through a Call button to a signed-in owner", "feature not on staging yet (R4 – WP6)", { tier: "guest" });
manual("TC-ONB-091", "No dealer for the PIN: district distributor, else request a code and resume", "feature not on staging yet (R4 – WP6)", { tier: "guest" });
manual("TC-ONB-092", "One PIN suggestion per draft; the dealer is told", "feature not on staging yet (R4 – WP6)", { tier: "guest" });

// Planned - R4 / WP7, not built yet (20-Nov-2026)
manual("TC-ONB-093", "Assisted registration: a dealer registers a shop with the owner's consent", "feature not on staging yet (R4 – WP7)", { tier: "guest" });
manual("TC-ONB-094", "The owner always pays; the helper never can", "feature not on staging yet (R4 – WP7)", { tier: "guest" });
manual("TC-ONB-095", "Expired consent stops the helper", "feature not on staging yet (R4 – WP7)", { tier: "guest" });
manual("TC-ONB-096", "Only dealers and operators can assist, and only on drafts they started", "feature not on staging yet (R4 – WP7)", { tier: "guest" });
manual("TC-ONB-097", "Old dealer / operator flat forms are retired after a clean week", "feature not on staging yet (R4 – WP7)", { tier: "guest" });

// Planned - R4 / WP8, not built yet (20-Nov-2026)
manual("TC-ONB-098", "Every onboarding screen in Hindi and Marathi, and the choice is remembered", "feature not on staging yet (R4 – WP8)", { tier: "guest" });
manual("TC-ONB-099", "Missing translations fall back to English, never blank; numbers stay in Latin digits", "feature not on staging yet (R4 – WP8)", { tier: "guest" });
manual("TC-ONB-100", "Onboarding e-mails, in-app notices and the sign-in code e-mail use the owner's language", "feature not on staging yet (R4 – WP8)", { tier: "guest" });

// Planned - R5 / WP9, not built yet (20-Nov-2026)
manual("TC-AUTH-055", "Sign in with a 6-digit SMS code", "feature not on staging yet (R5 – WP9)", { tier: "guest" });
manual("TC-AUTH-056", "SMS code limits: wrong, expired, resend and tries", "feature not on staging yet (R5 – WP9)", { tier: "guest" });
manual("TC-AUTH-057", "SMS failing twice offers e-mail", "feature not on staging yet (R5 – WP9)", { tier: "guest" });

// Planned - R5 / WP10, not built yet (20-Nov-2026)
manual("TC-ONB-101", "Scan-first on phones: take a photo of GST / PAN / Udyam / FSSAI", "feature not on staging yet (R5 – WP10)", { tier: "guest" });
manual("TC-ONB-102", "Camera permission in the Android and iOS app", "feature not on staging yet (R5 – WP10)", { tier: "guest" });
manual("TC-ONB-103", "PAN-only shop confirms identity with DigiLocker", "feature not on staging yet (R5 – WP10)", { tier: "guest" });
manual("TC-ONB-104", "Status chips explain each document check", "feature not on staging yet (R5 – WP10)", { tier: "guest" });

// Planned - R3 / D-144, not built yet (20-Nov-2026)
manual("TC-CAT-093", "Upload a shop logo file (checked like product photos)", "feature not on staging yet (R3 – D-144)", { tier: "guest" });

// Planned - R3 / D-138, not built yet (20-Nov-2026)
manual("TC-UX-011", "Home pages paint within 2.5 s on a mid-range phone", "feature not on staging yet (R3 – D-138)", { tier: "guest" });

// Planned - R3 / D-141, not built yet (20-Nov-2026)
manual("TC-ADM-022", "Long admin lists are paged on a phone with 44 px targets", "feature not on staging yet (R3 – D-141)", { tier: "guest" });

// Planned - R3 / D-130, not built yet (20-Nov-2026)
manual("TC-RBAC-025", "Seller pages use one access rule, with a message instead of a silent jump home", "feature not on staging yet (R3 – D-130)", { tier: "guest" });

// Planned - R3 / D-136, not built yet (20-Nov-2026)
manual("TC-CART-031", "A guest's item is in the cart after signing in", "feature not on staging yet (R3 – D-136)", { tier: "guest" });

// Planned - R4, not built yet (20-Nov-2026)
manual("SC-46", "Assisted registration: a dealer registers a shop and the owner pays on their phone (planned WP7)", "feature not on staging yet (R4 – WP7, WP6)", { tier: "guest" });

// Planned - R4 / R5, not built yet (20-Nov-2026)
manual("SC-47", "PAN-only owner registers on a phone in Marathi with scan and DigiLocker (planned WP8, WP10)", "feature not on staging yet (R4 / R5 – WP8, WP10, WP6)", { tier: "guest" });
