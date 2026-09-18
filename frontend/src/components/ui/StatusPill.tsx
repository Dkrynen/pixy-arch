type Props = {
  tone: "good" | "warn" | "info";
  label: string;
};

export function StatusPill({ tone, label }: Props) {
  return (
    <span className={`status-pill tone-${tone}`}>
      <span className="status-pill-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
