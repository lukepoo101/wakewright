import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { audioUrl } from "./clips.ts";

// One shared <audio> element for playing clips from lists. Reusing a
// single element keeps playback working on phones, which allow audio only
// after a tap, and means starting one clip stops the last.

interface Player {
  /** The clip loaded in the player, playing or paused. */
  current: string | null;
  playing: boolean;
  /** Plays a clip from the start, or pauses/resumes it if it is current. */
  toggle(id: string): void;
  stop(): void;
  error: string | null;
}

const PlayerContext = createContext<Player | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useMemo(() => new Audio(), []);
  const [current, setCurrent] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPlay = () => setPlaying(true);
    const onStop = () => setPlaying(false);
    const onError = () => {
      setPlaying(false);
      setError("The clip could not be played.");
    };
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onStop);
    audio.addEventListener("ended", onStop);
    audio.addEventListener("error", onError);
    return () => {
      audio.pause();
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onStop);
      audio.removeEventListener("ended", onStop);
      audio.removeEventListener("error", onError);
    };
  }, [audio]);

  const player = useMemo<Player>(
    () => ({
      current,
      playing,
      error,
      toggle(id) {
        setError(null);
        if (id === current) {
          if (audio.paused) void audio.play().catch(() => {});
          else audio.pause();
          return;
        }
        audio.src = audioUrl(id);
        setCurrent(id);
        void audio.play().catch(() => {});
      },
      stop() {
        audio.pause();
        setCurrent(null);
      },
    }),
    [audio, current, playing, error],
  );

  return <PlayerContext.Provider value={player}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): Player {
  const player = useContext(PlayerContext);
  if (!player) throw new Error("usePlayer needs a PlayerProvider");
  return player;
}
