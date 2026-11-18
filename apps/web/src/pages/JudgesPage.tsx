import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { DEFAULT_RULE, type OutcomeRule, type Vote, weigh } from "@wakewright/parent/outcome";
import { type FormEvent, useEffect, useId, useState } from "react";
import { call, errorMessage, v1 } from "../api.ts";
import { useClips } from "../clips.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Dialog } from "../components/Dialog.tsx";
import { Icon } from "../components/Icon.tsx";
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
import { ago, shortDateTime, useNow } from "../format.ts";
import { OUTCOME_LABELS, signedScore } from "../judging.ts";
import {
  healthMark,
  healthText,
  type Judge,
  type JudgeList,
  type JudgeType,
  judgesKey,
  KIND_LABELS,
  type SettingField,
  type SettingValue,
  useJudges,
  weightText,
} from "../judges.ts";
import styles from "./JudgesPage.module.css";

// Judges: how their weighted votes become an outcome (margin, minimum and
// a live example), then every judge with its health, runs today and the
// workers that can run it, to add, edit, test, turn off or delete. A
// judge's settings form comes from its type's schema, as the worker that
// offers the type describes it; secrets are never shown again once saved.

export function JudgesPage() {
  const judges = useJudges();
  const [adding, setAdding] = useState(false);
  const data = judges.data;
  const add = (
    <Button
      variant="primary"
      icon="plus"
      onClick={() => setAdding(true)}
      disabled={!data || data.types.filter((t) => t.advertised).length === 0}
    >
      Add judge
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Judges"
        lead="Each judge says whether a clip contains its wake word. Their votes, weighted, decide each clip's outcome."
        actions={add}
      />
      {judges.isPending && <Loading label="Loading judges…" />}
      {judges.isError && (
        <Alert tone="error" title="Cannot load judges">
          {errorMessage(judges.error)}
        </Alert>
      )}
      {data && (
        <div className={styles.layout}>
          <div className={styles.main}>
            {data.judges.length === 0 ? (
              <Card>
                <EmptyState icon="judges" title="No judges" action={add}>
                  Add a judge of a type a worker offers. Start a worker first if there are none.
                </EmptyState>
              </Card>
            ) : (
              <ul className={styles.list}>
                {data.judges.map((j) => (
                  <li key={j.id}>
                    <JudgeCard judge={j} data={data} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <RuleCard data={data} />
        </div>
      )}
      {data && <JudgeFormDialog open={adding} data={data} onClose={() => setAdding(false)} />}
    </>
  );
}

function JudgeCard({ judge: j, data }: { judge: Judge; data: JudgeList }) {
  const now = useNow();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "enable" | null>(null);
  const refresh = () => queryClient.invalidateQueries();
  const type = data.types.find((t) => t.id === j.type);
  const titleId = `judge-${j.id}`;

  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      call(v1.judges[":id"].$patch({ param: { id: j.id }, json: { enabled } })),
    onSuccess: () => {
      setConfirm(null);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => call(v1.judges[":id"].$delete({ param: { id: j.id } })),
    onSuccess: () => {
      setConfirm(null);
      void refresh();
    },
  });
  const health = healthMark(j);

  return (
    <Card>
      <article aria-labelledby={titleId}>
        <div className={styles.top}>
          <div className={styles.heading}>
            <StatusMark state={health} className={styles.mark} />
            <div>
              <h2 id={titleId}>{j.name}</h2>
              <span className={styles.typeLine}>
                {j.typeName} · {KIND_LABELS[j.kind]}
              </span>
              {j.external && (
                <span className={styles.external}>
                  <Icon name="cloud" size={14} /> Sends clips to a third party
                </span>
              )}
            </div>
          </div>
          <div className={styles.weightBox} title="How much its vote counts">
            <span className={styles.weightValue}>{weightText(j.weight)}</span>
            <span className={styles.weightLabel}>{j.weight === 0 ? "not counted" : "weight"}</span>
          </div>
        </div>

        <dl className={styles.facts}>
          <dt>Status</dt>
          <dd className={styles[`text_${health}`]}>{healthText(j, now)}</dd>
          <dt>Last 24 hours</dt>
          <dd>
            {j.judged24h.toLocaleString("en-GB")} {j.judged24h === 1 ? "clip" : "clips"} judged
            {j.attempts24h > j.judged24h && ` · ${j.attempts24h - j.judged24h} failed`}
            {j.dailyLimit !== null && ` · limit ${j.dailyLimit.toLocaleString("en-GB")} a day`}
          </dd>
          <dt>Runs on</dt>
          <dd>{j.workers.length > 0 ? j.workers.join(", ") : "no connected worker"}</dd>
          {type && type.settings.length > 0 && (
            <>
              <dt>Settings</dt>
              <dd>
                <SettingsSummary judge={j} type={type} />
              </dd>
            </>
          )}
          {j.lastError && j.health !== "failing" && (
            <>
              <dt>Last error</dt>
              <dd className={styles.muted}>
                {j.lastError.message} · {ago(j.lastError.at, now)}
              </dd>
            </>
          )}
        </dl>

        <div className={styles.actions}>
          <Button size="small" icon="playCircle" onClick={() => setTesting(true)}>
            Test
          </Button>
          <Button
            size="small"
            icon="edit"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${j.name}`}
          >
            Edit
          </Button>
          <Button
            size="small"
            icon={j.enabled ? "pauseCircle" : "playCircle"}
            disabled={toggle.isPending}
            onClick={() =>
              j.enabled
                ? toggle.mutate(false)
                : j.external
                  ? setConfirm("enable")
                  : toggle.mutate(true)
            }
            aria-label={`${j.enabled ? "Turn off" : "Turn on"} ${j.name}`}
          >
            {j.enabled ? "Turn off" : "Turn on"}
          </Button>
          <Button
            size="small"
            variant="danger"
            icon="trash"
            onClick={() => setConfirm("delete")}
            aria-label={`Delete ${j.name}`}
          >
            Delete
          </Button>
        </div>
        {toggle.isError && <Alert tone="error">{errorMessage(toggle.error)}</Alert>}
      </article>

      <JudgeFormDialog open={editing} data={data} judge={j} onClose={() => setEditing(false)} />
      {testing && <TestDialog judge={j} onClose={() => setTesting(false)} />}
      <ConfirmDialog
        open={confirm === "enable"}
        title={`Turn on ${j.name}?`}
        confirmLabel="Turn on and send clips"
        busy={toggle.isPending}
        onConfirm={() => toggle.mutate(true)}
        onCancel={() => setConfirm(null)}
      >
        <p>
          {j.name} sends every clip it judges to {serviceName(j)}. Clips can include anyone in the
          room. Check that service's terms and data settings first.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "delete"}
        title={`Delete ${j.name}?`}
        confirmLabel="Delete judge"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirm(null)}
      >
        <p>
          It stops judging and its votes stop counting, so outcomes may change. The verdicts it
          already gave stay visible on each clip, marked as from a deleted judge.
        </p>
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
      </ConfirmDialog>
    </Card>
  );
}

// Where an external judge sends clips: the host of its base URL, if it has one.
function serviceName(j: Judge): string {
  const url = j.settings.base_url;
  if (typeof url === "string") {
    try {
      return new URL(url).host;
    } catch {
      // fall through
    }
  }
  return `the ${j.typeName} service`;
}

function SettingsSummary({ judge, type }: { judge: Judge; type: JudgeType }) {
  return (
    <ul className={styles.settings}>
      {type.settings.map((f) => {
        const value =
          f.type === "secret"
            ? judge.secrets[f.key]
              ? "set"
              : "not set"
            : formatValue(judge.settings[f.key] ?? null, f);
        return (
          <li key={f.key}>
            <span className={styles.muted}>{f.label}:</span>{" "}
            <span className={f.type === "secret" ? "" : styles.mono}>{value}</span>
          </li>
        );
      })}
    </ul>
  );
}

function formatValue(v: SettingValue, f: SettingField): string {
  if (v === null || v === "") return "none";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (f.type === "select") return f.options.find((o) => o.value === v)?.label ?? String(v);
  return String(v);
}

// The margin and minimum, explained, with an example made of the current
// judges whose votes can be flipped.
function RuleCard({ data }: { data: JudgeList }) {
  const queryClient = useQueryClient();
  const [margin, setMargin] = useState(String(data.rule.margin));
  const [minimum, setMinimum] = useState(String(data.rule.minimum));
  const counted = data.judges.filter((j) => j.enabled && j.weight > 0);
  const [votes, setVotes] = useState<Record<string, Vote["verdict"]>>({});
  const voteOf = (j: Judge): Vote["verdict"] =>
    votes[j.id] ?? (j.kind === "speech_to_text" ? "yes" : "no");
  const rule: OutcomeRule = {
    margin: clampNumber(margin, 0, 1, data.rule.margin),
    minimum: clampNumber(minimum, 0, 100, data.rule.minimum),
  };
  const example = weigh(
    counted.map((j) => ({ verdict: voteOf(j), weight: j.weight })),
    rule,
  );
  const changed = rule.margin !== data.rule.margin || rule.minimum !== data.rule.minimum;
  const save = useMutation({
    mutationFn: () => call(v1.judging.rule.$put({ json: rule })),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return (
    <Card className={styles.rule}>
      <h2>How the outcome is decided</h2>
      <p>
        Each judge that answers yes or no votes with its weight. The score is the yes weight minus
        the no weight, divided by all the weight that voted: +1 when all say yes, −1 when all say
        no. A judge that cannot tell does not vote.
      </p>
      <ul className={styles.ruleList}>
        <li>
          <strong>Yes</strong> when the score is {signedScore(rule.margin)} or more,{" "}
          <strong>no</strong> when it is {signedScore(-rule.margin)} or less, otherwise{" "}
          <strong>uncertain</strong>.
        </li>
        <li>
          <strong>Not enough evidence</strong> when less than {rule.minimum.toFixed(1)} of weight
          voted, so a weak judge alone cannot decide.
        </li>
        <li>
          <strong>Waiting</strong> while a judge that counts has still to answer.
        </li>
      </ul>
      <form
        className={styles.ruleForm}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <TextField
          label="Margin"
          type="number"
          inputMode="decimal"
          min={0}
          max={1}
          step={0.05}
          value={margin}
          onChange={(e) => setMargin(e.target.value)}
          hint={`0 to 1. Default ${DEFAULT_RULE.margin}.`}
        />
        <TextField
          label="Minimum weight"
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          value={minimum}
          onChange={(e) => setMinimum(e.target.value)}
          hint={`Default ${DEFAULT_RULE.minimum.toFixed(1)}: one speech-to-text judge.`}
        />
        <div className={styles.ruleButtons}>
          <Button type="submit" variant="primary" disabled={!changed || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {(rule.margin !== DEFAULT_RULE.margin || rule.minimum !== DEFAULT_RULE.minimum) && (
            <Button
              variant="ghost"
              onClick={() => {
                setMargin(String(DEFAULT_RULE.margin));
                setMinimum(String(DEFAULT_RULE.minimum));
              }}
            >
              Use defaults
            </Button>
          )}
        </div>
        {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
        {save.isSuccess && !changed && (
          <Alert tone="success" live="status">
            Saved. Every clip's outcome follows at once; nothing is judged again.
          </Alert>
        )}
      </form>

      {counted.length > 0 && (
        <div className={styles.example}>
          <h3>Try it</h3>
          <p className={styles.muted}>Pick what each judge says about an imaginary clip.</p>
          <ul className={styles.exampleList}>
            {counted.map((j) => (
              <li key={j.id}>
                <span className={styles.exampleName}>
                  {j.name} <span className={styles.muted}>({weightText(j.weight)})</span>
                </span>
                <fieldset className={styles.segmented} aria-label={`${j.name} says`}>
                  {(["yes", "no", "abstain"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={voteOf(j) === v}
                      onClick={() => setVotes((x) => ({ ...x, [j.id]: v }))}
                    >
                      {v === "abstain" ? "Can't tell" : v === "yes" ? "Yes" : "No"}
                    </button>
                  ))}
                </fieldset>
              </li>
            ))}
          </ul>
          <p className={styles.exampleResult} role="status">
            {example.score === null ? "No votes" : `Score ${signedScore(example.score)}`}
            {" · "}
            {(example.yesWeight + example.noWeight).toFixed(1)} of weight voted →{" "}
            <strong>{OUTCOME_LABELS[example.provisional ?? "not_enough"]}</strong>
          </p>
        </div>
      )}
    </Card>
  );
}

function clampNumber(raw: string, low: number, high: number, fallback: number): number {
  const n = Number(raw);
  return raw.trim() === "" || !Number.isFinite(n) ? fallback : Math.min(high, Math.max(low, n));
}

// Add a judge, or edit one: name, type (when adding), the type's settings,
// weight, daily limit and whether it is on.
function JudgeFormDialog({
  open,
  data,
  judge,
  onClose,
}: {
  open: boolean;
  data: JudgeList;
  judge?: Judge;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} wide title={judge ? `Edit ${judge.name}` : "Add a judge"} onClose={onClose}>
      {open && <JudgeForm data={data} judge={judge} onClose={onClose} />}
    </Dialog>
  );
}

function JudgeForm({
  data,
  judge,
  onClose,
}: {
  data: JudgeList;
  judge?: Judge;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const offered = data.types.filter((t) => t.advertised || t.id === judge?.type);
  const [typeId, setTypeId] = useState(judge?.type ?? offered[0]?.id ?? "");
  const type = data.types.find((t) => t.id === typeId);
  const [name, setName] = useState(judge?.name ?? "");
  const [weight, setWeight] = useState(
    judge ? String(judge.weight) : String(type ? data.defaults.weight[type.kind] : 1),
  );
  const [limit, setLimit] = useState(judge?.dailyLimit ? String(judge.dailyLimit) : "");
  const [enabled, setEnabled] = useState(judge?.enabled ?? !type?.external);
  const [understood, setUnderstood] = useState(judge?.enabled ?? false);
  const [values, setValues] = useState<Record<string, SettingValue>>(() =>
    initialValues(type, judge),
  );
  // Secrets: undefined keeps the stored one; a string replaces it; null removes it.
  const [secrets, setSecrets] = useState<Record<string, string | null | undefined>>({});
  const [touched, setTouched] = useState(false);

  const pickType = (id: string) => {
    const t = data.types.find((x) => x.id === id);
    setTypeId(id);
    setValues(initialValues(t, undefined));
    setSecrets({});
    setWeight(String(t ? data.defaults.weight[t.kind] : 1));
    setEnabled(!t?.external);
    setUnderstood(false);
  };

  const save = useMutation({
    mutationFn: async () => {
      const settings: Record<string, unknown> = { ...values };
      for (const [k, v] of Object.entries(secrets)) if (v !== undefined) settings[k] = v;
      const common = {
        name: name.trim(),
        weight: Number(weight),
        dailyLimit: limit.trim() === "" ? null : Number(limit),
        enabled,
        settings,
      };
      if (judge) {
        await call(v1.judges[":id"].$patch({ param: { id: judge.id }, json: common }));
      } else {
        await call(v1.judges.$post({ json: { ...common, type: typeId } }));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      onClose();
    },
  });

  const w = Number(weight);
  const missing: Record<string, string | undefined> = {
    name: !name.trim() ? "Give the judge a name." : undefined,
    weight:
      weight.trim() === "" || !Number.isFinite(w) || w < 0 || w > data.defaults.maxWeight
        ? `Enter a weight from 0 to ${data.defaults.maxWeight}.`
        : undefined,
    limit:
      limit.trim() !== "" && !(Number.isInteger(Number(limit)) && Number(limit) >= 1)
        ? "Enter a whole number of clips, or leave it empty."
        : undefined,
    understood:
      type?.external && enabled && !understood
        ? "Confirm that clips may go to this service, or leave the judge off."
        : undefined,
  };
  for (const f of type?.settings ?? []) {
    if (!f.required) continue;
    if (f.type === "secret") {
      const set = secrets[f.key] ?? (judge?.secrets[f.key] && secrets[f.key] !== null);
      if (!set) missing[f.key] = `Enter the ${f.label}.`;
    } else if (values[f.key] === null || values[f.key] === "") {
      missing[f.key] = `Enter the ${f.label.toLowerCase()}.`;
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.values(missing).every((m) => !m)) save.mutate();
  };
  const err = (key: string) => (touched ? missing[key] : undefined);

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {!judge && <TypePicker types={offered} value={typeId} onChange={pickType} />}
      {type?.external && (
        <Alert tone="warning" title="This judge sends clips to a third party">
          <span>
            Every clip it judges is uploaded to the service you set below. Clips can include anyone
            in the room. Check the service's terms and data settings (some use audio for training)
            before you turn it on.
          </span>
        </Alert>
      )}
      <TextField
        label="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        error={err("name")}
        hint="Shown on Judges and beside each verdict it gives."
        maxLength={64}
        autoComplete="off"
        placeholder={type?.name}
      />
      <div className={styles.pair}>
        <TextField
          label="Weight"
          type="number"
          inputMode="decimal"
          min={0}
          max={data.defaults.maxWeight}
          step={0.1}
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          error={err("weight")}
          hint="How much its vote counts. 0: shown, not counted."
        />
        <TextField
          label="Daily limit"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          error={err("limit")}
          hint="At most this many clips in any 24 hours, newest first. Empty: no limit."
        />
      </div>
      {type?.settings.map((f) => (
        <SettingInput
          key={f.key}
          field={f}
          value={values[f.key] ?? null}
          secretSet={Boolean(judge?.secrets[f.key])}
          secret={secrets[f.key]}
          error={err(f.key)}
          onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))}
          onSecret={(v) => setSecrets((x) => ({ ...x, [f.key]: v }))}
        />
      ))}
      {type?.settings.some((f) => f.affectsVerdict) && (
        <p className={styles.hint}>
          † Changing this later judges every clip again with this judge. Name, weight, limit and the
          other settings change nothing already judged.
        </p>
      )}
      <label className={styles.choice}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        On: run it on clips and count its votes
      </label>
      {type?.external && enabled && (
        <label className={styles.choice}>
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          I understand this sends clips to {settingsHost(values) ?? "this service"}
        </label>
      )}
      {err("understood") && <span className={styles.error}>{err("understood")}</span>}
      {save.isError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
      <div className={styles.formButtons}>
        <Button onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={save.isPending || !type}>
          {save.isPending ? "Saving…" : judge ? "Save changes" : "Add judge"}
        </Button>
      </div>
    </form>
  );
}

// The type of a new judge: a drop-down grouped by kind, each option saying
// when it sends clips to a third party, and below it what the chosen type
// does and which workers offer it.
function TypePicker({
  types,
  value,
  onChange,
}: {
  types: JudgeType[];
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const chosen = types.find((t) => t.id === value);
  const kinds = (Object.keys(KIND_LABELS) as JudgeType["kind"][]).filter((k) =>
    types.some((t) => t.kind === k),
  );
  return (
    <div className={styles.selectField}>
      <label htmlFor={id}>Type</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={chosen ? `${id}-about` : undefined}
      >
        {kinds.map((kind) => (
          <optgroup key={kind} label={KIND_LABELS[kind]}>
            {types
              .filter((t) => t.kind === kind)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.external ? `${t.name} (third party)` : t.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {chosen && (
        <div id={`${id}-about`} className={styles.typeAbout}>
          <span className={styles.typeName}>{chosen.name}</span>
          <span className={styles.typeName}>
            {KIND_LABELS[chosen.kind]}
            {chosen.external ? (
              <span className={styles.external}>
                <Icon name="cloud" size={14} /> Sends clips to a third party
              </span>
            ) : (
              <span className={styles.local}>Runs on the worker</span>
            )}
          </span>
          {chosen.description && <span>{chosen.description}</span>}
          <span className={styles.hint}>
            {chosen.workers.length > 0
              ? `Offered by ${chosen.workers.join(", ")}`
              : "No worker offers it right now"}
          </span>
        </div>
      )}
    </div>
  );
}

function settingsHost(values: Record<string, SettingValue>): string | null {
  const url = values.base_url;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function initialValues(type: JudgeType | undefined, judge: Judge | undefined) {
  const out: Record<string, SettingValue> = {};
  for (const f of type?.settings ?? []) {
    if (f.type === "secret") continue;
    out[f.key] = judge ? (judge.settings[f.key] ?? null) : f.default;
  }
  return out;
}

function SettingInput({
  field: f,
  value,
  secretSet,
  secret,
  error,
  onChange,
  onSecret,
}: {
  field: SettingField;
  value: SettingValue;
  secretSet: boolean;
  secret: string | null | undefined;
  error?: string;
  onChange: (v: SettingValue) => void;
  onSecret: (v: string | null | undefined) => void;
}) {
  const id = useId();
  const optional = !f.required && (f.default === null || f.default === "");
  const label = `${f.label}${f.affectsVerdict ? " †" : ""}${optional ? " (optional)" : ""}`;
  if (f.type === "secret") {
    const replacing = secret !== undefined && secret !== null;
    if (secretSet && !replacing) {
      return (
        <div className={styles.secretSet}>
          <span className={styles.secretLabel}>{f.label}</span>
          <span className={styles.secretValue}>
            <Icon name="key" size={16} />
            {secret === null ? "Will be removed" : "Set"}
          </span>
          <span className={styles.secretButtons}>
            <Button size="small" onClick={() => onSecret("")}>
              Replace
            </Button>
            {!f.required && secret !== null && (
              <Button size="small" variant="ghost" onClick={() => onSecret(null)}>
                Remove
              </Button>
            )}
            {secret === null && (
              <Button size="small" variant="ghost" onClick={() => onSecret(undefined)}>
                Keep
              </Button>
            )}
          </span>
          {f.help && <span className={styles.secretHint}>{f.help}</span>}
        </div>
      );
    }
    return (
      <TextField
        label={label}
        type="password"
        autoComplete="new-password"
        spellCheck={false}
        value={secret ?? ""}
        onChange={(e) => onSecret(e.target.value)}
        error={error}
        hint={`${f.help ? `${f.help} ` : ""}Stored encrypted and never shown again.`}
      />
    );
  }
  if (f.type === "boolean") {
    return (
      <label className={styles.choice}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }
  if (f.type === "select") {
    return (
      <div className={styles.selectField}>
        <label htmlFor={id}>{label}</label>
        <select
          id={id}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
        >
          {!f.required && <option value="">None</option>}
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {error && <span className={styles.error}>{error}</span>}
        {f.help && <span className={styles.hint}>{f.help}</span>}
      </div>
    );
  }
  return (
    <TextField
      label={label}
      type={f.type === "number" ? "number" : "text"}
      inputMode={f.type === "number" ? "decimal" : undefined}
      min={f.minimum ?? undefined}
      max={f.maximum ?? undefined}
      value={value === null ? "" : String(value)}
      placeholder={f.placeholder || undefined}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) =>
        onChange(
          f.type === "number"
            ? e.target.value === ""
              ? null
              : Number(e.target.value)
            : e.target.value,
        )
      }
      error={error}
      hint={f.help || undefined}
    />
  );
}

// Run the judge on one stored clip through a worker and show what it said.
function TestDialog({ judge, onClose }: { judge: Judge; onClose: () => void }) {
  const queryClient = useQueryClient();
  const clips = useClips({}, 20);
  const [clipId, setClipId] = useState("");
  const [testId, setTestId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      call(
        v1.judges[":id"].test.$post({
          param: { id: judge.id },
          json: clipId ? { clipId } : {},
        }),
      ),
    onSuccess: (out) => setTestId(out.test.id),
  });
  const test = useQuery({
    queryKey: ["judge-test", testId],
    enabled: testId !== null,
    queryFn: () => call(v1["judge-tests"][":id"].$get({ param: { id: testId as string } })),
    refetchInterval: (q) =>
      q.state.data && ["done", "expired"].includes(q.state.data.test.state) ? false : 1000,
  });
  const t = test.data?.test;
  useEffect(() => {
    if (t?.state === "done") void queryClient.invalidateQueries({ queryKey: judgesKey });
  }, [t?.state, queryClient]);
  const r = t?.result;

  return (
    <Dialog
      open
      title={`Test ${judge.name}`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon="playCircle"
            disabled={start.isPending || t?.state === "waiting" || t?.state === "running"}
            onClick={() => {
              setTestId(null);
              start.mutate();
            }}
          >
            {t ? "Run again" : "Run test"}
          </Button>
        </>
      }
    >
      <p>
        A worker that can run {judge.typeName} judges one stored clip with these settings, even
        while the judge is off.{judge.external && " The clip is sent to the service."} The verdict
        is kept like any other.
      </p>
      <div className={styles.selectField}>
        <label htmlFor="test-clip">Clip</label>
        <select id="test-clip" value={clipId} onChange={(e) => setClipId(e.target.value)}>
          <option value="">The newest clip it has a model for</option>
          {clips.data?.clips.map((c) => (
            <option key={c.id} value={c.id}>
              {shortDateTime(c.capturedAt)} · {c.deviceName} ·{" "}
              {c.kind === "fired" ? "wake word" : "near miss"}
            </option>
          ))}
        </select>
      </div>
      {start.isError && <Alert tone="error">{errorMessage(start.error)}</Alert>}
      {t && t.state === "waiting" && <Loading label="Waiting for a worker to take the test…" />}
      {t && t.state === "running" && <Loading label="A worker is judging the clip…" />}
      {t && t.state === "expired" && (
        <Alert tone="warning" title="No worker took the test">
          No connected worker offers {judge.typeName} and may run it. Check Workers.
        </Alert>
      )}
      {r && (
        <div className={styles.testResult} role="status">
          {r.verdict === "failed" ? (
            <Alert tone="error" title="It failed">
              {r.detail} {r.failure?.reason && `(${r.failure.reason.replace("_", " ")})`}
            </Alert>
          ) : (
            <Alert
              tone={r.verdict === "abstain" ? "info" : "success"}
              title={
                r.verdict === "yes"
                  ? "Yes: it hears the wake word"
                  : r.verdict === "no"
                    ? "No: not the wake word"
                    : "It could not tell"
              }
            >
              {r.transcript !== null && (
                <span>
                  Heard <q>{r.transcript}</q>.{" "}
                </span>
              )}
              {r.score !== null && (
                <span>
                  Score {r.score}
                  {r.threshold !== null && ` against ${r.threshold}`}.{" "}
                </span>
              )}
              {r.detail && <span>{r.detail} </span>}
            </Alert>
          )}
          <p className={styles.hint}>
            On {r.worker} · {r.durationMs.toLocaleString("en-GB")} ms · version{" "}
            <code>{r.version}</code> ·{" "}
            <Link to="/clips/$clipId" params={{ clipId: (t as { clipId: string }).clipId }}>
              open the clip
            </Link>
          </p>
        </div>
      )}
    </Dialog>
  );
}
