import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { ApiError, call, errorMessage, v1 } from "../api.ts";
import { Logo, ThemeButton } from "../components/Layout.tsx";
import { Alert, Button, Card, TextField, useTitle } from "../components/ui.tsx";
import { sessionKey } from "../session.ts";
import styles from "./AuthPages.module.css";

// First-run setup and sign-in. Shown in place of the app until the browser
// holds a session, so they need no routes of their own.

const MIN_PASSWORD = 12;

export function AuthScreen({ wide, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <main className={styles.screen}>
      <div className={styles.tools}>
        <ThemeButton />
      </div>
      <div className={styles.brand}>
        <Logo size={36} />
        <span>Wakewright</span>
      </div>
      <div className={`${styles.panel} ${wide ? styles.wide : ""}`}>{children}</div>
    </main>
  );
}

export function SetupPage() {
  useTitle("Set up");
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState(false);
  const setup = useMutation({
    mutationFn: () => call(v1.setup.$post({ json: { username, password } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKey }),
  });

  const tooShort = password.length < MIN_PASSWORD;
  const mismatch = confirm !== password;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!tooShort && !mismatch) setup.mutate();
  };

  return (
    <AuthScreen wide>
      <div className={styles.heading}>
        <h1>Set up Wakewright</h1>
        <p>
          Create the admin account. You will use it to sign in from any browser on your network.
        </p>
      </div>
      <Card>
        <form className={styles.form} onSubmit={submit} noValidate>
          {setup.isError && (
            <Alert tone="error" title="Could not create the account">
              {errorMessage(setup.error)}
            </Alert>
          )}
          <TextField
            label="Username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={`At least ${MIN_PASSWORD} characters. A few random words work well.`}
            error={touched && tooShort ? `Use at least ${MIN_PASSWORD} characters.` : undefined}
            required
          />
          <TextField
            label="Confirm password"
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={touched && mismatch ? "The passwords do not match." : undefined}
            required
          />
          <Button type="submit" variant="primary" disabled={setup.isPending}>
            {setup.isPending ? "Creating…" : "Create account"}
          </Button>
        </form>
      </Card>
      <p className={styles.consent}>
        <strong>What Wakewright keeps</strong>
        Short 3-second recordings from around the moments your voice assistant heard, or nearly
        heard, its wake word. They may include anyone in the room. They stay on this computer, are
        used only to make the wake word work better, and are kept until you delete them.
      </p>
    </AuthScreen>
  );
}

export function LoginPage({ managed }: { managed: boolean }) {
  useTitle("Sign in");
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useMutation({
    mutationFn: () => call(v1.session.$post({ json: { username, password } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sessionKey }),
    onError: () => setPassword(""),
  });

  const error = signIn.error;
  return (
    <AuthScreen>
      <div className={styles.heading}>
        <h1>Sign in</h1>
      </div>
      <Card>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            signIn.mutate();
          }}
        >
          {error && (
            <Alert
              tone="error"
              title={
                error instanceof ApiError && error.status === 429
                  ? "Too many attempts"
                  : "Could not sign in"
              }
            >
              {errorMessage(error)}
            </Alert>
          )}
          <TextField
            label="Username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint={managed ? "The password is set in this server's configuration." : undefined}
            required
          />
          <Button type="submit" variant="primary" disabled={signIn.isPending}>
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </AuthScreen>
  );
}
