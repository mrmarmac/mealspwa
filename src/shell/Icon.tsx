/**
 * A small, dependency-free inline SVG icon set. No icon library — every
 * glyph used anywhere in the app must be added here so the set stays a
 * single, auditable file.
 */
import type { ReactNode, SVGProps } from 'react';

export type IconName =
  | 'plus'
  | 'search'
  | 'check'
  | 'chevron'
  | 'trash'
  | 'camera'
  | 'link'
  | 'share'
  | 'x'
  | 'multiply'
  | 'leftovers'
  | 'basket'
  | 'calendar'
  | 'book'
  | 'settings';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Square size in px. @default 24 */
  size?: number;
  /** Rotates the glyph — used by `chevron` for up/down/left/right variants. */
  rotate?: 0 | 90 | 180 | 270;
}

const paths: Record<IconName, ReactNode> = {
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  check: <polyline points="4 12 9.5 17.5 20 6" />,
  // Points "down" at rotate=0; pass rotate to point up/left/right.
  chevron: <polyline points="6 9 12 15 18 9" />,
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8a2 2 0 0 1 2-2h1.2a1 1 0 0 0 .89-.55l.5-1A2 2 0 0 1 10.38 3h3.24a2 2 0 0 1 1.79 1.45l.5 1a1 1 0 0 0 .9.55H18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  link: (
    <>
      <path d="M9.5 14.5l5-5" />
      <path d="M11 6.5l1.2-1.2a3.5 3.5 0 1 1 5 5L16 11.5" />
      <path d="M13 17.5l-1.2 1.2a3.5 3.5 0 1 1-5-5L8 12.5" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <line x1="8.3" y1="10.7" x2="15.7" y2="6.3" />
      <line x1="8.3" y1="13.3" x2="15.7" y2="17.7" />
    </>
  ),
  x: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  multiply: (
    <>
      <line x1="7" y1="7" x2="17" y2="17" />
      <line x1="17" y1="7" x2="7" y2="17" />
    </>
  ),
  // A plate with a swirl — this app's stand-in glyph for "leftovers placed
  // from an earlier cook".
  leftovers: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8.5 12a3.5 3.5 0 1 1 3.5 3.5" />
    </>
  ),
  basket: (
    <>
      <path d="M4 10h16l-1.5 9a2 2 0 0 1-2 1.8H7.5a2 2 0 0 1-2-1.8L4 10z" />
      <path d="M8 10l1.5-5" />
      <path d="M16 10l-1.5-5" />
      <line x1="9" y1="13.5" x2="9.6" y2="18" />
      <line x1="15" y1="13.5" x2="14.4" y2="18" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2.2" />
      <line x1="3.5" y1="10" x2="20.5" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </>
  ),
  book: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15.5a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 19V4.5z" />
      <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V19.5a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H4.5a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.04 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H10.5a1.7 1.7 0 0 0 1.04-1.56V4.5a2 2 0 1 1 4 0v.09c0 .68.4 1.29 1.04 1.56.63.26 1.36.13 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87c.27.63.88 1.04 1.56 1.04h.09a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.04z" />
    </>
  ),
};

export function Icon({ name, size = 24, rotate, style, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={rotate ? { transform: `rotate(${rotate}deg)`, ...style } : style}
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
