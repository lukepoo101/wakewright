import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
import { call, errorMessage, v1 } from "../api.ts";
import {
  type CollectionOptions,
  clock,
  DEFAULT_LIMIT_MINUTES,
  durationText,
  endText,
  isOpen,
  LIMIT_CHOICES,
  NOTE_LABELS,
  type Note,
  restoreText,
  type Session,
  type SessionWrite,
  sessionsKey,
  useCollectionOptions,
  useResolveByHand,
  useSession,
  useSessions,
  useStopSession,
} from "../collect.ts";
import { SessionBanners } from "../components/SessionBanners.tsx";
import {
  Alert,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Loading,
  PageHeader,
} from "../components/ui.tsx";
import { adviceFor, devicesKey, useCollection, useDevices } from "../devices.ts";
import { clockTime, longDateTime, plural, shortDateTime, useNow } from "../format.ts";
import styles from "./CollectPage.module.css";

// Collection sessions (ADR 0020): the history, the start form and one
// session while it runs. A session raises one tablet's wake word
// sensitivity to its maximum for a time limit, collects every clip it saves
// quickly, then puts the settings back and confirms them.

export function SessionsPage() {
  const sessions = useSessions();
  const start = (
    <Link to="/collect/new" className={buttonClass("primary")}>
      Start a session
    </Link>
  );
  return (
    <>
      <PageHeader
        title="Collection sessions"
        lead="For a few minutes, one tablet wakes on almost anything and Wakewright keeps every clip. Then its settings go back as they were."
        actions={start}
      />
      <SessionBanners running={false} />
      {sessions.isPending && <Loading label="Loading sessions…" />}
      {sessions.isError && (
        <Alert tone="error" title="Cannot load the sessions">
          {errorMessage(sessions.error)}
        </Alert>
      )}
      {sessions.data && sessions.data.sessions.length === 0 && (
        <Card>
          <EmptyState icon="clips" title="No sessions yet" action={start}>
            Start one, then walk round the room saying the wake word, or just talking, to collect a
            batch of wake words and near misses in a few minutes.
          </EmptyState>
        </Card>
      )}
      {sessions.data && sessions.data.sessions.length > 0 && (
        <ul className={styles.history} aria-label="Sessions, newest first">
          {sessions.data.sessions.map((s) => (
            <li key={s.id}>
              <SessionSummary session={s} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SessionSummary({ session: s }: { session: Session }) {
  const clips = s.counts.fired + s.counts.nearMiss;
  const titleId = `session-${s.id}`;
  return (
    <Card className={styles.summary}>
      <article aria-labelledby={titleId}>
        <div className={styles.summaryHead}>
          <h2 id={titleId}>
            <Link to="/collect/$sessionId" params={{ sessionId: s.id }}>
              {s.deviceName}, {shortDateTime(s.createdAt)}
            </Link>
          </h2>
          <span className={`${styles.badge} ${styles[`badge_${s.state}`]}`}>{endText(s)}</span>
        </div>
        <dl className={styles.facts}>
          <dt>Ran for</dt>
          <dd>{durationText(s)}</dd>
          <dt>Clips</dt>
          <dd>
            {clips > 0 ? (
              <Link to="/clips" search={{ session: s.id }}>
                {plural(s.counts.fired, "wake word")},{" "}
                {plural(s.counts.nearMiss, "near miss", "near misses")}
              </Link>
            ) : (
              "none"
            )}
          </dd>
          <dt>Note</dt>
          <dd>{s.note ? NOTE_LABELS[s.note] : "none"}</dd>
          <dt>Settings</dt>
          <dd className={s.restoredAt || s.resolvedByHandAt ? "" : styles.notBack}>
            {restoreText(s)}
          </dd>
        </dl>
      </article>
    </Card>
  );
}

export function StartSessionPage({ deviceId }: { deviceId?: string }) {
  const navigate = useNavigate();
  const devices = useDevices();
  const paused = useCollection().data?.paused ?? false;
  const [chosen, setChosen] = useState<string | undefined>(deviceId);
  const device = devices.data?.devices.find((d) => d.id === chosen);
  // The first device that has no session yet, unless one was chosen.
  useEffect(() => {
    if (chosen || !devices.data) return;
    setChosen(devices.data.devices.find((d) => !d.collectionSession)?.id);
  }, [chosen, devices.data]);

  return (
    <>
      <PageHeader
        title="Start a collection session"
        lead="Wakewright turns the tablet's wake word sensitivity right up, keeps every clip it saves, and puts its settings back when you stop or the time runs out."
      />
      {devices.isPending && <Loading />}
      {devices.data && devices.data.devices.length === 0 && (
        <Alert tone="info" title="Add a device first">
          <Link to="/devices/new">Add a device</Link>
        </Alert>
      )}
      {devices.data && devices.data.devices.length > 0 && (
        <Card className={styles.formCard}>
          <StartForm
            key={chosen ?? "none"}
            devices={devices.data.devices}
            deviceId={chosen}
            onDevice={(id) => {
              setChosen(id);
              void navigate({ to: "/collect/new", search: { device: id }, replace: true });
            }}
            busy={Boolean(device?.collectionSession)}
            paused={paused}
          />
        </Card>
      )}
    </>
  );
}

function StartForm({
  devices,
  deviceId,
  onDevice,
  busy,
  paused,
}: {
  devices: { id: string; name: string; collectionSession: { id: string } | null }[];
  deviceId: string | undefined;
  onDevice: (id: string) => void;
  busy: boolean;
  paused: boolean;
}) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const options = useCollectionOptions(busy ? undefined : deviceId);
  const result = options.data;
  const ready = result?.ok ? result.options : undefined;
  const [engine, setEngine] = useState<string | undefined>(undefined);
  const [minutes, setMinutes] = useState<number>(DEFAULT_LIMIT_MINUTES);
  const [note, setNote] = useState<Note | null>(null);
  const picked = ready?.engines.find((e) => e.value === (engine ?? ready.defaultEngine));
  const device = devices.find((d) => d.id === deviceId);

  const start = useMutation({
    mutationFn: () =>
      call(
        v1["collection-sessions"].$post({
          json: {
            deviceId: deviceId ?? "",
            engine: picked?.value,
            limitSeconds: minutes * 60,
            note,
          },
        }),
      ),
    onSuccess: async (session) => {
      await queryClient.invalidateQueries({ queryKey: sessionsKey });
      await queryClient.invalidateQueries({ queryKey: devicesKey });
      void navigate({ to: "/collect/$sessionId", params: { sessionId: session.id } });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (picked?.available && ready?.ready) start.mutate();
  };
  const canStart = Boolean(ready?.ready && picked?.available && !paused && !busy);

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.field}>
        <label htmlFor={`${id}-device`}>Device</label>
        <select
          id={`${id}-device`}
          value={deviceId ?? ""}
          onChange={(e) => onDevice(e.target.value)}
        >
          {!deviceId && <option value="">Choose a device</option>}
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.collectionSession ? `${d.name} (in a session)` : d.name}
            </option>
          ))}
        </select>
      </div>

      {busy && device?.collectionSession && (
        <Alert tone="info" title={`${device.name} already has a collection session`}>
          <Link to="/collect/$sessionId" params={{ sessionId: device.collectionSession.id }}>
            Open it
          </Link>
        </Alert>
      )}
      {paused && (
        <Alert tone="warning" title="Collection is paused">
          Resume collection from the top bar first: clips saved while paused are not kept.
        </Alert>
      )}
      {options.isFetching && !result && <Loading label="Reading the device's settings…" />}
      {options.isError && <Alert tone="error">{errorMessage(options.error)}</Alert>}
      {result && !result.ok && (
        <Alert tone="error" title={adviceFor(result.error.code).title}>
          <span>{result.error.message}</span>
          <span>{adviceFor(result.error.code).fix}</span>
        </Alert>
      )}
      {ready && <Current options={ready} />}
      {ready && !ready.ready && ready.problems.length > 0 && (
        <Alert tone="warning" title="A session cannot start on this device yet">
          {ready.problems.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </Alert>
      )}

      {ready && ready.engines.length > 0 && (
        <div className={styles.field}>
          <label htmlFor={`${id}-engine`}>Engine</label>
          <select
            id={`${id}-engine`}
            value={picked?.value ?? ""}
            onChange={(e) => setEngine(e.target.value)}
            aria-describedby={ready.fleet ? undefined : `${id}-engine-hint`}
          >
            {ready.engines.map((e) => (
              <option key={e.value} value={e.value} disabled={!e.available}>
                {e.label}
                {e.recommended ? " (most sensitive)" : ""}
                {e.current ? " (now)" : ""}
                {e.available ? "" : " (not available)"}
              </option>
            ))}
          </select>
          {!ready.fleet && (
            <span id={`${id}-engine-hint`} className={styles.hint}>
              microWakeWord wakes most readily when turned right up, so it is chosen when the tablet
              can use it with its wake word.
            </span>
          )}
          {ready.engines
            .filter((e) => !e.available && e.reason)
            .map((e) => (
              <span key={e.value} className={styles.hint}>
                {e.label} is not available: {e.reason}
              </span>
            ))}
          {ready.fleet && (
            <span className={styles.hint}>
              This tablet{" "}
              {ready.fleet.role === "leader" ? "leads" : `follows ${ready.fleet.leader} in`} a Kiosk
              Satellite fleet, which keeps the engine and the sensitivity the same across its
              tablets. So only the fine-tune is raised, which each tablet keeps for itself.
            </span>
          )}
        </div>
      )}

      {picked && (
        <div className={styles.changes}>
          <h2 className={styles.subhead}>What changes on {device?.name ?? "the device"}</h2>
          {picked.changes.length === 0 ? (
            <p>
              It is already at its most sensitive. Wakewright only checks it for new clips every 2
              seconds.
            </p>
          ) : (
            <ul>
              {picked.changes.map((c) => (
                <li key={c.key}>
                  <span className={styles.changeTitle}>{c.title}</span>{" "}
                  <span>
                    {c.fromLabel} <span aria-hidden="true">→</span>
                    <span className={styles.visuallyHidden}> becomes </span>{" "}
                    <strong>{c.toLabel}</strong>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.hint}>
            Nothing else changes, and the wake word stays as it is. Wakewright saves these settings
            first and puts them back when the session ends.
          </p>
        </div>
      )}

      <div className={styles.field}>
        <label htmlFor={`${id}-limit`}>Time limit</label>
        <select
          id={`${id}-limit`}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          {LIMIT_CHOICES.map((m) => (
            <option key={m} value={m}>
              {plural(m, "minute")}
            </option>
          ))}
        </select>
        <span className={styles.hint}>
          The settings go back at the end even if this page is closed.
        </span>
      </div>

      <fieldset className={styles.notes}>
        <legend>What will you be doing? (optional)</legend>
        {(Object.keys(NOTE_LABELS) as Note[]).map((n) => (
          <label key={n} className={styles.choice}>
            <input type="radio" name="note" checked={note === n} onChange={() => setNote(n)} />
            {NOTE_LABELS[n]}
          </label>
        ))}
        <label className={styles.choice}>
          <input type="radio" name="note" checked={note === null} onChange={() => setNote(null)} />
          No note
        </label>
        <span className={styles.hint}>
          Kept with the session for training later. It does not change what the judges decide.
        </span>
      </fieldset>

      <Alert tone="warning" title="The tablet stays live">
        <span>
          With its sensitivity at the maximum it will wake often, from speech, the TV or noise, and
          each time it may act on whatever is said next: switch something, play music or answer out
          loud. Tell the people in the room, and stop the session if it gets in the way.
        </span>
      </Alert>

      {start.isError && (
        <Alert tone="error" title="The session did not start">
          {errorMessage(start.error)}
        </Alert>
      )}
      <div className={styles.buttons}>
        <Link to="/collect" className={buttonClass("secondary")}>
          Cancel
        </Link>
        <Button type="submit" variant="primary" disabled={!canStart || start.isPending}>
          {start.isPending ? "Starting…" : "Start the session"}
        </Button>
      </div>
    </form>
  );
}

function Current({ options }: { options: CollectionOptions }) {
  const c = options.current;
  const fine =
    c.fineTune === null ? "" : `, fine-tune ${c.fineTune > 0 ? `+${c.fineTune}` : c.fineTune}`;
  return (
    <p className={styles.current}>
      <span className={styles.changeTitle}>Now:</span>{" "}
      {c.wakeWords.length ? c.wakeWords.join(", ") : "unknown wake word"} on {c.engineLabel},{" "}
      {c.sensitivityLabel}
      {fine}
    </p>
  );
}

export function SessionPage({ sessionId }: { sessionId: string }) {
  const session = useSession(sessionId);
  const now = useNow(1000);
  const stop = useStopSession();
  const resolve = useResolveByHand();
  const [confirmHand, setConfirmHand] = useState(false);

  if (session.isPending) {
    return (
      <>
        <PageHeader title="Collection session" />
        <Loading />
      </>
    );
  }
  if (session.isError) {
    return (
      <>
        <PageHeader title="Collection session" />
        <Alert tone="error" title="Cannot load the session">
          {errorMessage(session.error)}
        </Alert>
      </>
    );
  }
  const { session: s, writes } = session.data;
  const left = s.endsAt ? (Date.parse(s.endsAt) - now) / 1000 : 0;
  const clips = s.counts.fired + s.counts.nearMiss;

  return (
    <>
      <PageHeader
        title={`Collection session: ${s.deviceName}`}
        lead={`Started ${longDateTime(s.createdAt)}`}
        actions={
          <Link to="/collect" className={buttonClass("secondary", "small")}>
            All sessions
          </Link>
        }
      />
      <SessionBanners deviceId={s.deviceId} running={false} />

      {s.state === "running" && (
        <Card className={styles.live}>
          <div className={styles.liveTop}>
            <div className={styles.timer}>
              <span className={styles.tileLabel}>Time left</span>
              <span className={styles.clock} role="timer" aria-live="off">
                {clock(left)}
              </span>
              <span className={styles.hint}>ends at {s.endsAt && clockTime(s.endsAt)}</span>
            </div>
            <div className={styles.counts} role="status" aria-live="polite">
              <div className={styles.count}>
                <span className={styles.countValue}>{s.counts.fired}</span>
                <span className={styles.tileLabel}>wake words</span>
              </div>
              <div className={styles.count}>
                <span className={styles.countValue}>{s.counts.nearMiss}</span>
                <span className={styles.tileLabel}>near misses</span>
              </div>
            </div>
          </div>
          <p className={styles.liveNote}>
            {s.deviceName} is listening at its most sensitive and is checked for new clips every 2
            seconds. {s.note ? `Note: ${NOTE_LABELS[s.note]}.` : ""}
          </p>
          <div className={styles.buttons}>
            <Button
              variant="danger"
              icon="pauseCircle"
              onClick={() => stop.mutate(s.id)}
              disabled={stop.isPending}
            >
              {stop.isPending ? "Stopping…" : "Stop and put the settings back"}
            </Button>
          </div>
          {stop.isError && <Alert tone="error">{errorMessage(stop.error)}</Alert>}
        </Card>
      )}

      {s.state === "ended" && s.restoredAt && s.endReason !== "start_failed" && (
        <div className={styles.outcome}>
          <Alert tone="success" title="Finished: the settings are back as they were">
            {s.changes.length === 0
              ? "Nothing needed changing on the device."
              : `Wakewright read ${s.deviceName} again at ${clockTime(s.restoredAt)} and it reports ${s.changes
                  .map((c) => `${c.title.toLowerCase()} ${c.fromLabel}`)
                  .join(", ")}.`}
          </Alert>
        </div>
      )}
      {s.endReason === "start_failed" && s.state === "ended" && (
        <div className={styles.outcome}>
          <Alert tone="warning" title="This session did not start">
            {s.restoredAt
              ? "The device refused a change, so Wakewright put back what had changed and confirmed it. Nothing is left changed on the device."
              : "Nothing is left changed on the device."}
          </Alert>
        </div>
      )}
      {s.state === "needs_attention" && (
        <div className={styles.outcome}>
          <Button variant="primary" onClick={() => setConfirmHand(true)}>
            I have put the settings back by hand
          </Button>
          {confirmHand && (
            <Alert tone="warning" title="Have you set them on the tablet?">
              <span>Only confirm once the tablet shows its old settings again.</span>
              <span className={styles.buttons}>
                <Button size="small" onClick={() => setConfirmHand(false)}>
                  Not yet
                </Button>
                <Button
                  size="small"
                  variant="primary"
                  onClick={() => resolve.mutate(s.id)}
                  disabled={resolve.isPending}
                >
                  Yes, they are back
                </Button>
              </span>
            </Alert>
          )}
        </div>
      )}

      <div className={styles.columns}>
        <Card>
          <h2 className={styles.subhead}>About this session</h2>
          <dl className={styles.facts}>
            <dt>Device</dt>
            <dd>{s.deviceName}</dd>
            <dt>Status</dt>
            <dd>{endText(s)}</dd>
            <dt>Settings</dt>
            <dd className={s.restoredAt || s.resolvedByHandAt || isOpen(s) ? "" : styles.notBack}>
              {restoreText(s)}
              {s.restoredAt && ` at ${clockTime(s.restoredAt)}`}
            </dd>
            <dt>Time limit</dt>
            <dd>{plural(Math.round(s.limitSeconds / 60), "minute")}</dd>
            <dt>Ran for</dt>
            <dd>{durationText(s)}</dd>
            <dt>Engine</dt>
            <dd>{s.engineLabel}</dd>
            <dt>Note</dt>
            <dd>{s.note ? NOTE_LABELS[s.note] : "none"}</dd>
            <dt>Clips</dt>
            <dd>
              {clips > 0 ? (
                <Link to="/clips" search={{ session: s.id }}>
                  {plural(s.counts.fired, "wake word")},{" "}
                  {plural(s.counts.nearMiss, "near miss", "near misses")}
                </Link>
              ) : (
                "none yet"
              )}
            </dd>
          </dl>
          <h3 className={styles.minorHead}>What it changes</h3>
          {s.changes.length === 0 ? (
            <p className={styles.hint}>Nothing: the device was already at its most sensitive.</p>
          ) : (
            <ul className={styles.changeList}>
              {s.changes.map((c) => (
                <li key={c.key}>
                  <span className={styles.changeTitle}>{c.title}</span> {c.fromLabel}{" "}
                  <span aria-hidden="true">→</span>
                  <span className={styles.visuallyHidden}> raised to </span> {c.toLabel}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className={styles.subhead}>Settings written</h2>
          <p className={styles.hint}>
            Every change Wakewright made to {s.deviceName} for this session, and how the device
            answered.
          </p>
          {writes.length === 0 ? (
            <p>None.</p>
          ) : (
            <ol className={styles.writes}>
              {writes.map((w) => (
                <WriteLine key={`${w.at}-${w.purpose}`} write={w} />
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}

const PURPOSE: Record<SessionWrite["purpose"], string> = {
  apply: "Raised the sensitivity",
  undo_start: "Undid a start the device refused",
  restore: "Put the settings back",
};

function WriteLine({ write: w }: { write: SessionWrite }) {
  return (
    <li>
      <span className={styles.writeHead}>
        {clockTime(w.at)} · {PURPOSE[w.purpose]} ·{" "}
        <span className={w.outcome === "ok" ? "" : styles.notBack}>
          {w.outcome === "ok" ? "accepted" : w.outcome === "rejected" ? "refused" : "failed"}
        </span>
      </span>
      <code className={styles.values}>
        {Object.entries(w.values)
          .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
          .join(", ")}
      </code>
      {w.detail && <span className={styles.hint}>{w.detail}</span>}
    </li>
  );
}
