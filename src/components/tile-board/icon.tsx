import { ICONS, type IconName } from "@/lib/tile-board/icons";

/**
 * One line icon of the Tile Board set. Decorative by default: the text beside
 * it carries the meaning, so screen readers skip it.
 */
export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 2,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={className}
      // Static markup from src/lib/tile-board/icons.ts — never user input.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
