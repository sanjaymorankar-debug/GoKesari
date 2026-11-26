/**
 * Rider App v2 Home (rule riderAppV2): shortcut tiles, the daily / weekly
 * incentive ladder and the important messages. Server components (plain
 * links); the high-earning banner with its Go online button is in
 * ./high-earning-banner.tsx.
 */
import Link from "next/link";
import clsx from "clsx";

import { Icon, type IconName } from "@/components/board/icons";
import { TONE_CHIP } from "@/components/board/tiles";
import { Card, Money } from "@/components/ui";
import { L, tr, type Lang } from "@/lib/board/i18n";
import { formatPaiseCompact } from "@/lib/money";
import type { Tone } from "@/lib/board/menus";
import type { IncentiveLadder, RiderMessage } from "@/server/services/rider-home";

const T = {
  shortcuts: L("Shortcuts", "शॉर्टकट", "शॉर्टकट"),
  offers: L("Offers & Incentives", "ऑफ़र और इंसेंटिव", "ऑफर आणि इन्सेंटिव्ह"),
  zone: L("My Zone", "मेरा ज़ोन", "माझा झोन"),
  insurance: L("Insurance", "बीमा", "विमा"),
  idCard: L("ID Card", "आईडी कार्ड", "ओळखपत्र"),
  ladderDay: L("Today's incentive", "आज का इंसेंटिव", "आजचा इन्सेंटिव्ह"),
  ladderWeek: L("This week's incentive", "इस हफ़्ते का इंसेंटिव", "या आठवड्याचा इन्सेंटिव्ह"),
  tripsDone: L("{n} trips done", "{n} ट्रिप पूरी", "{n} ट्रिप पूर्ण"),
  oneTripDone: L("1 trip done", "1 ट्रिप पूरी", "1 ट्रिप पूर्ण"),
  next: L("{n} more trips to earn {amount}", "{amount} कमाने के लिए {n} और ट्रिप", "{amount} मिळवण्यासाठी आणखी {n} ट्रिप"),
  nextOne: L("1 more trip to earn {amount}", "{amount} कमाने के लिए 1 और ट्रिप", "{amount} मिळवण्यासाठी आणखी 1 ट्रिप"),
  allDone: L("All steps unlocked — well done!", "सभी स्टेप खुल गए — शाबाश!", "सर्व टप्पे पूर्ण — छान!"),
  trips: L("{n} trips", "{n} ट्रिप", "{n} ट्रिप"),
  unlocked: L("Unlocked", "खुला", "मिळाले"),
  locked: L("Locked", "बंद", "बाकी"),
  messages: L("Important messages", "ज़रूरी संदेश", "महत्त्वाचे संदेश"),
  seeAll: L("See all", "सभी देखें", "सर्व पाहा"),
  newMsg: L("New", "नया", "नवीन"),
} as const;

const TILES: { href: string; label: keyof typeof T; icon: IconName; tone: Tone }[] = [
  { href: "/delivery-partner/earnings#incentives", label: "offers", icon: "badge-percent", tone: "kesari" },
  { href: "/delivery-partner/zone", label: "zone", icon: "map-pin", tone: "teal" },
  { href: "/delivery-partner/insurance", label: "insurance", icon: "shield-check", tone: "blue" },
  { href: "/gig/id-card", label: "idCard", icon: "badge-check", tone: "violet" },
];

export function RiderShortcutTiles({ lang }: { lang: Lang }) {
  return (
    <nav aria-label={tr(T.shortcuts, lang)} data-testid="rider-shortcuts">
      <ul className="grid grid-cols-4 gap-2">
        {TILES.map((tile) => (
          <li key={tile.href}>
            <Link
              href={tile.href}
              className="flex h-full min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl border border-cream-200 bg-white p-2 text-center text-xs font-semibold leading-tight text-ink-800 shadow-sm hover:bg-cream-50"
            >
              <span className={clsx("grid h-9 w-9 place-items-center rounded-full", TONE_CHIP[tile.tone])}>
                <Icon name={tile.icon} size={20} />
              </span>
              {tr(T[tile.label], lang)}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function IncentiveLadderCard({ ladder, lang }: { ladder: IncentiveLadder; lang: Lang }) {
  const nextLeft = ladder.next ? ladder.next.target - ladder.trips : 0;
  const top = ladder.steps[ladder.steps.length - 1]?.target || 1;
  return (
    <Card className="p-4" data-testid={`incentive-ladder-${ladder.period.toLowerCase()}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{tr(ladder.period === "DAY" ? T.ladderDay : T.ladderWeek, lang)}</h2>
        <p className="text-sm font-semibold text-ink-900">
          {ladder.trips === 1 ? tr(T.oneTripDone, lang) : tr(T.tripsDone, lang).replace("{n}", String(ladder.trips))}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-cream-100" aria-hidden>
        <div className="h-full rounded-full bg-kesari-600" style={{ width: `${Math.min(100, Math.round((ladder.trips / top) * 100))}%` }} />
      </div>
      <ol className="mt-3 space-y-1.5">
        {ladder.steps.map((step) => (
          <li
            key={step.id}
            className={clsx(
              "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm",
              step.unlocked ? "bg-green-50 text-green-900" : "bg-cream-50 text-ink-700",
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Icon name={step.unlocked ? "circle-check" : "lock"} size={16} className={step.unlocked ? "text-green-700" : "text-ink-500"} />
              <span className="truncate">{tr(T.trips, lang).replace("{n}", String(step.target))}</span>
              <span className="sr-only">{tr(step.unlocked ? T.unlocked : T.locked, lang)}</span>
            </span>
            <span className="font-semibold">
              +<Money paise={step.rewardPaise} />
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm font-medium text-kesari-800">
        {ladder.next
          ? (nextLeft === 1 ? tr(T.nextOne, lang) : tr(T.next, lang).replace("{n}", String(nextLeft))).replace(
              "{amount}",
              formatPaiseCompact(ladder.next.rewardPaise),
            )
          : tr(T.allDone, lang)}
      </p>
    </Card>
  );
}

export function ImportantMessages({ messages, lang }: { messages: RiderMessage[]; lang: Lang }) {
  if (messages.length === 0) return null;
  return (
    <Card className="p-4" data-testid="rider-messages">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">{tr(T.messages, lang)}</h2>
        <Link href="/notifications" className="text-sm font-medium text-kesari-700 underline">
          {tr(T.seeAll, lang)}
        </Link>
      </div>
      <ul className="divide-y divide-cream-100">
        {messages.map((m) => (
          <li key={m.id} className="py-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              {m.unread ? <span className="rounded-full bg-kesari-700 px-1.5 py-0.5 text-[0.625rem] font-bold uppercase text-white">{tr(T.newMsg, lang)}</span> : null}
              <span className="min-w-0 truncate">{m.title}</span>
            </p>
            <p className="line-clamp-2 text-sm text-ink-600">{m.body}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
