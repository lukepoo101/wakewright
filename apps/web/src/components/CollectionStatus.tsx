import { useCollection, useSetPaused } from "../devices.ts";
import { clockTime } from "../format.ts";
import styles from "./CollectionStatus.module.css";
import { Button } from "./ui.tsx";

// The status strip's collection control: whether clips are being collected,
// and the pause toggle. Pausing changes no device, except that a running
// collection session ends and puts its settings back; clips the devices
// save while paused are skipped for good.

export function CollectionStatus() {
  const collection = useCollection();
  const setPaused = useSetPaused();
  if (!collection.data) return null;
  const { paused, pausedSince } = collection.data;
  return (
    <div className={styles.status}>
      <span className={`${styles.pill} ${paused ? styles.paused : styles.on}`} role="status">
        <span className={styles.dot} aria-hidden="true" />
        {paused && pausedSince ? (
          <span>
            Paused <span className={styles.since}>since {clockTime(pausedSince)}</span>
          </span>
        ) : (
          "Collecting"
        )}
      </span>
      <Button
        size="small"
        variant={paused ? "primary" : "secondary"}
        icon={paused ? "playCircle" : "pauseCircle"}
        onClick={() => setPaused.mutate(!paused)}
        disabled={setPaused.isPending}
        title={
          paused
            ? "Start collecting clips again"
            : "Stop collecting. Clips the devices save meanwhile are never stored, and a running collection session ends."
        }
      >
        {paused ? "Resume" : "Pause"}
      </Button>
    </div>
  );
}
