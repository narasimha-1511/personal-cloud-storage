import type { SVGProps } from 'react';

/**
 * Inline stroke icon set (24x24, currentColor). No emoji, no icon fonts —
 * crisp at any size and inherits text color.
 */

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 20, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v15c0 .4.44.65.78.44l11.8-7.5a.52.52 0 0 0 0-.88L7.78 4.06A.52.52 0 0 0 7 4.5Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconPause = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconDownload = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 20h14" />
  </Svg>
);

export const IconLink = (p: P) => (
  <Svg {...p}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
);

export const IconPencil = (p: P) => (
  <Svg {...p}>
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Svg>
);

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </Svg>
);

export const IconFolderMove = (p: P) => (
  <Svg {...p}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    <path d="M9 13h6" />
    <path d="m12.5 10.5 2.5 2.5-2.5 2.5" />
  </Svg>
);

export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="m3 9.5 9-7 9 7V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="M9 22v-8h6v8" />
  </Svg>
);

export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Svg>
);

export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconChevronLeft = (p: P) => (
  <Svg {...p}>
    <path d="m15 18-6-6 6-6" />
  </Svg>
);

export const IconChevronRight = (p: P) => (
  <Svg {...p}>
    <path d="m9 18 6-6-6-6" />
  </Svg>
);

export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const IconX = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Svg>
);

export const IconUsers = (p: P) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const IconLogout = (p: P) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </Svg>
);

export const IconLibrary = (p: P) => (
  <Svg {...p}>
    <path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z" />
    <path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65" />
    <path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65" />
  </Svg>
);

export const IconTransfers = (p: P) => (
  <Svg {...p}>
    <path d="m21 16-4 4-4-4" />
    <path d="M17 20V4" />
    <path d="m3 8 4-4 4 4" />
    <path d="M7 4v16" />
  </Svg>
);

export const IconFilm = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 3v18" />
    <path d="M17 3v18" />
    <path d="M3 8h4" />
    <path d="M3 16h4" />
    <path d="M17 8h4" />
    <path d="M17 16h4" />
    <path d="M7 12h10" />
  </Svg>
);

export const IconKey = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="16" r="5" />
    <path d="m11.5 12.5 8-8" />
    <path d="m16 8 3 3" />
    <path d="m18.5 5.5 2 2" />
  </Svg>
);

export const IconUserOff = (p: P) => (
  <Svg {...p}>
    <path d="M15 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1" />
    <circle cx="9" cy="6" r="4" />
    <path d="m17 8 5 5" />
    <path d="m22 8-5 5" />
  </Svg>
);

export const IconSparkle = (p: P) => (
  <Svg {...p}>
    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
  </Svg>
);

export const IconSpinner = ({ size = 14, ...rest }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    className="animate-spin"
    aria-hidden="true"
    {...rest}
  >
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </svg>
);

export const IconLogo = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="2.5" width="19" height="19" rx="5" />
    <path d="M10 8.5v7c0 .4.45.65.79.43l5.5-3.5a.5.5 0 0 0 0-.86l-5.5-3.5a.5.5 0 0 0-.79.43Z" fill="currentColor" stroke="none" />
  </Svg>
);
