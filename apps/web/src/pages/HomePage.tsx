import { Link } from "@tanstack/react-router";
import { errorMessage } from "../api.ts";
import { ClipList } from "../components/ClipList.tsx";
import { DiagnosticsSteps } from "../components/DiagnosticsHelp.tsx";
import { Icon } from "../components/Icon.tsx";
import { StatusMark } from "../components/StatusMark.tsx";
import { Alert, buttonClass, Card, Loading, PageHeader } from "../components/ui.tsx";
import { useClipSummary, useClips } from "../clips.ts";
import { adviceFor, type Device, deviceState, useCollection, useDevices } from "../devices.ts";
import { ago, plural, useNow } from "../format.ts";
import styles from "./HomePage.module.css";

// Home: until the first clip arrives, the steps to get there; after that,
// collection health at a glance and the latest clips.

export function HomePage() {
  const devices = useDevices();
  const summary = useClipSummary();
  const latest = useClips({}, 5);
  const collection = useCollection();
  const now = useNow();

  if (devices.isPending || summary.isPending) {
    return (
      <>
        <PageHeader title="Home" />
        <Loading />
      </>
    );
  }
  if (devices.isError || summary.isError) {
    return (
      <>
        <PageHeader title="Home" />
        <Alert tone="error" title="Cannot load the overview">
          {errorMessage(devices.error ?? summary.error)}
        </Alert>
      </>
    );
  }

  const list = devices.data.devices;
  const totals = summary.data;
  const failing = list.filter((d) => d.status.health === "failing");
  const diagnosticsOff = list.filter((d) => d.reported?.diagnosticsEnabled === false);
  const paused = collection.data?.paused ?? false;
  // Working: reachable and saving clips (diagnostics on, or not read yet).
  const working = list.filter(
    (d) => d.status.health !== "failing" && d.reported?.diagnosticsEnabled !== false,
  ).length;

  if (totals.total === 0) {
    return (
      <>
        <PageHeader title="Get started" lead="Three steps to your first clip." />
        <FirstRun devices={list} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Home" />
      <div className={styles.alerts}>
        {paused && (
          <Alert tone="warning" title="Collection is paused">
            Clips your devices save while paused are never stored. Resume from the top bar.
          </Alert>
        )}
        {failing.map((d) => (
          <Alert
            key={d.id}
            tone="error"
            title={`${d.name}: ${adviceFor(d.status.error?.code ?? "").title}`}
          >
            {d.status.error?.message} <Link to="/devices">Check the device</Link>
          </Alert>
        ))}
        {diagnosticsOff.map((d) => (
          <Alert key={d.id} tone="warning" title={`Wake word diagnostics are off on ${d.name}`}>
            It saves no clips until they are on. <Link to="/devices">How to turn them on</Link>
          </Alert>
        ))}
      </div>

      <section className={styles.tiles} aria-label="At a glance">
        <Tile label="Last 24 hours" value={plural(totals.last24h.fired, "wake word")}>
          and {plural(totals.last24h.nearMiss, "near miss", "near misses")}
        </Tile>
        <Tile label="All clips" value={totals.total.toLocaleString("en-GB")}>
          latest {ago(totals.lastClipAt, now)}
        </Tile>
        <Tile
          label="Devices"
          value={
            working < list.length
              ? `${working} of ${list.length} working`
              : `${list.length} working`
          }
        >
          {paused ? "paused" : "checked every few seconds"}
        </Tile>
      </section>

      <div className={styles.columns}>
        <Card className={styles.latest}>
          <div className={styles.cardHead}>
            <h2>Latest clips</h2>
            <Link to="/clips">All clips</Link>
          </div>
          {latest.data ? <ClipList clips={latest.data.clips} label="Latest clips" /> : <Loading />}
        </Card>

        <Card>
          <div className={styles.cardHead}>
            <h2>Devices</h2>
            <Link to="/devices">Manage</Link>
          </div>
          <ul className={styles.devices}>
            {list.map((d) => (
              <li key={d.id}>
                <StatusMark state={deviceState(d, paused)} className={styles.mark} />
                <span className={styles.deviceName}>{d.name}</span>
                <span className={styles.deviceState}>{deviceLine(d, now, paused)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function deviceLine(d: Device, now: number, paused: boolean): string {
  switch (deviceState(d, paused)) {
    case "paused":
      return `paused · ${plural(d.clips, "clip")}`;
    case "failing":
      return adviceFor(d.status.error?.code ?? "").title;
    case "waiting":
      return "waiting for the first check";
    case "diagnosticsOff":
      return "diagnostics off: saving no clips";
    case "ok":
      return `${plural(d.clips, "clip")} · checked ${ago(d.status.lastSuccessAt, now)}`;
  }
}

function Tile({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      <span className={styles.tileNote}>{children}</span>
    </div>
  );
}

// The path to the first clip, with each step ticked off as it happens.
function FirstRun({ devices }: { devices: Device[] }) {
  const hasDevice = devices.length > 0;
  const reporting = devices.filter((d) => d.reported !== null);
  const diagnosticsOn = devices.some((d) => d.reported?.diagnosticsEnabled === true);
  const failing = devices.filter((d) => d.status.health === "failing");

  return (
    <ol className={styles.steps}>
      <Step
        n={1}
        done={hasDevice}
        title="Add a Kiosk Satellite device"
        action={
          !hasDevice && (
            <Link to="/devices/new" className={buttonClass("primary")}>
              Add a device
            </Link>
          )
        }
      >
        {hasDevice ? (
          <>Added {devices.map((d) => d.name).join(", ")}.</>
        ) : (
          <>You need its address and the remote administration password set in Kiosk Satellite.</>
        )}
        {failing.map((d) => (
          <Alert
            key={d.id}
            tone="error"
            title={`${d.name}: ${adviceFor(d.status.error?.code ?? "").title}`}
          >
            {d.status.error?.message} <Link to="/devices">Check the device</Link>
          </Alert>
        ))}
      </Step>
      <Step n={2} done={diagnosticsOn} title="Turn on wake word diagnostics on the device">
        {diagnosticsOn ? (
          <>The device is saving its wake words and near misses.</>
        ) : (
          <>
            <p>
              The device keeps clips only while diagnostics are on.
              {reporting.length > 0 && " It reports them off at the moment."}
            </p>
            <DiagnosticsSteps />
          </>
        )}
      </Step>
      <Step n={3} done={false} title="Say the wake word">
        Clips appear here within seconds of the device hearing its wake word, or nearly hearing it.
        They stay on this computer.
      </Step>
    </ol>
  );
}

function Step({
  n,
  done,
  title,
  action,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className={`${styles.step} ${done ? styles.done : ""}`}>
      <span className={styles.stepMark} aria-hidden="true">
        {done ? <Icon name="check" size={18} /> : n}
      </span>
      <div className={styles.stepBody}>
        <h2>
          {title}
          {done && <span className={styles.visuallyHidden}> (done)</span>}
        </h2>
        <div className={styles.stepText}>{children}</div>
        {action}
      </div>
    </li>
  );
}
