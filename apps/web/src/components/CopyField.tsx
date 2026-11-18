import { useEffect, useId, useState } from "react";
import { copyText } from "../workers.ts";
import styles from "./CopyField.module.css";
import { Button } from "./ui.tsx";

// A value to copy, such as a token or a command: shown in full (or as
// `shown`, when the full text would not fit) with a Copy button that says
// when it has copied.

export function CopyField({
  label,
  value,
  shown,
  multiline,
  hint,
  autoFocus,
}: {
  label: string;
  value: string;
  /** What to display instead of the full value; the full value is copied. */
  shown?: string;
  multiline?: boolean;
  hint?: string;
  /** Focus its Copy button when a dialog opens, rather than a text field. */
  autoFocus?: boolean;
}) {
  const id = useId();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <figure className={styles.field} aria-labelledby={`${id}-label`}>
      <figcaption className={styles.head}>
        <span id={`${id}-label`} className={styles.label}>
          {label}
        </span>
        <Button
          size="small"
          data-autofocus={autoFocus ? "" : undefined}
          icon={state === "copied" ? "check" : "copy"}
          onClick={async () => setState((await copyText(value)) ? "copied" : "failed")}
          aria-label={state === "copied" ? `${label} copied` : `Copy ${label.toLowerCase()}`}
        >
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </figcaption>
      <pre className={`${styles.value} ${multiline ? styles.multiline : ""}`}>{shown ?? value}</pre>
      <span className={styles.status} role="status">
        {state === "failed" ? "Could not copy: select the text and copy it yourself." : ""}
      </span>
      {hint && <span className={styles.hint}>{hint}</span>}
    </figure>
  );
}
