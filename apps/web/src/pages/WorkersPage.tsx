import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { call, errorMessage, v1 } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CopyField } from "../components/CopyField.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { StatusMark } from "../components/StatusMark.tsx";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Loading,
  PageHeader,
  TextField,
} from "../components/ui.tsx";
import { ago, useNow } from "../format.ts";
import {
  allowedText,
  pairingString,
  startCommands,
  suggestedAddress,
  validAddress,
  typeName,
  type Worker,
  type WorkerList,
  workerState,
  workerStatusText,
  workersKey,
  useWorkers,
} from "../workers.ts";
import styles from "./WorkersPage.module.css";

// Workers: every worker, declared ones (read-only) first, then those
// created here, which can be edited, paused, given a new token or deleted.
// Creating a worker or giving it a new token shows the token once, with a
// pairing string and how to start a worker with it.

/** A token to show once, for the worker it belongs to. */
type Shown = { worker: Worker; token: string; fresh: boolean };

export function WorkersPage() {
  const workers = useWorkers();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const list = workers.data?.workers ?? [];
  const add = (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      Add worker
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Workers"
        lead="Workers judge your clips. Each has its own token: create one here, or set it in this server's configuration."
        actions={list.length > 0 ? add : undefined}
      />
      {workers.isPending && <Loading label="Loading workers…" />}
      {workers.isError && (
        <Alert tone="error" title="Cannot load workers">
          {errorMessage(workers.error)}
        </Alert>
      )}
      {workers.data && list.length === 0 && (
        <Card>
          <EmptyState icon="workers" title="No workers yet" action={add}>
            A worker asks its judges whether each clip contains its wake word. Add one to get its
            token, then start it on any computer that can reach this server. Workers can also be set
            in the server's configuration, and appear here when it starts.
          </EmptyState>
        </Card>
      )}
      {list.length > 0 && (
        <ul className={styles.list}>
          {list.map((w) => (
            <li key={w.id}>
              <WorkerCard
                worker={w}
                data={workers.data as WorkerList}
                onToken={(token, worker) => setShown({ worker, token, fresh: false })}
              />
            </li>
          ))}
        </ul>
      )}
      {workers.data && (
        <WorkerFormDialog
          open={creating}
          data={workers.data}
          onClose={() => setCreating(false)}
          onCreated={(worker, token) => {
            setCreating(false);
            setShown({ worker, token, fresh: true });
          }}
        />
      )}
      {workers.data && shown && (
        <TokenDialog shown={shown} data={workers.data} onClose={() => setShown(null)} />
      )}
    </>
  );
}

