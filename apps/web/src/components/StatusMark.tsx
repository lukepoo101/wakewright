import type { DeviceState } from "../devices.ts";
import { Icon } from "./Icon.tsx";
import styles from "./StatusMark.module.css";

// A device's status mark. Shape as well as colour tells the states apart: a
// dot when collecting (green), failing (red) or waiting (grey), a square
// when paused and a warning triangle when diagnostics are off (amber). The
// status text next to it always says the same in words.

export function StatusMark({ state, className = "" }: { state: DeviceState; className?: string }) {
  if (state === "diagnosticsOff") {
    return (
      <span className={`${styles.mark} ${styles.icon} ${className}`} aria-hidden="true">
        <Icon name="warning" size={16} strokeWidth={2.2} />
      </span>
    );
  }
  return (
    <span className={`${styles.mark} ${className}`} aria-hidden="true">
      <span className={`${styles.dot} ${styles[state]}`} />
    </span>
  );
}
