import { and, eq, isNull } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";

import { VoicePriceAssistant } from "@/components/voice-price-assistant";
import { Alert, LinkButton, PageHeader } from "@/components/ui";
import { tr, L } from "@/lib/board/i18n";
import type { VoiceLang } from "@/lib/voice-input";
import { getCurrentUser } from "@/server/authz/guards";
import { getBoardLang } from "@/server/board-lang";
import { db } from "@/server/db";
import { shops } from "@/server/db/schema";
import { isFeatureEnabledForShop } from "@/server/services/feature-flags";
import { resolveCatalogueShop } from "@/server/services/shop-staff";
import { VOICE_PRICE_FLAG } from "@/server/services/voice-price-assistant";

export const metadata = { title: "Change price or offer by voice" };
export const dynamic = "force-dynamic";

const TITLE = L("Change price or offer by voice", "आवाज़ से कीमत या ऑफ़र बदलें", "आवाजाने किंमत किंवा ऑफर बदला");
const DESCRIPTION = L(
  "Say the product and the new price or discount, check what GoKesari understood, then say yes.",
  "उत्पाद और नई कीमत या छूट बोलें, GoKesari ने क्या समझा देखें, फिर “हाँ” कहें।",
  "उत्पादन आणि नवीन किंमत किंवा सूट सांगा, GoKesari ला काय समजले ते पाहा, मग “हो” म्हणा.",
);
const OWNER_ONLY = L(
  "Only the shop's owner can change prices and offers by voice.",
  "आवाज़ से कीमत और ऑफ़र केवल दुकान के मालिक बदल सकते हैं।",
  "आवाजाने किंमत आणि ऑफर फक्त दुकानाचे मालक बदलू शकतात.",
);

/** The speech language a shop most likely speaks, from its state (the owner can change it on the page). */
function speechLangFor(state: string | null, boardLang: string): VoiceLang {
  const s = (state ?? "").toLowerCase();
  if (s.includes("maharashtra") || s.includes("goa")) return "mr-IN";
  if (s.includes("gujarat")) return "gu-IN";
  if (s.includes("karnataka")) return "kn-IN";
  if (s.includes("tamil")) return "ta-IN";
  if (s.includes("telangana") || s.includes("andhra")) return "te-IN";
  if (s.includes("bengal") || s.includes("tripura")) return "bn-IN";
  return boardLang === "mr" ? "mr-IN" : boardLang === "en" ? "en-IN" : "hi-IN";
}

/** docs/smart-shopping-2026-11/FEATURE4_VOICE_PRICE_OFFERS.md — hidden (404) while voice_price_assistant_enabled is off. */
export default async function VoicePricePage({ searchParams }: { searchParams: Promise<{ shopId?: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/shop/voice-price");
  const { shopId } = await searchParams;
  const resolved = await resolveCatalogueShop(user, shopId);
  if (!resolved) redirect("/shop");
  const [shop] = await db
    .select({ id: shops.id, ownerId: shops.ownerId, pincode: shops.pincode, state: shops.state })
    .from(shops)
    .where(and(eq(shops.id, resolved.shopId), isNull(shops.deletedAt)));
  if (!shop || !(await isFeatureEnabledForShop(VOICE_PRICE_FLAG, shop))) notFound();
  const lang = await getBoardLang();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={tr(TITLE, lang)}
        description={`${resolved.shopName} — ${tr(DESCRIPTION, lang)}`}
        action={
          <LinkButton href="/shop/inventory" variant="secondary">
            {lang === "en" ? "Back" : lang === "hi" ? "वापस" : "मागे"}
          </LinkButton>
        }
      />
      {shop.ownerId === user.id ? (
        <VoicePriceAssistant shopId={shop.id} lang={lang} defaultSpeechLang={speechLangFor(shop.state, lang)} />
      ) : (
        <Alert tone="warning">{tr(OWNER_ONLY, lang)}</Alert>
      )}
    </div>
  );
}
