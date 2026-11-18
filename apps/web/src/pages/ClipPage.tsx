import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { errorMessage } from "../api.ts";
import { AudioPlayer, type AudioPlayerHandle } from "../components/AudioPlayer.tsx";
import { ClippedChip, KindChip, ScoreBar } from "../components/ClipBits.tsx";
import { Icon } from "../components/Icon.tsx";
import { Alert, buttonClass, Card, Loading, PageHeader, useTitle } from "../components/ui.tsx";
import { audioUrl, type Clip, type ClipSearch, kindLabel, useClip } from "../clips.ts";
import { longDateTime, shortDateTime } from "../format.ts";
import { usePlayer } from "../player.tsx";
import { scoreSummary } from "../score.ts";
import styles from "./ClipPage.module.css";

// One clip: its waveform and playback, and everything the device reported
// about it. Keyboard: Space plays or pauses, ← and → go to the newer and
// older clip in the list it was opened from.

export function ClipPage({ clipId, search }: { clipId: string; search: ClipSearch }) {
  const clip = useClip(clipId, search);
  const navigate = useNavigate();
  const player = useRef<AudioPlayerHandle>(null);
  const shared = usePlayer();
  useTitle(clip.data ? `Clip ${shortDateTime(clip.data.clip.capturedAt)}` : "Clip");

  // A clip playing from a list stops when its page opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per clip page
  useEffect(() => shared.stop(), []);

  const newerId = clip.data?.newerId ?? null;
  const olderId = clip.data?.olderId ?? null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement;
      // Leave keys alone in controls that use them: text fields use both,
      // and a focused button or link already acts on Space.
      if (target.closest("input, select, textarea, [contenteditable]")) return;
      const go = (id: string | null) => {
        if (!id) return;
        event.preventDefault();
        void navigate({ to: "/clips/$clipId", params: { clipId: id }, search });
      };
      if (event.key === " ") {
        if (target.closest("button, a")) return;
        event.preventDefault();
        player.current?.toggle();
      } else if (event.key === "ArrowLeft") go(newerId);
      else if (event.key === "ArrowRight") go(olderId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, newerId, olderId, search]);

  const back = (
    <Link to="/clips" search={{ ...search }} className={styles.back}>
      <Icon name="chevronLeft" size={18} />
      All clips
    </Link>
  );

  if (clip.isPending) return <Loading label="Loading the clip…" />;
  if (clip.isError) {
    return (
      <>
        {back}
        <Alert tone="error" title="Cannot show this clip">
          {errorMessage(clip.error)}
        </Alert>
      </>
    );
  }

  const c = clip.data.clip;
  return (
    <>
      {back}
      <PageHeader
        title={`${kindLabel(c.kind)} · ${c.deviceName}`}
        lead={<time dateTime={c.capturedAt}>{longDateTime(c.capturedAt)}</time>}
        actions={
          <nav className={styles.stepper} aria-label="Other clips">
            <StepLink id={newerId} search={search} label="Newer" icon="chevronLeft" />
            <StepLink id={olderId} search={search} label="Older" icon="chevronRight" />
          </nav>
        }
      />

      <Card className={styles.playerCard}>
        <AudioPlayer
          ref={player}
          url={audioUrl(c.id)}
          label={`${kindLabel(c.kind).toLowerCase()} from ${c.deviceName}`}
        />
        <div className={styles.under}>
          <p className={styles.keys}>
            <kbd>Space</kbd> play or pause · <kbd>←</kbd> newer · <kbd>→</kbd> older
          </p>
          <a className={buttonClass("ghost", "small")} href={audioUrl(c.id, true)} download>
            Download WAV
          </a>
        </div>
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>What the device reported</h2>
        <Details clip={c} />
      </Card>
    </>
  );
}

function StepLink({
  id,
  search,
  label,
  icon,
}: {
  id: string | null;
  search: ClipSearch;
  label: string;
  icon: "chevronLeft" | "chevronRight";
}) {
  const content =
    icon === "chevronLeft" ? (
      <>
        <Icon name={icon} size={18} />
        {label}
      </>
    ) : (
      <>
        {label}
        <Icon name={icon} size={18} />
      </>
    );
  if (!id) {
    return (
      <span
        className={`${buttonClass("secondary", "small")} ${styles.disabled}`}
        aria-disabled="true"
      >
        {content}
      </span>
    );
  }
  return (
    <Link
      to="/clips/$clipId"
      params={{ clipId: id }}
      search={search}
      className={buttonClass("secondary", "small")}
      aria-label={`${label} clip`}
    >
      {content}
    </Link>
  );
}

function Details({ clip: c }: { clip: Clip }) {
  const db = (x: number | null) => (x === null ? "silent" : `${x.toFixed(1)} dBFS`);
  const s = c.sensitivity;
  return (
    <dl className={styles.details}>
      <dt>Kind</dt>
      <dd>
        <KindChip kind={c.kind} />
        {c.stopWord && " (stop word)"}
      </dd>
      <dt>Score</dt>
      <dd>
        <ScoreBar score={c.score} threshold={c.threshold} />
        <span className={styles.hint}>
          {c.score !== null && scoreSummary(c.score, c.threshold)}
        </span>
      </dd>
      <dt>Wake word</dt>
      <dd>
        {c.wakeWord} on {c.engine}
        {c.trigger && ` (${c.trigger})`}
      </dd>
      {c.decoded !== null && (
        <>
          <dt>Decoded phonemes</dt>
          <dd>
            <code className={styles.phonemes}>{c.decoded}</code>
            {c.editDistance !== null && (
              <span className={styles.hint}>
                Edit distance from the wake word: {c.editDistance}
              </span>
            )}
          </dd>
        </>
      )}
      <dt>Levels</dt>
      <dd>
        Peak {db(c.peakDb)} · average {db(c.rmsDb)}
      </dd>
      <dt>Clipping</dt>
      <dd>
        {c.clippedSamples > 0 ? (
          <>
            <ClippedChip samples={c.clippedSamples} />
            <span className={styles.hint}>
              {c.clippedSamples.toLocaleString("en-GB")} samples hit full scale. Clipped audio
              misleads listeners and models; lowering the microphone gain helps.
            </span>
          </>
        ) : (
          "None"
        )}
      </dd>
      <dt>Length</dt>
      <dd>{(c.durationMs / 1000).toFixed(2)} s, 16 kHz mono</dd>
      <dt>Device</dt>
      <dd>
        {c.deviceName}
        {c.deviceRemoved && " (removed)"}
      </dd>
      {s && (
        <>
          <dt>Device settings then</dt>
          <dd>
            {[s.engine, s.sensitivity, s.fineTune !== null ? `fine-tune ${s.fineTune}` : null]
              .filter(Boolean)
              .join(" · ") || "not reported"}
          </dd>
        </>
      )}
      <dt>Collected</dt>
      <dd>{longDateTime(c.ingestedAt)}</dd>
    </dl>
  );
}
