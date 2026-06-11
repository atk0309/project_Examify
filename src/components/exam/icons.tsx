/* ============================================================================
   EXAMIFY — ICONS
   Subject icons are soft duotone, driven by the scoped accent vars
   (var(--accent) crisp foreground, var(--accent-soft) soft fill) so each
   icon re-tones with its subject + the saturation multiplier.
   ========================================================================== */
import type { ReactElement } from 'react';

const ICONS: Record<string, ReactElement> = {
  maths: (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="4" y="3" width="16" height="18" rx="3.2" fill="var(--accent-soft)" />
      <rect x="6.8" y="5.6" width="10.4" height="4" rx="1.3" fill="var(--accent)" opacity="0.45" />
      <path
        d="M8.6 14.4h6.8M12 11v6.8"
        stroke="var(--accent)"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  ),
  biology: (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M6 18C6 11 11 6 18 6c0 7-5 12-12 12Z" fill="var(--accent-soft)" />
      <path
        d="M6 18C6 11 11 6 18 6c0 7-5 12-12 12Z"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M7.6 16.4 16 8" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" />
      <path
        d="M10 14h3M12 11.5h3"
        stroke="var(--accent)"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.7"
      />
    </svg>
  ),
  chemistry: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M8.4 12.6h7.2l2.4 3.9A2 2 0 0 1 16.3 19.5H7.7a2 2 0 0 1-1.7-3l2.4-3.9Z"
        fill="var(--accent-soft)"
      />
      <path
        d="M10 3.5v5.8l-4 6.5A2 2 0 0 0 7.7 19.5h8.6a2 2 0 0 0 1.7-3.7L14 9.3V3.5"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9 3.5h6" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="11" cy="16" r="1" fill="var(--accent)" />
      <circle cx="14" cy="15" r="0.8" fill="var(--accent)" />
    </svg>
  ),
  physics: (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.4" fill="var(--accent-soft)" />
      <circle cx="12" cy="12" r="1.8" fill="var(--accent)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" stroke="var(--accent)" strokeWidth="1.4" />
      <ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="3.6"
        stroke="var(--accent)"
        strokeWidth="1.4"
        transform="rotate(60 12 12)"
      />
      <ellipse
        cx="12"
        cy="12"
        rx="9"
        ry="3.6"
        stroke="var(--accent)"
        strokeWidth="1.4"
        transform="rotate(120 12 12)"
      />
    </svg>
  ),
  'computer-science': (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4.5" width="18" height="12" rx="2" fill="var(--accent-soft)" />
      <rect x="3" y="4.5" width="18" height="12" rx="2" stroke="var(--accent)" strokeWidth="1.5" />
      <path
        d="M8.6 9 6.6 10.8l2 1.8M15.4 9l2 1.8-2 1.8M12.8 8.6l-1.6 4.6"
        stroke="var(--accent)"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 19.5h6M12 16.5v3"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  ),
  geography: (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8.4" fill="var(--accent-soft)" />
      <circle cx="12" cy="12" r="8.4" stroke="var(--accent)" strokeWidth="1.5" />
      <path
        d="M3.6 12h16.8M12 3.6c2.7 2.4 2.7 14 0 16.8M12 3.6c-2.7 2.4-2.7 14 0 16.8"
        stroke="var(--accent)"
        strokeWidth="1.3"
        opacity="0.75"
      />
    </svg>
  ),
  french: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M4 6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3.2V15.4a2 2 0 0 1-1-1.7V6.5Z"
        fill="var(--accent-soft)"
      />
      <path
        d="M4 6.5A2 2 0 0 1 6 4.5h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3.2V15.4a2 2 0 0 1-1-1.7V6.5Z"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 8.6h8M8 11.2h5" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  latin: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M6.5 4.6 12 3l5.5 1.6"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect x="5.5" y="6" width="13" height="2.4" rx="0.6" fill="var(--accent)" />
      <rect x="5" y="18.6" width="14" height="2.4" rx="0.6" fill="var(--accent)" />
      <rect x="7.6" y="8.4" width="2.6" height="10.2" rx="0.5" fill="var(--accent-soft)" />
      <rect x="13.8" y="8.4" width="2.6" height="10.2" rx="0.5" fill="var(--accent-soft)" />
    </svg>
  ),
  drama: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M5 5.5c4-1 10-1 14 0 0 5-1 10-4 12-1 .8-5 .8-6 0-3-2-4-7-4-12Z"
        fill="var(--accent-soft)"
      />
      <path
        d="M5 5.5c4-1 10-1 14 0 0 5-1 10-4 12-1 .8-5 .8-6 0-3-2-4-7-4-12Z"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 9.6c.8-.6 1.8-.6 2.6 0M12.9 9.6c.8-.6 1.8-.6 2.6 0"
        stroke="var(--accent)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M9.5 14c1.4 1.3 3.6 1.3 5 0"
        stroke="var(--accent)"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  ),
  music: (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="8.5" cy="16.5" r="3" fill="var(--accent-soft)" />
      <circle cx="8.5" cy="16.5" r="3" stroke="var(--accent)" strokeWidth="1.5" />
      <path
        d="M11.5 16.5V5.5l6 2.2v3"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  food: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M12 8c-1.4-1.6-4.6-1.4-5.8 1-1.1 2.3-.3 6 1.5 7.9.9 1 1.8 1.1 2.4.7.6.4 1.5.3 2.4-.7 1.8-1.9 2.6-5.6 1.5-7.9C16.6 6.6 13.4 6.4 12 8Z"
        fill="var(--accent-soft)"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M12 8c.2-1.8 1.4-3 3.2-3"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  'product-design': (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z" fill="var(--accent-soft)" />
      <path
        d="M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5Z"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M4 8l8 4.5L20 8M12 12.5v8"
        stroke="var(--accent)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  textiles: (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="7" y="4" width="10" height="16" rx="1.5" fill="var(--accent-soft)" />
      <path d="M6 5h12M6 19h12" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
      <rect x="8.6" y="7.5" width="6.8" height="9" rx="0.8" fill="var(--accent)" opacity="0.45" />
      <path
        d="M8.8 9.4h6.4M8.8 12h6.4M8.8 14.6h6.4"
        stroke="var(--accent)"
        strokeWidth="1.1"
        strokeLinecap="round"
        opacity="0.85"
      />
    </svg>
  ),
};