function WorkerCard({
  worker: w,
  data,
  onToken,
}: {
  worker: Worker;
  data: WorkerList;
  onToken: (token: string, worker: Worker) => void;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "token" | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: workersKey });
  const declared = w.source === "config";

  const toggle = useMutation({
    mutationFn: () =>
      call(v1.workers[":id"].$patch({ param: { id: w.id }, json: { enabled: !w.enabled } })),
    onSuccess: refresh,
  });
  const regenerate = useMutation({
    mutationFn: () => call(v1.workers[":id"].token.$post({ param: { id: w.id } })),
    onSuccess: (out) => {
      setConfirm(null);
      void refresh();
      onToken(out.token, out.worker);
    },
  });
  const remove = useMutation({
    mutationFn: () => call(v1.workers[":id"].$delete({ param: { id: w.id } })),
    onSuccess: () => {
      setConfirm(null);
      void refresh();
    },
  });

  const state = workerState(w);
  const titleId = `worker-${w.id}`;
  const offered = w.reported.types;
  const allowed = (name: string) => w.allowedJudges === null || w.allowedJudges.includes(name);

  return (
    <Card>
      <article aria-labelledby={titleId}>
        <div className={styles.top}>
          <div className={styles.heading}>
            <StatusMark state={state} className={styles.mark} />
            <div>
              <h2 id={titleId}>{w.name}</h2>
              <span className={`${styles.source} ${declared ? styles.declared : ""}`}>
                {declared ? "Set by configuration" : "Created here"}
              </span>
            </div>
          </div>
          {!declared && (
            <div className={styles.actions}>
              <Button
                size="small"
                icon={w.enabled ? "pauseCircle" : "playCircle"}
                onClick={() => toggle.mutate()}
                disabled={toggle.isPending}
                aria-label={`${w.enabled ? "Pause" : "Resume"} ${w.name}`}
              >
                {w.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                size="small"
                icon="edit"
                onClick={() => setEditing(true)}
                aria-label={`Edit ${w.name}`}
              >
                Edit
              </Button>
              <Button
                size="small"
                icon="key"
                onClick={() => setConfirm("token")}
                aria-label={`New token for ${w.name}`}
              >
                New token
              </Button>
              <Button
                size="small"
                variant="danger"
                icon="trash"
                onClick={() => setConfirm("delete")}
                aria-label={`Delete ${w.name}`}
              >
                Delete
              </Button>
            </div>
          )}
        </div>

        <dl className={styles.facts}>
          <dt>Status</dt>
          <dd className={styles[`text_${state}`]}>{workerStatusText(w, now)}</dd>
          <dt>Reports as</dt>
          <dd>
            {w.reported.name ? (
              <>
                <span className={styles.mono}>{w.reported.name}</span>
                {w.reported.version && ` · version ${w.reported.version}`}
              </>
            ) : (
              "nothing yet: it has not connected"
            )}
          </dd>
          <dt>May run</dt>
          <dd>{allowedText(w, data.typeNames)}</dd>
          <dt>Offers</dt>
          <dd>
            {offered.length === 0
              ? "nothing yet"
              : offered.map((j, i) => (
                  <span key={j.id}>
                    {i > 0 && ", "}
                    <span className={allowed(j.id) ? "" : styles.notAllowed}>
                      {typeName(data.typeNames, j.id)}
                      {!allowed(j.id) && " (not allowed)"}
                    </span>
                  </span>
                ))}
          </dd>
          {w.notes && (
            <>
              <dt>Notes</dt>
              <dd className={styles.notes}>{w.notes}</dd>
            </>
          )}
          <dt>Token</dt>
          <dd>
            {declared ? (
              "from configuration"
            ) : (
              <>
                {w.token.hint && <span className={styles.mono}>{w.token.hint}…</span>}
                {w.token.hint && " · "}
                made {ago(w.token.createdAt, now)}
              </>
            )}
          </dd>
        </dl>

        {declared && (
          <p className={styles.declaredNote}>
            Change or remove it in the server's configuration; it is applied when the server starts.
          </p>
        )}
        {toggle.isError && <Alert tone="error">{errorMessage(toggle.error)}</Alert>}
      </article>

      {!declared && (
        <>
          <WorkerFormDialog
            open={editing}
            data={data}
            worker={w}
            onClose={() => setEditing(false)}
          />
          <ConfirmDialog
            open={confirm === "token"}
            title={`Give ${w.name} a new token?`}
            confirmLabel="Make a new token"
            busy={regenerate.isPending}
            onConfirm={() => regenerate.mutate()}
            onCancel={() => setConfirm(null)}
          >
            <p>
              The current token stops working at once. The worker disconnects until you start it
              with the new one, and the clips it was judging go back to the queue.
            </p>
            {regenerate.isError && <Alert tone="error">{errorMessage(regenerate.error)}</Alert>}
          </ConfirmDialog>
          <ConfirmDialog
            open={confirm === "delete"}
            title={`Delete ${w.name}?`}
            confirmLabel="Delete worker"
            danger
            busy={remove.isPending}
            onConfirm={() => remove.mutate()}
            onCancel={() => setConfirm(null)}
          >
            <p>
              Its token stops working at once, and the clips it was judging go to other workers. The
              verdicts it already gave stay, under its name.
            </p>
            {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
          </ConfirmDialog>
        </>
      )}
    </Card>
  );
}

// Create a worker, or edit one: name, notes and the judges it may run.
function WorkerFormDialog({
  open,
  data,
  worker,
  onClose,
  onCreated,
}: {
  open: boolean;
  data: WorkerList;
  worker?: Worker;
  onClose: () => void;
  onCreated?: (worker: Worker, token: string) => void;
}) {
  return (
    <Dialog open={open} title={worker ? `Edit ${worker.name}` : "Add a worker"} onClose={onClose}>
      {open && <WorkerForm data={data} worker={worker} onClose={onClose} onCreated={onCreated} />}
    </Dialog>
  );
}

function WorkerForm({
  data,
  worker,
  onClose,
  onCreated,
}: {
  data: WorkerList;
  worker?: Worker;
  onClose: () => void;
  onCreated?: (worker: Worker, token: string) => void;
}) {
  const queryClient = useQueryClient();
  const notesId = useId();
  const [name, setName] = useState(worker?.name ?? "");
  const [notes, setNotes] = useState(worker?.notes ?? "");
  const [all, setAll] = useState(worker ? worker.allowedJudges === null : true);
  const [chosen, setChosen] = useState<string[]>(worker?.allowedJudges ?? data.judges);
  const [touched, setTouched] = useState(false);

  const save = useMutation({
    mutationFn: async () => {
      const json = { name: name.trim(), notes: notes.trim(), allowedJudges: all ? null : chosen };
      if (worker) {
        await call(v1.workers[":id"].$patch({ param: { id: worker.id }, json }));
        return null;
      }
      return call(v1.workers.$post({ json }));
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: workersKey });
      if (created) onCreated?.(created.worker, created.token);
      else onClose();
    },
  });

  const missing = {
    name: !name.trim() ? "Give the worker a name." : undefined,
    judges: !all && chosen.length === 0 ? "Choose at least one judge type." : undefined,
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!missing.name && !missing.judges) save.mutate();
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <TextField
        label="Name"
        name="worker-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint="Shown on Home, on this page and beside each verdict it gives, for example Study PC."
        error={touched ? missing.name : undefined}
        maxLength={64}
        autoComplete="off"
        required
      />
      <div className={styles.textareaField}>
        <label htmlFor={notesId}>Notes</label>
        <textarea
          id={notesId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={500}
        />
        <span className={styles.hint}>Optional: where it runs, who looks after it.</span>
      </div>
      <fieldset className={styles.judgesField}>
        <legend>Judge types it may run</legend>
        <label className={styles.choice}>
          <input type="radio" name="all" checked={all} onChange={() => setAll(true)} />
          All judge types, including ones it offers later
        </label>
        <label className={styles.choice}>
          <input type="radio" name="all" checked={!all} onChange={() => setAll(false)} />
          Only these
        </label>
        <div className={styles.checks} aria-disabled={all}>
          {data.judges.map((j) => (
            <label key={j} className={styles.choice}>
              <input
                type="checkbox"
                disabled={all}
                checked={all || chosen.includes(j)}
                onChange={(e) =>
                  setChosen((c) => (e.target.checked ? [...c, j] : c.filter((x) => x !== j)))
                }
              />
              {typeName(data.typeNames, j)}
            </label>
          ))}
        </div>
        {touched && missing.judges && <span className={styles.error}>{missing.judges}</span>}
        <span className={styles.hint}>
          It is sent clips only for judges whose type it offers and may run. A judge that sends
          clips to a cloud service runs only on workers allowed its type.
        </span>
      </fieldset>
      {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      <div className={styles.formButtons}>
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {save.isPending ? "Saving…" : worker ? "Save changes" : "Create worker"}
        </Button>
      </div>
    </form>
  );
}

