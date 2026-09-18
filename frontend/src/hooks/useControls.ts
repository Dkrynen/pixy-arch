import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchControls, setControlValue } from "../lib/apiClient";
import { groupControls } from "../domains/controls/grouping";
import type { V4L2Control } from "../types/api";

const ACTIVE_STATE_PARENT_CONTROLS = new Set(["auto_exposure", "white_balance_automatic", "focus_automatic_continuous"]);
// Writing one of these makes the backend flip its auto-mode parent first
// (see DEPENDENCY_CONTROLS in the v4l2 service), so a full refresh is required
// to keep the parent control and inactive flags truthful.
const DEPENDENT_CHILD_CONTROLS = new Set(["exposure_time_absolute", "white_balance_temperature", "focus_absolute"]);
const REFRESH_AFTER_WRITE_KINDS = new Set(["bool", "menu"]);

export type UseControlsResult = {
  controls: V4L2Control[];
  groups: ReturnType<typeof groupControls>;
  isLoading: boolean;
  error: string | null;
  pendingControl: string | null;
  refresh: () => Promise<void>;
  setValue: (controlName: string, value: number) => Promise<void>;
  setValues: (values: { controlName: string; value: number }[]) => Promise<void>;
};

export function useControls(deviceName: string | null): UseControlsResult {
  const [controls, setControls] = useState<V4L2Control[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingControl, setPendingControl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!deviceName) {
      setControls([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      setControls(await fetchControls(deviceName));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load controls");
    } finally {
      setIsLoading(false);
    }
  }, [deviceName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setValue = useCallback(
    async (controlName: string, value: number) => {
      if (!deviceName) {
        return;
      }
      setPendingControl(controlName);
      setError(null);
      const targetControl = controls.find((control) => control.name === controlName);
      const previousValue = targetControl?.value;
      const previousValueLabel = targetControl?.value_label;
      setControls((current) =>
        current.map((control) =>
          control.name === controlName
            ? {
                ...control,
                value,
                value_label: control.menu.find((option) => option.value === value)?.label ?? control.value_label
              }
            : control
        )
      );
      try {
        const updated = await setControlValue(deviceName, controlName, value);
        const wasInactive = targetControl?.flags.includes("inactive") ?? false;
        if (
          ACTIVE_STATE_PARENT_CONTROLS.has(controlName) ||
          DEPENDENT_CHILD_CONTROLS.has(controlName) ||
          wasInactive ||
          REFRESH_AFTER_WRITE_KINDS.has(targetControl?.kind ?? "")
        ) {
          setControls(await fetchControls(deviceName));
        } else {
          setControls((current) =>
            current.map((control) => (control.name === controlName ? updated : control))
          );
        }
      } catch (err) {
        // Roll back only the failed control so concurrent edits elsewhere survive.
        setControls((current) =>
          current.map((control) =>
            control.name === controlName && previousValue !== undefined
              ? { ...control, value: previousValue, value_label: previousValueLabel ?? null }
              : control
          )
        );
        setError(err instanceof Error ? err.message : "Unable to set control");
      } finally {
        setPendingControl(null);
      }
    },
    [controls, deviceName]
  );

  const setValues = useCallback(
    async (values: { controlName: string; value: number }[]) => {
      if (!deviceName || values.length === 0) {
        return;
      }
      setPendingControl("preset");
      setError(null);
      try {
        for (const item of values) {
          await setControlValue(deviceName, item.controlName, item.value);
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to apply preset");
        await refresh();
      } finally {
        setPendingControl(null);
      }
    },
    [deviceName, refresh]
  );

  const groups = useMemo(() => groupControls(controls), [controls]);

  return {
    controls,
    groups,
    isLoading,
    error,
    pendingControl,
    refresh,
    setValue,
    setValues
  };
}
