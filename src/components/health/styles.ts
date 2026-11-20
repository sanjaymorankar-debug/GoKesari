/** GoKesari Health: shared button classes (plain module — usable from server and client components). */
const btn = "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-extrabold disabled:opacity-60";
export const BTN_PRIMARY = `${btn} bg-kesari-700 text-white hover:bg-kesari-800`;
export const BTN_SECONDARY = `${btn} border-2 border-[var(--gk-line)] bg-white text-ink-900 hover:border-kesari-400`;
export const BTN_DANGER = `${btn} border-2 border-red-300 bg-white text-red-800 hover:bg-red-50`;
