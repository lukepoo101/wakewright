import { Alert } from "./ui.tsx";

// Kiosk Satellite saves clips only while "wake word diagnostics" is on.
// Wakewright changes no device setting but the wake word sensitivity of a
// collection session (ADR 0020), so the user turns diagnostics on by hand.

export function DiagnosticsSteps() {
  return (
    <ol>
      <li>
        On the device, open Kiosk Satellite's settings (swipe in from the left edge), or open its
        remote admin page in a browser.
      </li>
      <li>
        Go to <strong>Voice Satellite</strong>, then <strong>Wake word diagnostics</strong>.
      </li>
      <li>
        Turn on <strong>Enable wake word diagnostics</strong>.
      </li>
    </ol>
  );
}

export function DiagnosticsOff({ name }: { name?: string }) {
  return (
    <Alert tone="warning" title={`Wake word diagnostics are off${name ? ` on ${name}` : ""}`}>
      <p>
        The device saves no clips until they are on, so Wakewright has nothing to collect. Turning
        them on keeps the last 10 wake words and 10 near misses on the device.
      </p>
      <DiagnosticsSteps />
    </Alert>
  );
}
