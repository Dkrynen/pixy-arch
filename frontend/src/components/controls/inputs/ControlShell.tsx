import { controlDisplayLabel, dependencyHint, rawControlTitle } from "../../../domains/controls/display";
import { controlValueText } from "../../../domains/controls/grouping";
import type { V4L2Control } from "../../../types/api";

type Props = {
  control: V4L2Control;
  allControls?: V4L2Control[];
  /** Hide the trailing value readout when the input already shows it (toggles). */
  showValue?: boolean;
  children: React.ReactNode;
};

export function ControlShell({ control, allControls, showValue = true, children }: Props) {
  const inactive = control.flags.includes("inactive");
  const hint = inactive ? (allControls ? dependencyHint(control, allControls) : null) : null;

  return (
    <div
      className={`control-row ${inactive ? "is-inactive" : ""} ${showValue ? "" : "no-value"}`}
      title={rawControlTitle(control)}
    >
      <div className="control-copy">
        <span>{controlDisplayLabel(control)}</span>
        {inactive && <small>{hint ?? "Inactive while auto mode is enabled"}</small>}
      </div>
      <div className="control-input-zone">{children}</div>
      {showValue && <output>{controlValueText(control)}</output>}
    </div>
  );
}
