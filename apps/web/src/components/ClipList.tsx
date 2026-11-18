import { Link } from "@tanstack/react-router";
import type { KeyboardEvent } from "react";
import type { Clip, ClipSearch } from "../clips.ts";
import { shortDateTime } from "../format.ts";
import { usePlayer } from "../player.tsx";
import { AgreementChip } from "./Agreement.tsx";
import { ClippedChip, EngineName, KindChip, PlayButton, ScoreBar } from "./ClipBits.tsx";
import styles from "./ClipList.module.css";

// A list of clips, newest first. Each row opens the clip; its play button
// plays it in place. Every row names the engine beside the score, because
// engines score on different scales, and what the judges said once any
// judge has answered. Keyboard: ↑/↓ move between rows, Space plays the
// focused row, Enter opens it.

export function ClipList({
  clips,
  search = {},
  showDevice = true,
  label,
}: {
  clips: Clip[];
  search?: ClipSearch;
  showDevice?: boolean;
  label: string;
}) {
  const player = usePlayer();

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-clip-row]");
    if (!row) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-clip-row]")];
    const index = rows.indexOf(row);
    const focusRow = (i: number) => rows[i]?.querySelector<HTMLElement>("a")?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(Math.min(index + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(Math.max(index - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(rows.length - 1);
    } else if (event.key === " " && (event.target as HTMLElement).tagName === "A") {
      event.preventDefault();
      const id = row.dataset.clipRow;
      if (id) player.toggle(id);
    }
  };

  return (
    <div className={styles.container}>
      <ul className={styles.list} aria-label={label} onKeyDown={onKeyDown}>
        {clips.map((clip) => (
          <li
            key={clip.id}
            data-clip-row={clip.id}
            className={`${styles.row} ${player.current === clip.id ? styles.current : ""}`}
          >
            <PlayButton clip={clip} />
            <Link
              to="/clips/$clipId"
              params={{ clipId: clip.id }}
              search={search}
              className={styles.open}
              aria-keyshortcuts="Space ArrowUp ArrowDown"
            >
              <time dateTime={clip.capturedAt}>{shortDateTime(clip.capturedAt)}</time>
            </Link>
            <span className={styles.where}>
              {showDevice && (
                <span
                  className={styles.device}
                  title={`${clip.deviceName}${clip.deviceRemoved ? " (removed)" : ""}`}
                >
                  {clip.deviceName}
                  {clip.deviceRemoved && <span className={styles.removed}> (removed)</span>}
                </span>
              )}
              <EngineName engine={clip.engine} className={styles.engine} />
            </span>
            <span className={styles.kind}>
              <KindChip kind={clip.kind} />
            </span>
            <span className={styles.measure}>
              <span className={styles.score}>
                <ScoreBar score={clip.score} threshold={clip.threshold} />
              </span>
              <span className={styles.judges}>
                {clip.judging.agreement !== "waiting" && <AgreementChip judging={clip.judging} />}
              </span>
              <span className={styles.flags}>
                <ClippedChip clip={clip} labelClassName={styles.clippedLabel} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
