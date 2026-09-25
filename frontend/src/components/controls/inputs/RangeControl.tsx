import { useEffect, useState } from "react";

import { controlDisplayLabel } from "../../../domains/controls/display";
import { rangeFill } from "../../../lib/rangeFill";
import type { V4L2Control } from "../../../types/api";
import { ControlShell } from "./ControlShell";

type Props = {
  control: V4L2Control;
  allControls?: V4L2Control[];
  disabled: boolean;
  onSetValue: (value: number) => Promise<void>;
};

export function RangeControl({ control, allControls, disabled, onSetValue }: Props) {
  const [draftValue, setDraftValue] = useState(control.value);
  const isInactive = control.flags.includes("inactive");
  const min = control.min ?? 0;
  const max = control.max ?? 100;
  const step = control.step && control.step > 0 ? control.step : 1;
  // A degenerate range (e.g. zoom_continuous reporting 0..0) leaves nothing to adjust.
  const notAdjustable = min >= max;
  const unavailable = disabled || isInactive || notAdjustable;

  useEffect(() => {
    setDraftValue(control.value);
  }, [control.value]);

  const commitDraftValue = () => {
    if (!unavailable && draftValue !== control.value) {
      void onSetValue(draftValue);
    }
  };

  return (
    <ControlShell control={control} allControls={allControls}>
      <input
        className="range-input"
        type="range"
        aria-label={controlDisplayLabel(control)}
        min={min}
        max={max}
        step={step}
        value={draftValue}
        style={rangeFill(draftValue, min, max)}
        disabled={unavailable}
        onChange={(event) => setDraftValue(Number(event.target.value))}
        onPointerUp={commitDraftValue}
        onBlur={commitDraftValue}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitDraftValue();
          }
        }}
      />
    </ControlShell>
  );
}
