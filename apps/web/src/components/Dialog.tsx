import { type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./ConfirmDialog.module.css";

// A modal on the native <dialog>, which traps focus, closes on Escape and
// returns focus to the opener. ConfirmDialog is the yes-or-no version.

export function Dialog({
  open,
  title,
  children,
  actions,
  wide,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The buttons along the bottom; a form inside can have its own instead. */
  actions?: ReactNode;
  /** Room for code and long values. */
  wide?: boolean;
  /** Escape, or the caller's own close button. */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // showModal() focuses the first control; a child can ask for another.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`${styles.dialog} ${wide ? styles.wide : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <h2 id={titleId}>{title}</h2>
          <div className={`${styles.body} ${actions ? "" : styles.last}`}>{children}</div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </>
      )}
    </dialog>
  );
}