// The token, once: a pairing string for this server's address (editable,
// as a worker may reach it at another one), the bare token, and how to
// start Wakewright's worker with it.
function TokenDialog({
  shown,
  data,
  onClose,
}: {
  shown: Shown;
  data: WorkerList;
  onClose: () => void;
}) {
  const [address, setAddress] = useState(suggestedAddress(data.publicUrl));
  const ok = validAddress(address);
  const pairing = ok ? pairingString(address, shown.token) : "";
  const short = ok ? `${pairing.slice(0, 28)}…` : "";
  const commands = startCommands(pairing, data.version);
  const display = startCommands(short, data.version);

  return (
    <Dialog
      open
      wide
      title={
        shown.fresh
          ? `${shown.worker.name} is ready to connect`
          : `New token for ${shown.worker.name}`
      }
      onClose={onClose}
      actions={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <Alert tone="warning" title="Copy it now">
        Wakewright shows this token only once and keeps only a fingerprint of it. If you lose it,
        make a new one.
      </Alert>
      <TextField
        label="Address workers use to reach this server"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        hint="Change it if the worker reaches this server at another address."
        error={ok ? undefined : "Enter an address starting with http:// or https://."}
        inputMode="url"
        spellCheck={false}
        autoComplete="off"
      />
      {ok && (
        <CopyField
          label="Pairing string"
          value={pairing}
          hint="The address and the token in one value: paste it into the worker."
          autoFocus
        />
      )}
      <CopyField
        label="Token"
        value={shown.token}
        hint="For a worker set up with an address and a token."
      />
      {ok && (
        <div className={styles.start}>
          <h3>Start a worker</h3>
          <p>With Docker, on any machine that can reach this server:</p>
          <CopyField label="Docker" value={commands.docker} shown={display.docker} multiline />
          <p>
            Or from a clone of the Wakewright repository, in <code>apps/worker</code>, with uv:
          </p>
          <CopyField label="uv" value={commands.uv} shown={display.uv} multiline />
          <p className={styles.hint}>
            It downloads its models (about 2.5 GB) on first start, then shows here as connected.
          </p>
        </div>
      )}
    </Dialog>
  );
}
