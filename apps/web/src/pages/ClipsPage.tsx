import { Link, useNavigate } from "@tanstack/react-router";
import { errorMessage } from "../api.ts";
import { ClipList } from "../components/ClipList.tsx";
import { Icon } from "../components/Icon.tsx";
import {
  Alert,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Loading,
  PageHeader,
} from "../components/ui.tsx";
import { type ClipSearch, PAGE_SIZE, useClipEngines, useClips } from "../clips.ts";
import { useDevices } from "../devices.ts";
import { JUDGES_FILTERS, type JudgesFilter, useJudgingStatus } from "../judging.ts";
import styles from "./ClipsPage.module.css";

export function ClipsPage({ search }: { search: ClipSearch }) {
  const navigate = useNavigate();
  const clips = useClips(search);
  const devices = useDevices();
  const engines = useClipEngines();
  const judging = useJudgingStatus();
  const filtered = Boolean(
    search.device || search.kind || search.engine || search.from || search.to || search.judges,
  );
  const disagreements = search.judges === "disagree";
  // The quick filter shows once there is something judged to filter.
  const judged = (judging.data?.judged ?? 0) > 0;

  const update = (change: Partial<ClipSearch>) =>
    navigate({ to: "/clips", search: { ...search, ...change, page: undefined }, replace: true });

  const page = search.page ?? 1;
  const total = clips.data?.total ?? 0;
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(page * PAGE_SIZE, total);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Clips"
        lead="Wake words and near misses your devices saved, newest first."
        actions={
          (judged || disagreements) && (
            <Button
              variant={disagreements ? "primary" : "secondary"}
              icon="notEqual"
              aria-pressed={disagreements}
              onClick={() => update({ judges: disagreements ? undefined : "disagree" })}
            >
              Disagreements
              {judging.data && (
                <span className={styles.count}>
                  {judging.data.disagree.toLocaleString("en-GB")}
                </span>
              )}
            </Button>
          )
        }
      />

      <form
        className={styles.filters}
        aria-label="Filter clips"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className={styles.filter}>
          <span>Device</span>
          <select
            value={search.device ?? ""}
            onChange={(e) => update({ device: e.target.value || undefined })}
          >
            <option value="">All devices</option>
            {devices.data?.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span>Kind</span>
          <select
            value={search.kind ?? ""}
            onChange={(e) => update({ kind: (e.target.value || undefined) as ClipSearch["kind"] })}
          >
            <option value="">All kinds</option>
            <option value="fired">Wake words</option>
            <option value="near_miss">Near misses</option>
          </select>
        </label>
        <label className={styles.filter}>
          <span>Engine</span>
          <select
            value={search.engine ?? ""}
            onChange={(e) => update({ engine: e.target.value || undefined })}
          >
            <option value="">All engines</option>
            {engines.data?.engines.map((engine) => (
              <option key={engine} value={engine}>
                {engine}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span>Judges</span>
          <select
            value={search.judges ?? ""}
            onChange={(e) =>
              update({ judges: (e.target.value || undefined) as JudgesFilter | undefined })
            }
          >
            <option value="">Any verdict</option>
            {JUDGES_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.filter}>
          <span>From</span>
          <input
            type="date"
            value={search.from ?? ""}
            max={search.to}
            onChange={(e) => update({ from: e.target.value || undefined })}
          />
        </label>
        <label className={styles.filter}>
          <span>To</span>
          <input
            type="date"
            value={search.to ?? ""}
            min={search.from}
            onChange={(e) => update({ to: e.target.value || undefined })}
          />
        </label>
      </form>

      {clips.isPending && <Loading label="Loading clips…" />}
      {clips.isError && (
        <Alert tone="error" title="Cannot load clips">
          {errorMessage(clips.error)}
        </Alert>
      )}

      {clips.data && total === 0 && (
        <Card>
          {filtered ? (
            <EmptyState
              icon="clips"
              title="No clips match these filters"
              action={
                <Button onClick={() => navigate({ to: "/clips", search: {}, replace: true })}>
                  Clear filters
                </Button>
              }
            >
              {search.judges && judging.data && judgingNote(judging.data)}
            </EmptyState>
          ) : devices.data?.devices.length === 0 ? (
            <EmptyState
              icon="devices"
              title="No clips yet"
              action={
                <Link to="/devices/new" className={buttonClass("primary")}>
                  Add a device
                </Link>
              }
            >
              Add a Kiosk Satellite device and its clips will appear here.
            </EmptyState>
          ) : (
            <EmptyState icon="clips" title="No clips yet">
              Clips appear here a few seconds after a device hears its wake word, or nearly does. If
              nothing arrives, check on the Devices screen that wake word diagnostics are on.
            </EmptyState>
          )}
        </Card>
      )}

      {clips.data && total > 0 && (
        <Card className={styles.results}>
          <div className={styles.summary}>
            <div className={styles.countLine}>
              <p role="status">
                {first.toLocaleString("en-GB")}–{last.toLocaleString("en-GB")} of{" "}
                {total.toLocaleString("en-GB")} clips
              </p>
              {filtered && (
                <Button
                  variant="ghost"
                  className={styles.clear}
                  onClick={() => navigate({ to: "/clips", search: {}, replace: true })}
                >
                  Clear filters
                </Button>
              )}
            </div>
            <p className={styles.keys}>
              <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>Space</kbd> play · <kbd>Enter</kbd> open
            </p>
          </div>
          <ClipList clips={clips.data.clips} search={search} label="Clips" />
          {pages > 1 && (
            <nav className={styles.pager} aria-label="Pages">
              <Button
                icon="chevronLeft"
                disabled={page <= 1}
                onClick={() => navigate({ to: "/clips", search: { ...search, page: page - 1 } })}
              >
                Newer
              </Button>
              <span>
                Page {page} of {pages}
              </span>
              <Button
                disabled={page >= pages}
                onClick={() => navigate({ to: "/clips", search: { ...search, page: page + 1 } })}
              >
                Older
                <Icon name="chevronRight" />
              </Button>
            </nav>
          )}
        </Card>
      )}
    </>
  );
}

// Why a judges filter may match nothing yet.
function judgingNote(status: { workers: unknown[]; judged: number; waiting: number }) {
  if (status.workers.length === 0) return "There are no workers yet, so no clip has been judged.";
  if (status.judged === 0) return "No clip has been judged yet.";
  if (status.waiting > 0) {
    return `${status.waiting.toLocaleString("en-GB")} ${status.waiting === 1 ? "clip is" : "clips are"} still waiting to be judged.`;
  }
  return null;
}
