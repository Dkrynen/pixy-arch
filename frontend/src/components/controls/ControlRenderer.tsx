import type { V4L2Control } from "../../types/api";
import { BoolControl } from "./inputs/BoolControl";
import { ControlShell } from "./inputs/ControlShell";
import { MenuControl } from "./inputs/MenuControl";
import { RangeControl } from "./inputs/RangeControl";

type Props = {
  control: V4L2Control;
  allControls?: V4L2Control[];
  disabled: boolean;
  onSetValue: (value: number) => Promise<void>;
};

export function ControlRenderer({ control, allControls, disabled, onSetValue }: Props) {
  if (control.kind === "bool") {
    return <BoolControl control={control} allControls={allControls} disabled={disabled} onSetValue={onSetValue} />;
  }

  if (control.kind === "menu") {
    return <MenuControl control={control} allControls={allControls} disabled={disabled} onSetValue={onSetValue} />;
  }

  if (control.kind === "unknown") {
    // The driver reported a control type we cannot safely write (e.g. 64-bit
    // or bitmask controls). Show the last reported value instead of a fake slider.
    return (
      <ControlShell control={control} allControls={allControls}>
        <span aria-label={`${control.label} is not adjustable`}>Not reported</span>
      </ControlShell>
    );
  }

  return <RangeControl control={control} allControls={allControls} disabled={disabled} onSetValue={onSetValue} />;
}