export function SubjectIcon({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span className="subject-icon" style={{ width: size, height: size, display: 'inline-flex' }}>
      {ICONS[name] ?? ICONS.maths}
    </span>
  );
}

/** Small monochrome UI glyphs (inherit currentColor). */
export const UIcon = {
  back: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M15 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  home: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M4 11l8-6 8 6M6 10v9h12v-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  cross: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M7 7l10 10M17 7L7 17"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  retry: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M19 12a7 7 0 1 1-2.05-4.95M19 4v3.5h-3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  signout: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M14 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 12h11M16 8l4 4-4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
} as const;

/** Login role + mail glyphs. */
export const RoleIcon: Record<'student' | 'parent', ReactElement> = {
  student: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3 2 8l10 5 10-5-10-5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M6 10.5V15c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  parent: (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="8.5" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="16" cy="9.5" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3 19c0-2.8 2.5-4.6 5.5-4.6S14 16.2 14 19M15 14.6c2.6.2 4.5 1.9 4.5 4.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
};

export const MailIcon = {
  send: (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M4 6h16v12H4V6Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ),
  inbox: (
    <svg viewBox="0 0 24 24" fill="none">
      <path
        d="M3.5 7.5 12 13l8.5-5.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="3" y="5.5" width="18" height="13" rx="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m9 12-5.2 5.2M15 12l5.2 5.2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="5" y="10" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M8 10V8a4 4 0 0 1 8 0v2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
  at: (
    <svg viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M15.4 9v4a2.4 2.4 0 0 0 4.6.9 8.5 8.5 0 1 0-3.2 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  ),
} as const;
