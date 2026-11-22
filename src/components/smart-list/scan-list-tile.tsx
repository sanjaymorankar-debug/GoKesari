import Link from "next/link";

import { tr, type Lang } from "@/lib/board/i18n";

const TEXT = {
  title: { en: "Scan my shopping list", hi: "मेरी खरीदारी सूची स्कैन करें", mr: "माझी खरेदी यादी स्कॅन करा" },
  body: {
    en: "Photo of your written list → we read it, compare prices at shops near you, you pick one.",
    hi: "लिखी हुई सूची की फोटो → हम पढ़ेंगे, पास की दुकानों के दाम मिलाएँगे, आप दुकान चुनें।",
    mr: "लिहिलेल्या यादीचा फोटो → आम्ही वाचू, जवळच्या दुकानांचे दर तुलना करू, तुम्ही दुकान निवडा.",
  },
};

/**
 * docs/smart-shopping-2026-11 (Feature 1): the "Scan my list" tile on the customer home (Tile Board and the
 * discovery home) and in the cart. Shown only while flag smart_list_scan_enabled is on (the caller checks).
 */
export function ScanListTile({ lang, compact = false }: { lang: Lang; compact?: boolean }) {
  return (
    <Link
      href="/wishlist/scan"
      data-testid="scan-list-tile"
      className={`flex items-center gap-3 rounded-2xl border-2 border-kesari-600 bg-kesari-50 ${compact ? "p-3" : "p-4"} hover:shadow-md`}
    >
      <span aria-hidden className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-white text-2xl shadow-sm">
        📸
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-extrabold text-ink-900">{tr(TEXT.title, lang)}</span>
        {compact ? null : <span className="block text-sm text-ink-700">{tr(TEXT.body, lang)}</span>}
      </span>
      <span aria-hidden className="text-xl font-bold text-kesari-700">
        →
      </span>
    </Link>
  );
}
