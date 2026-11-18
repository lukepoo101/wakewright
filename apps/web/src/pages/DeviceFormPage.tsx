import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { InferResponseType } from "hono/client";
import { type FormEvent, useState } from "react";
import { ApiError, call, errorMessage, v1 } from "../api.ts";
import { DiagnosticsOff } from "../components/DiagnosticsHelp.tsx";
import {
  Alert,
  Button,
  buttonClass,
  Card,
  Loading,
  PageHeader,
  TextField,
} from "../components/ui.tsx";
import { adviceFor, detailFor, type Device, devicesKey, useDevices } from "../devices.ts";
import { plural } from "../format.ts";
import styles from "./DeviceFormPage.module.css";

// Add or edit a Kiosk Satellite device. "Test connection" logs in and
// reads the device without saving; saving tests again on the server.

type TestResult = InferResponseType<typeof v1.devices.test.$post, 200>;

export function NewDevicePage() {
  return <DeviceForm />;
}

export function EditDevicePage({ deviceId }: { deviceId: string }) {
  const devices = useDevices();
  if (devices.isPending) return <Loading />;
  const device = devices.data?.devices.find((d) => d.id === deviceId);
  if (!device) {
    return (
      <>
        <PageHeader title="Edit device" />
        <Alert tone="error" title="No such device">
          It may have been removed. <Link to="/devices">Back to devices</Link>
        </Alert>
      </>
    );
  }
  return <DeviceForm device={device} />;
}

function DeviceForm({ device }: { device?: Device }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(device?.name ?? "");
  const [address, setAddress] = useState(device?.baseUrl ?? "");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [touched, setTouched] = useState(false);

  const test = useMutation({
    mutationFn: () =>
      call(
        v1.devices.test.$post({
          json: {
            baseUrl: address,
            ...(password ? { password } : { deviceId: device?.id }),
          },
        }),
      ),
    onSuccess: (data) => {
      setResult(data);
      if (data.ok && !name.trim() && data.reported.name) setName(data.reported.name);
    },
  });

  const save = useMutation({
    mutationFn: (skipTest: boolean) => {
      if (device) {
        return call(
          v1.devices[":id"].$patch({
            param: { id: device.id },
            json: {
              name,
              ...(address !== device.baseUrl ? { baseUrl: address } : {}),
              ...(password ? { password } : {}),
              skipTest,
            },
          }),
        );
      }
      return call(v1.devices.$post({ json: { name, baseUrl: address, password, skipTest } }));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: devicesKey });
      await navigate({ to: "/devices" });
    },
  });

  const missing = {
    name: !name.trim() ? "Give the device a name." : undefined,
    address: !address.trim() ? "Enter the device's address." : undefined,
    password:
      !device && !password ? "Enter the device's remote administration password." : undefined,
  };
  const canSubmit = !missing.name && !missing.address && !missing.password;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (canSubmit) save.mutate(false);
  };

  const saveError = save.error instanceof ApiError ? save.error : null;
  const offline = saveError?.code === "unreachable" || saveError?.code === "timeout";
  const title = device ? `Edit ${device.name}` : "Add a device";

  return (
    <>
      <PageHeader
        title={title}
        lead="A Kiosk Satellite device on your network. Wakewright logs in with its remote administration password and reads from it. It changes only the wake word sensitivity, during a collection session you start."
      />
      <Card className={styles.card}>
        <form className={styles.form} onSubmit={submit} noValidate>
          <TextField
            label="Name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            hint="How Wakewright labels this device's clips, for example Kitchen."
            error={touched ? missing.name : undefined}
            autoComplete="off"
            required
          />
          <TextField
            label="Address"
            name="address"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              setResult(null); // the last test no longer applies
            }}
            hint={
              <>
                The device's IP address or host name, such as <code>192.168.1.40</code>. Port 2324
                is added if you leave it out; use <code>https://</code> if you turned HTTPS on.
              </>
            }
            error={touched ? missing.address : undefined}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
          />
          <TextField
            label="Remote administration password"
            name="device-password"
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setResult(null);
            }}
            hint={
              device
                ? "Leave empty to keep the stored password."
                : "The password set in Kiosk Satellite under Device, Remote Administration. Stored encrypted."
            }
            error={touched ? missing.password : undefined}
            autoComplete="new-password"
            required={!device}
          />

          <div className={styles.results} aria-live="polite">
            {test.isError && <Alert tone="error">{errorMessage(test.error)}</Alert>}
            {result && <TestOutcome result={result} />}
            {saveError && (
              <Alert tone="error" title={adviceFor(saveError.code).title}>
                {detailFor(saveError.code, saveError.message) && <p>{saveError.message}</p>}
                <p>{adviceFor(saveError.code).fix}</p>
                {offline && (
                  <div>
                    <Button
                      size="small"
                      onClick={() => save.mutate(true)}
                      disabled={save.isPending}
                    >
                      Save anyway and keep trying
                    </Button>
                  </div>
                )}
              </Alert>
            )}
            {save.error && !saveError && <Alert tone="error">{errorMessage(save.error)}</Alert>}
          </div>

          <div className={styles.buttons}>
            <Button
              onClick={() => {
                setTouched(true);
                if (!missing.address && !missing.password) test.mutate();
              }}
              disabled={test.isPending}
            >
              {test.isPending ? "Testing…" : "Test connection"}
            </Button>
            <span className={styles.spacer} />
            <Link to="/devices" className={buttonClass("ghost")}>
              Cancel
            </Link>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : device ? "Save changes" : "Add device"}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function TestOutcome({ result }: { result: TestResult }) {
  if (!result.ok) {
    const advice = adviceFor(result.error.code);
    return (
      <Alert tone="error" title={advice.title}>
        {detailFor(result.error.code, result.error.message) && <p>{result.error.message}</p>}
        <p>{advice.fix}</p>
      </Alert>
    );
  }
  const r = result.reported;
  const facts = [
    r.engine,
    r.wakeWords?.join(", "),
    r.sensitivity,
    `${plural(result.clips, "clip")} saved on the device`,
  ].filter(Boolean);
  return (
    <>
      <Alert tone="success" title={`Connected${r.name ? ` to “${r.name}”` : ""}`}>
        {facts.join(" · ")}
      </Alert>
      {r.diagnosticsEnabled === false && <DiagnosticsOff />}
    </>
  );
}
