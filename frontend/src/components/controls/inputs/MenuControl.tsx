import type { V4L2Control } from "../../../types/api";
import { ControlShell } from "./ControlShell";

type Props = {
  control: V4L2Control;
  allControls?: V4L2Control[];
  disabled: boolean;
  onSetValue: (value: number) => Promise<void>;
};

export function MenuControl({ control, allControls, disabled, onSetValue }: Props) {
  const isInactive = control.flags.includes("inactive");

  return (
    <ControlShell control={control} allControls={allControls}>
      <select
        className="menu-select"
        aria-label={control.label}
        value={control.value}
        disabled={disabled || isInactive}
        onChange={(event) => void onSetValue(Number(event.target.value))}
      >
        {control.menu.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </ControlShell>
  );
}
