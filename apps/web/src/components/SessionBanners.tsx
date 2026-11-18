import { Link } from "@tanstack/react-router";
import { errorMessage } from "../api.ts";
import {
  changesText,
  clock,
  isOpen,
  type Session,
  useRetryRestore,
  useSessions,
} from "../collect.ts";
import { plural, useNow } from "../format.ts";
import styles from "./SessionBanners.module.css";
import { Alert, Button } from "./ui.tsx";

// Collection sessions that are not finished, for Home, the Devices page and
// the sessions page. A device whose settings could not be put back yet
// gets a prominent error until a read of the device confirms them; a
// running session gets a calmer note with its time left.

export function SessionBanners({
  deviceId,
  running = true,
}: {
  /** Only this device's sessions. */
  deviceId?: string;
  /** Also show sessions that are running normally. */
  running?: boolean;
}) {
  const links = !deviceId;
  const sessions = useSessions();
  const now = useNow(1000);
  const open = (sessions.data?.sessions ?? []).filter(
    (s) => isOpen(s) && (!deviceId || s.deviceId === deviceId),
  );
  const stuck = open.filter((s) => s.state === "restoring" || s.state === "needs_attention");
  const live = running ? open.filter((s) => s.state === "running") : [];
  if (stuck.length === 0 && live.length === 0) return null;
  return (
    <div className={styles.banners}>
      {stuck.map((s) => (
        <StuckBanner key={s.id} session={s} now={now} link={links} />
      ))}
      {live.map((s) => (
        <Alert key={s.id} tone="info" title={`${s.deviceName} is in a collection session`}>
          <span>
            {s.endsAt && `${clock((Date.parse(s.endsAt) - now) / 1000)} left · `}
            {s.counts.fired} wake words, {s.counts.nearMiss} near misses so far.{" "}
            <Link to="/collect/$sessionId" params={{ sessionId: s.id }}>
              Open the session
            </Link>
          </span>
        </Alert>
      ))}
    </div>
  );
}

function StuckBanner({ session: s, now, link }: { session: Session; now: number; link: boolean }) {
  const retry = useRetryRestore();
  if (s.state === "needs_attention") {
    return (
      <Alert
        tone="error"
        title={`${s.deviceName} is still in collection mode: its settings need putting back by hand`}
      >
        <span>{s.lastError}</span>
        <span>
          On the tablet, set{" "}
          {s.snapshotText ? (
            <>
              these saved values: <code className={styles.code}>{s.snapshotText}</code>
            </>
          ) : (
            changesText(s, "from")
          )}
          .{" "}
          {link && (
            <Link to="/collect/$sessionId" params={{ sessionId: s.id }}>
              Open the session
            </Link>
          )}
        </span>
      </Alert>
    );
  }
  const next = s.nextRestoreAt ? Date.parse(s.nextRestoreAt) : null;
  return (
    <Alert
      tone="error"
      title={`${s.deviceName} is still in collection mode: could not put its settings back yet`}
    >
      <span>
        Wakewright keeps trying
        {s.restoreAttempts > 0 && `: ${plural(s.restoreAttempts, "attempt")} so far`}
        {next !== null && next > now + 1000
          ? `, the next in ${Math.ceil((next - now) / 1000)} s`
          : ", the next now"}
        . Until then the tablet wakes far more easily than usual.
      </span>
      {s.lastError && <span className={styles.problem}>Last problem: {s.lastError}</span>}
      <span>It is putting back: {changesText(s, "from")}.</span>
      <span className={styles.actions}>
        <Button
          size="small"
          icon="refresh"
          onClick={() => retry.mutate(s.id)}
          disabled={retry.isPending}
        >
          {retry.isPending ? "Trying…" : "Try again now"}
        </Button>
        {link && (
          <Link to="/collect/$sessionId" params={{ sessionId: s.id }}>
            Open the session
          </Link>
        )}
      </span>
      {retry.isError && <span className={styles.problem}>{errorMessage(retry.error)}</span>}
    </Alert>
  );
}
