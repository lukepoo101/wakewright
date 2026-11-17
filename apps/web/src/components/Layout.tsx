import type { ReactNode } from "react";
import styles from "./Layout.module.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.brand}>Wakewright</span>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
