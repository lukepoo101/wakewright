import { type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import styles from "./AudioPlayer.module.css";
import { Icon } from "./Icon.tsx";

// A clip's waveform and playback, drawn in the browser by wavesurfer.js
// from the WAV itself. Clicking or dragging on the waveform seeks; the
// waveform follows the light or dark theme.

export interface AudioPlayerHandle {
  toggle(): void;
}

function themeColours() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    waveColor: v("--color-wave"),
    progressColor: v("--color-wave-progress"),
    cursorColor: v("--color-text"),
  };
}

function seconds(s: number): string {
  return `${s.toFixed(2)} s`;
}

export function AudioPlayer({
  url,
  label,
  ref,
}: {
  url: string;
  /** What is playing, for the play button's accessible name. */
  label: string;
  ref?: Ref<AudioPlayerHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const wave = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    setReady(false);
    setFailed(false);
    setPlaying(false);
    setTime(0);
    const ws = WaveSurfer.create({
      container: container.current,
      url,
      height: 112,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      cursorWidth: 2,
      dragToSeek: true,
      normalize: true,
      ...themeColours(),
    });
    wave.current = ws;
    const subscriptions = [
      ws.on("ready", (d) => {
        setDuration(d);
        setReady(true);
      }),
      ws.on("play", () => setPlaying(true)),
      ws.on("pause", () => setPlaying(false)),
      ws.on("finish", () => setPlaying(false)),
      ws.on("timeupdate", (t) => setTime(t)),
      ws.on("error", () => setFailed(true)),
    ];

    // Redraw in the new colours when the theme changes.
    const recolour = () => ws.setOptions(themeColours());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", recolour);
    const observer = new MutationObserver(recolour);
    observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });

    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
      media.removeEventListener("change", recolour);
      observer.disconnect();
      ws.destroy();
      wave.current = null;
    };
  }, [url]);

  useImperativeHandle(ref, () => ({ toggle: () => void wave.current?.playPause() }), []);

  return (
    <div className={styles.player}>
      <div className={styles.waveWrap}>
        <div
          ref={container}
          className={styles.wave}
          role="img"
          aria-label={ready ? `Waveform, ${seconds(duration)}` : "Waveform loading"}
        />
        {!ready && !failed && <div className={styles.placeholder} aria-hidden="true" />}
        {failed && (
          <p className={styles.error} role="alert">
            The audio could not be loaded.
          </p>
        )}
      </div>
      <div className={styles.controls}>
        <button
          type="button"
          className={styles.play}
          onClick={() => void wave.current?.playPause()}
          disabled={!ready}
          aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        >
          <Icon name={playing ? "pause" : "play"} size={24} />
        </button>
        <span className={styles.time} aria-live="off">
          {seconds(time)} / {seconds(duration)}
        </span>
      </div>
    </div>
  );
}
