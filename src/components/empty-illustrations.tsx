/**
 * Empty-state pictures (docs/homepage-uiux-2026-10, F3): small inline SVGs in
 * the theme's own colours (CSS variables), so they cost no request and match
 * every page. Decorative — the heading beside them carries the meaning.
 */
const FILL = "var(--color-kesari-100)";
const LINE = "var(--color-kesari-700)";
const SOFT = "var(--gk-chip, #fff4e8)";
const LEAF = "var(--color-leaf-600)";

function Frame({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <svg viewBox="0 0 160 120" width="160" height="120" aria-hidden focusable="false" data-illustration={label} className="mx-auto h-28 w-auto sm:h-32">
      <ellipse cx="80" cy="108" rx="56" ry="7" fill={SOFT} />
      {children}
    </svg>
  );
}

export type IllustrationName = "basket" | "orders" | "calendar" | "wallet" | "search";

export function EmptyIllustration({ name }: { name: IllustrationName }) {
  switch (name) {
    case "basket":
      return (
        <Frame label="basket">
          <path d="M38 52h84l-9 46a6 6 0 0 1-6 5H53a6 6 0 0 1-6-5Z" fill={FILL} stroke={LINE} strokeWidth="3" strokeLinejoin="round" />
          <path d="M56 52 70 26M104 52 90 26" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
          <path d="M33 52h94" stroke={LINE} strokeWidth="4" strokeLinecap="round" />
          <path d="M64 66v24M80 66v24M96 66v24" stroke={LINE} strokeWidth="3" strokeLinecap="round" opacity=".5" />
          <circle cx="124" cy="30" r="9" fill={LEAF} opacity=".85" />
          <path d="M120 30h8M124 26v8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
        </Frame>
      );
    case "orders":
      return (
        <Frame label="orders">
          <path d="M80 22 120 42v40L80 102 40 82V42Z" fill={FILL} stroke={LINE} strokeWidth="3" strokeLinejoin="round" />
          <path d="M40 42 80 62l40-20M80 62v40" stroke={LINE} strokeWidth="3" strokeLinejoin="round" />
          <path d="m60 32 40 20" stroke={LINE} strokeWidth="3" opacity=".5" />
        </Frame>
      );
    case "calendar":
      return (
        <Frame label="calendar">
          <rect x="38" y="30" width="84" height="70" rx="8" fill={FILL} stroke={LINE} strokeWidth="3" />
          <path d="M38 48h84M58 22v16M102 22v16" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
          <path d="M58 62h8M76 62h8M94 62h8M58 78h8M76 78h8" stroke={LINE} strokeWidth="4" strokeLinecap="round" opacity=".5" />
          <circle cx="98" cy="80" r="11" fill={LEAF} opacity=".9" />
          <path d="m93 80 4 4 6-7" stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </Frame>
      );
    case "wallet":
      return (
        <Frame label="wallet">
          <rect x="34" y="36" width="92" height="64" rx="10" fill={FILL} stroke={LINE} strokeWidth="3" />
          <path d="M34 50h92" stroke={LINE} strokeWidth="3" />
          <rect x="96" y="62" width="30" height="20" rx="6" fill="#fff" stroke={LINE} strokeWidth="3" />
          <circle cx="106" cy="72" r="3.5" fill={LINE} />
          <path d="M50 26h44" stroke={LINE} strokeWidth="3" strokeLinecap="round" opacity=".5" />
        </Frame>
      );
    case "search":
      return (
        <Frame label="search">
          <circle cx="72" cy="58" r="28" fill={FILL} stroke={LINE} strokeWidth="3.5" />
          <path d="m93 79 22 22" stroke={LINE} strokeWidth="6" strokeLinecap="round" />
          <path d="M62 52h20M62 64h12" stroke={LINE} strokeWidth="3" strokeLinecap="round" opacity=".5" />
        </Frame>
      );
  }
}
