import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useSignOut } from "../session.ts";
import { type ThemeChoice, useTheme } from "../theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import styles from "./Layout.module.css";
import { Button } from "./ui.tsx";

// The app shell: a top bar (brand, status, theme, sign out), a labelled
// rail on wide screens and a bottom bar on phones. Sign out is left out when
// the server has sign-in off.

const nav: {
  to: "/" | "/clips" | "/devices" | "/judges" | "/workers";
  label: string;
  icon: IconName;
}[] = [
  { to: "/", label: "Home", icon: "home" },
  { to: "/clips", label: "Clips", icon: "clips" },
  { to: "/devices", label: "Devices", icon: "devices" },
  { to: "/judges", label: "Judges", icon: "judges" },
  { to: "/workers", label: "Workers", icon: "workers" },
];

const nextTheme: Record<ThemeChoice, ThemeChoice> = {
  system: "light",
  light: "dark",
  dark: "system",
};
const themeIcon: Record<ThemeChoice, IconName> = { system: "system", light: "sun", dark: "moon" };
const themeName: Record<ThemeChoice, string> = {
  system: "system",
  light: "light",
  dark: "dark",
};

export function ThemeButton() {
  const [theme, setTheme] = useTheme();
  return (
    <Button
      variant="ghost"
      icon={themeIcon[theme]}
      label={`Theme: ${themeName[theme]}. Switch to ${themeName[nextTheme[theme]]}`}
      onClick={() => setTheme(nextTheme[theme])}
    />
  );
}

export function Layout({
  children,
  status,
  signOut: showSignOut,
}: {
  children: ReactNode;
  status?: ReactNode;
  /** Show the sign-out button; false when the server has sign-in off. */
  signOut: boolean;
}) {
  const signOut = useSignOut();
  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <Logo />
          <span className={styles.brandName}>Wakewright</span>
        </Link>
        <div className={styles.status}>{status}</div>
        <div className={styles.tools}>
          <ThemeButton />
          {showSignOut && (
            <Button
              variant="ghost"
              icon="signOut"
              label="Sign out"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            />
          )}
        </div>
      </header>
      <nav className={styles.nav} aria-label="Main">
        <ul>
          {nav.map((item) => (
            <li key={item.to}>
              <Link
                to={item.to}
                className={styles.navLink}
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{ "aria-current": "page", className: styles.active }}
              >
                <Icon name={item.icon} size={22} />
                <span>{item.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

/** The wordmark's glyph: a waveform in a rounded square. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
      <path
        d="M8 14v4M12 10v12M16 7v18M20 11v10M24 14v4"
        stroke="var(--color-on-accent)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
