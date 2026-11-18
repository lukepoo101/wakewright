import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { call, errorMessage, v1 } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { DiagnosticsOff } from "../components/DiagnosticsHelp.tsx";
import { SessionBanners } from "../components/SessionBanners.tsx";
import { StatusMark } from "../components/StatusMark.tsx";
import {
  Alert,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Loading,
  PageHeader,
} from "../components/ui.tsx";
import {
  adviceFor,
  detailFor,
  type Device,
  deviceState,
  devicesKey,
  useCollection,
  useDevices,
} from "../devices.ts";
import { ago, plural, shortDateTime, useNow } from "../format.ts";
import styles from "./DevicesPage.module.css";

export function DevicesPage() {
  const devices = useDevices();
  const addLink = (
    <Link to="/devices/new" className={buttonClass("primary")}>
      Add device
    </Link>
  );
  return (
    <>
      <PageHeader
        title="Devices"
        lead="The voice satellites Wakewright collects clips from. It reads from them, and changes their wake word sensitivity only during a collection session you start."
        actions={devices.data?.devices.length ? addLink : undefined}
      />
      <SessionBanners />
      {devices.isPending && <Loading label="Loading devices…" />}
      {devices.isError && (
        <Alert tone="error" title="Cannot load devices">
          {errorMessage(devices.error)}
        </Alert>
      )}
      {devices.data && devices.data.devices.length === 0 && (
        <Card>
          <EmptyState icon="devices" title="Add your first satellite" action={addLink}>
            Wakewright collects the clips a Kiosk Satellite device saves when its wake word fires or
            nearly fires. You need the device's address and its remote administration password.
          </EmptyState>
        </Card>
      )}
      <ul className={styles.list}>
        {devices.data?.devices.map((device) => (
          <li key={device.id}>
            <DeviceCard device={device} />
          </li>
        ))}
      </ul>
    </>
  );
}

function DeviceCard({ device }: { device: Device }) {
  const now = useNow();
  const queryClient = useQueryClient();
  const paused = useCollection().data?.paused ?? false;
  const [confirming, setConfirming] = useState(false);
  const poll = useMutation({
    mutationFn: () => call(v1.devices[":id"].poll.$post({ param: { id: device.id } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devicesKey }),
  });
  const remove = useMutation({
    mutationFn: () => call(v1.devices[":id"].$delete({ param: { id: device.id } })),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({ queryKey: devicesKey });
    },
  });

  const { status, reported } = device;
  const state = deviceState(device, paused);
  const statusText = {
    paused: "Paused",
    waiting: "Waiting for the first poll",
    ok: `Collecting · checked ${ago(status.lastSuccessAt, now)}`,
    diagnosticsOff: `Not collecting: wake word diagnostics are off · checked ${ago(status.lastSuccessAt, now)}`,
    failing: `Failing · ${plural(status.failures, "attempt")} · ${
      status.lastSuccessAt ? `last worked ${ago(status.lastSuccessAt, now)}` : "never worked yet"
    }`,
  }[state];
  const advice = status.error ? adviceFor(status.error.code) : null;
  const titleId = `device-${device.id}`;

  return (
    <Card className={styles.card}>
      <article aria-labelledby={titleId}>
        <div className={styles.top}>
          <div className={styles.heading}>
            <StatusMark state={state} className={styles.mark} />
            <div>
              <h2 id={titleId}>{device.name}</h2>
              <p className={styles.address}>
                {device.baseUrl}
                {reported?.name &&
                  reported.name !== device.name &&
                  ` · reports as “${reported.name}”`}
              </p>
            </div>
          </div>
          <div className={styles.actions}>
            <Button
              size="small"
              icon="refresh"
              onClick={() => poll.mutate()}
              disabled={poll.isPending || paused}
              title={paused ? "Collection is paused" : undefined}
            >
              {poll.isPending ? "Checking…" : "Check now"}
            </Button>
            {device.collectionSession ? (
              <Link
                to="/collect/$sessionId"
                params={{ sessionId: device.collectionSession.id }}
                className={buttonClass("primary", "small")}
              >
                {device.collectionSession.state === "running"
                  ? "Session running"
                  : "Open its session"}
              </Link>
            ) : (
              <Link
                to="/collect/new"
                search={{ device: device.id }}
                className={buttonClass("secondary", "small")}
                aria-label={`Start a collection session on ${device.name}`}
              >
                Collection session
              </Link>
            )}
            <Link
              to="/devices/$deviceId/edit"
              params={{ deviceId: device.id }}
              className={buttonClass("secondary", "small")}
              aria-label={`Edit ${device.name}`}
            >
              Edit
            </Link>
            <Button
              size="small"
              variant="danger"
              onClick={() => setConfirming(true)}
              aria-label={`Remove ${device.name}`}
            >
              Remove
            </Button>
          </div>
        </div>

        <dl className={styles.facts}>
          <dt>Status</dt>
          <dd className={styles[`text_${state}`]}>{statusText}</dd>
          <dt>Wake word</dt>
          <dd>{wakeWordSummary(device)}</dd>
          <dt>Sensitivity</dt>
          <dd>
            {reported?.sensitivity ?? "not reported"}
            {reported?.fineTune != null && `, fine-tune ${signed(reported.fineTune)}`}
          </dd>
          <dt>Diagnostics</dt>
          <dd>{diagnosticsText(reported?.diagnosticsEnabled)}</dd>
          <dt>Clips</dt>
          <dd>
            {device.clips > 0 ? (
              <Link to="/clips" search={{ device: device.id }}>
                {plural(device.clips, "clip")}
              </Link>
            ) : (
              "none yet"
            )}
            {device.lastClipAt && ` · latest ${ago(device.lastClipAt, now)}`}
          </dd>
        </dl>

        <div className={styles.alerts}>
          {status.error && advice && (
            <Alert tone="error" title={advice.title} live="status">
              {detailFor(status.error.code, status.error.message) && <p>{status.error.message}</p>}
              <p>{advice.fix}</p>
            </Alert>
          )}
          {poll.isError && (
            <Alert tone="error" title="Could not check the device">
              {errorMessage(poll.error)}
            </Alert>
          )}
          {reported?.diagnosticsEnabled === false && <DiagnosticsOff />}
          {status.gaps > 0 && status.lastGapAt && (
            <Alert tone="warning" title="Some clips may have been missed">
              The device keeps only its last 10 wake words and 10 near misses, and it saved more
              than that between two checks ({plural(status.gaps, "time")}, last{" "}
              {shortDateTime(status.lastGapAt)}). This happens when Wakewright was stopped or could
              not reach the device for a while.
            </Alert>
          )}
        </div>
      </article>

      <ConfirmDialog
        open={confirming}
        title={`Remove ${device.name}?`}
        confirmLabel="Remove device"
        danger
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Wakewright stops collecting from this device and forgets its password. The{" "}
          {plural(device.clips, "clip")} already collected stay. Nothing changes on the device.
          {device.collectionSession &&
            " It cannot be removed while its collection session has not put its settings back."}
        </p>
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
      </ConfirmDialog>
    </Card>
  );
}

function wakeWordSummary(device: Device): string {
  const r = device.reported;
  if (!r) return "not read yet";
  const words = r.wakeWords?.length ? r.wakeWords.join(", ") : "unknown wake word";
  return r.engine ? `${words} on ${r.engine}` : words;
}

function diagnosticsText(enabled: boolean | null | undefined): string {
  if (enabled === true) return "On: the device saves its wake words and near misses";
  if (enabled === false) return "Off: the device saves no clips";
  return "not read yet";
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
