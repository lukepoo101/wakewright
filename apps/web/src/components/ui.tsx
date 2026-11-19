import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
} from "react";
import { Icon, type IconName } from "./Icon.tsx";
import styles from "./ui.module.css";

// Small shared components on native elements. Each keeps its label, focus
// and state visible and announced.

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function buttonClass(variant: Variant = "secondary", size?: "small", iconOnly?: boolean) {
  return [
    styles.button,
    styles[variant],
    size === "small" ? styles.small : "",
    iconOnly ? styles.iconOnly : "",
  ].join(" ");
}

export function Button({
  variant = "secondary",
  size,
  icon,
  label,
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "small";
  icon?: IconName;
  /** For an icon-only button: its accessible name, also shown as a tooltip. */
  label?: string;
}) {
  const iconOnly = icon !== undefined && children === undefined;
  return (
    <button
      type={type}
      className={`${buttonClass(variant, size, iconOnly)} ${className ?? ""}`}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      {...props}
    >
      {icon && <Icon name={icon} size={size === "small" ? 18 : 20} />}
      {children}
    </button>
  );
}

export function TextField({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
        {...props}
      />
      {error && (
        <span id={errorId} className={styles.fieldError}>
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
    </div>
  );
}

/** A TextField on several lines, for long text such as a prompt. */
export function TextAreaField({
  label,
  hint,
  error,
  footer,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  /** Below the hint, for example a button that fills the field. */
  footer?: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <textarea
        id={id}
        className={`${styles.input} ${styles.textarea}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
        {...props}
      />
      {error && (
        <span id={errorId} className={styles.fieldError}>
          {error}
        </span>
      )}
      {hint && (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      )}
      {footer}
    </div>
  );
}

const toneIcon = {
  info: "info",
  success: "check",
  warning: "warning",
  error: "error",
} as const satisfies Record<string, IconName>;

export function Alert({
  tone,
  title,
  children,
  live = tone === "error" ? "alert" : undefined,
}: {
  tone: keyof typeof toneIcon;
  title?: string;
  children?: ReactNode;
  /** "alert" for errors that appear after an action; "status" for updates. */
  live?: "alert" | "status";
}) {
  return (
    <div className={`${styles.alert} ${styles[tone]}`} role={live}>
      <Icon name={toneIcon[tone]} />
      <div className={styles.alertBody}>
        {title && <span className={styles.alertTitle}>{title}</span>}
        {children}
      </div>
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={`${styles.card} ${className ?? ""}`}>{children}</section>;
}

export function PageHeader({
  title,
  lead,
  actions,
}: {
  title: string;
  lead?: ReactNode;
  actions?: ReactNode;
}) {
  useTitle(title);
  return (
    <div className={styles.pageHeader}>
      <div className={styles.pageHeaderText}>
        <h1>{title}</h1>
        {lead && <p className={styles.lead}>{lead}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <Icon name={icon} size={40} />
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={styles.visuallyHidden}>{children}</span>;
}

/** Sets the document title to "<page> · Wakewright". */
export function useTitle(page: string) {
  useEffect(() => {
    document.title = `${page} · Wakewright`;
  }, [page]);
}
