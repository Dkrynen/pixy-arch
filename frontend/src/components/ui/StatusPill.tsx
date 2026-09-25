type Props = {
  tone: "good" | "warn" | "danger" | "info" | "neutral";
  label: string;
  /** Hover detail, e.g. the control count behind a "Connected" chip. */
  title?: string;
  /** Pulse the dot for live states such as recording. */
  pulse?: boolean;
};

export function StatusPill({ tone, label, title, pulse = false }: Props) {
  return (
    <span className={`status-pill tone-${tone}${pulse ? " is-pulsing" : ""}`} title={title}>
      <span className="status-pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
