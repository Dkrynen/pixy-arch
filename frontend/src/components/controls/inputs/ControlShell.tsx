import { dependencyHint } from "../../../domains/controls/display";
import { controlValueText } from "../../../domains/controls/grouping";
import type { V4L2Control } from "../../../types/api";

type Props = {
  control: V4L2Control;
  allControls?: V4L2Control[];
  children: React.ReactNode;
};

export function ControlShell({ control, allControls, children }: Props) {
  const inactive = control.flags.includes("inactive");
  const hint = inactive ? (allControls ? dependencyHint(control, allControls) : null) : null;

  return (
    <div className={`control-row ${inactive ? "is-inactive" : ""}`}>
      <div className="control-copy">
        <span>{control.label}</span>
        <small>{inactive ? (hint ?? "Inactive while auto mode is enabled") : control.name}</small>
      </div>
      <div className="control-input-zone">{children}</div>
      <output>{controlValueText(control)}</output>
    </div>
  );
}
