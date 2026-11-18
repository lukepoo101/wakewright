import type { SVGProps } from "react";

// Simple line icons drawn for Wakewright (24 × 24, stroke = currentColor).
// Decorative by default: give the surrounding control an accessible name.

const paths = {
  home: "M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20",
  clips: "M4 10v4M8 6v12M12 9v6M16 4v16M20 10v4",
  devices: "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm4 15h2",
  sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z",
  system: "M4 5h16v11H4zM9 20h6M12 16v4",
  signOut: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10",
  play: "M8 5.5v13l10.5-6.5L8 5.5Z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5 10 17l9-10",
  cross: "M6.5 6.5l11 11m0-11-11 11",
  notEqual: "M5 9.5h14M5 14.5h14M15.5 5l-7 14",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2",
  minus: "M6 12h12",
  warning: "M12 4 2.5 20h19L12 4Zm0 6v4.5m0 3v.5",
  error: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-12 6 6m0-6-6 6",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v5.5M12 8v.5",
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  refresh: "M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16m0 4v-4h-4",
  pauseCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM10 9v6m4-6v6",
  playCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2-12.5v7l5.5-3.5L10 8.5Z",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  edit: "M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4",
  workers: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  judges: "M12 4v16M8 20h8M5 7h14M5 7l-3 6a3 3 0 0 0 6 0L5 7Zm14 0-3 6a3 3 0 0 0 6 0l-3-6ZM12 4v3",
  cloud: "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9.5 4.3 4.3 0 0 0 7 18Z",
  scale: "M4 12h16M12 4v16",
  key: "M14 4a6 6 0 1 1-5.2 9L4 17.8V20h3v-2h2v-2h1.8l.4-.4A6 6 0 0 1 14 4Zm2 4v.01",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 20,
  ...props
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = name === "play" || name === "pause";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
