import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  ChevronsLeft,
  ChevronsRight,
  ChevronsUp,
  ChevronsDown,
  Crosshair,
  Home,
  Save,
  Trash2
} from "lucide-react";

import type { ControlGroup } from "../../domains/controls/grouping";
import { controlValueText } from "../../domains/controls/grouping";
import {
  formatDegrees,
  motorPositionFromQuery,
  motorSpeedFromQuery,
  presetStateFromQuery,
  PTZ_MOTOR_SPEED_DPS,
  PTZ_PAN_RANGE_DEGREES,
  PTZ_TILT_RANGE_DEGREES
} from "../../domains/ptz/hidTelemetry";
import { isCenteredVector, ptzVectorFromPadPoint, vectorPadPosition } from "../../domains/ptz/vectorPad";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import { usePtzVectorDrive } from "../../hooks/usePtzVectorDrive";
import { fetchPixyHidQuery } from "../../lib/apiClient";
import type {
  PixyHidQueryName,
  PixyHidRawQueryResult,
  PtzDirection,
  PtzPresetSlot,
  PtzVector,
  V4L2Control
} from "../../types/api";
import { ControlRenderer } from "./ControlRenderer";
import "./PtzControlPanel.css";

type HidQueryFn = (name: PixyHidQueryName) => Promise<PixyHidRawQueryResult>;

type Props = {
  group: ControlGroup;
  controls: UseControlsResult;
  pixyHid: UsePixyHidResult;
  /** Injectable for tests; defaults to the live pixy-hid query endpoint. */
  queryHid?: HidQueryFn;
};

const PTZ_CONTROL_NAMES = {
  pan: "pan_absolute",
  tilt: "tilt_absolute",
  zoom: "zoom_absolute"
} as const;

const PRESET_QUERY_NAMES: PixyHidQueryName[] = ["preset_1_state", "preset_2_state", "preset_3_state"];

type PtzPreset = {
  pan: number;
  tilt: number;
  zoom: number | null;
};

type MotorPosition = {
  pan: number;
  tilt: number;
};

const SPEEDS = [1, 2, 3, 4, 5];
const PTZ_VECTOR_SPEED_STEP = 2;
const PTZ_RELATIVE_DEGREES_BY_SPEED: Record<number, number> = {
  1: 1,
  2: 3,
  3: 5,
  4: 10,
  5: 15
};
const PTZ_JOG_INITIAL_REPEAT_MS = 260;
const PTZ_JOG_REPEAT_MS_BY_SPEED: Record<number, number> = {
  1: 360,
  2: 280,
  3: 220,
  4: 160,
  5: 110
};
const PTZ_TELEMETRY_INTERVAL_MS = 1500;
const PTZ_TELEMETRY_SETTLE_MS = 650;

function findControl(group: ControlGroup, name: string): V4L2Control | undefined {
  return group.controls.find((control) => control.name === name);
}

function clamp(value: number, control: V4L2Control): number {
  const min = control.min ?? value;
  const max = control.max ?? value;
  return Math.min(max, Math.max(min, value));
}

function clampDegrees(value: number, range: number): number {
  return Math.min(range, Math.max(-range, value));
}

function stepFor(control: V4L2Control | undefined): number {
  if (!control) {
    return 1;
  }
  return control.step && control.step > 0 ? control.step : 1;
}

function isBlocked(control: V4L2Control | undefined, pendingControl: string | null): boolean {
  return !control || control.flags.includes("inactive") || pendingControl !== null;
}

function isUsableAuxiliaryControl(control: V4L2Control): boolean {
  return control.min !== control.max;
}

function ptzVectorForDirection(direction: PtzDirection, speed: number): PtzVector {
  const magnitude = Math.min(30, Math.max(1, speed) * PTZ_VECTOR_SPEED_STEP);
  if (direction === "left") {
    return { x: -magnitude, y: 0 };
  }
  if (direction === "right") {
    return { x: magnitude, y: 0 };
  }
  if (direction === "up") {
    return { x: 0, y: magnitude };
  }
  return { x: 0, y: -magnitude };
}

const PAD_KEYBOARD_HINT = "Arrow keys nudge pan and tilt; Home recenters.";

const JOG_KEYS: Record<string, { direction: PtzDirection; axis: "pan" | "tilt"; sign: number }> = {
  ArrowLeft: { direction: "left", axis: "pan", sign: -1 },
  ArrowRight: { direction: "right", axis: "pan", sign: 1 },
  ArrowUp: { direction: "up", axis: "tilt", sign: 1 },
  ArrowDown: { direction: "down", axis: "tilt", sign: -1 }
};

type AxisControlProps = {
  label: string;
  control: V4L2Control | undefined;
  disabled: boolean;
  onSetValue: (value: number) => Promise<void>;
};

function AxisControl({ label, control, disabled, onSetValue }: AxisControlProps) {
  const [draftValue, setDraftValue] = useState(control?.value ?? 0);

  useEffect(() => {
    setDraftValue(control?.value ?? 0);
  }, [control?.value]);

  if (!control) {
    return (
      <div className="ptz-axis is-missing">
        <div className="ptz-axis-copy">
          <span>{label}</span>
          <small>Not exposed</small>
        </div>
        <strong>Missing</strong>
      </div>
    );
  }

  const min = control.min ?? 0;
  const max = control.max ?? 100;
  const step = stepFor(control);
  const inactive = control.flags.includes("inactive");

  const commit = () => {
    if (draftValue !== control.value) {
      void onSetValue(draftValue);
    }
  };

  return (
    <div className={`ptz-axis ${inactive ? "is-inactive" : ""}`}>
      <div className="ptz-axis-header">
        <div className="ptz-axis-copy">
          <span>{label}</span>
          <small>{control.name}</small>
        </div>
        <strong>{controlValueText(control)}</strong>
      </div>
      <input
        className="range-input ptz-axis-range"
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={draftValue}
        disabled={disabled || inactive}
        onChange={(event) => setDraftValue(Number(event.target.value))}
        onPointerUp={commit}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          }
        }}
      />
      <div className="ptz-axis-scale">
        <span>{min}</span>
        <span>{label === "Zoom" ? "" : 0}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

type HidAxisSliderProps = {
  label: string;
  axis: "pan" | "tilt";
  range: number;
  /** Current draft or measured degrees; null while the gimbal position is unknown. */
  value: number | null;
  disabled: boolean;
  onDraft: (axis: "pan" | "tilt", degrees: number) => void;
  onCommit: (axis: "pan" | "tilt") => void;
};

function HidAxisSlider({ label, axis, range, value, disabled, onDraft, onCommit }: HidAxisSliderProps) {
  return (
    <div className={`ptz-axis ${value === null ? "is-missing" : ""}`}>
      <div className="ptz-axis-header">
        <div className="ptz-axis-copy">
          <span>{label}</span>
          <small>{axis} · gimbal</small>
        </div>
        <strong>{formatDegrees(value)}</strong>
      </div>
      <input
        className="range-input ptz-axis-range"
        type="range"
        min={-range}
        max={range}
        step={1}
        value={value ?? 0}
        disabled={disabled || value === null}
        aria-label={`${label} position`}
        onChange={(event) => onDraft(axis, Number(event.target.value))}
        onPointerUp={() => onCommit(axis)}
        onBlur={() => onCommit(axis)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onCommit(axis);
          }
        }}
      />
      <div className="ptz-axis-scale">
        <span>{-range}°</span>
        <span>0°</span>
        <span>{range}°</span>
      </div>
    </div>
  );
}

export function PtzControlPanel({ group, controls, pixyHid, queryHid }: Props) {
  const Icon = group.icon;
  const runHidQuery = queryHid ?? fetchPixyHidQuery;
  const trackingLocksPtz = pixyHid.trackingMode === "tracking";
  const pan = findControl(group, PTZ_CONTROL_NAMES.pan);
  const tilt = findControl(group, PTZ_CONTROL_NAMES.tilt);
  const zoom = findControl(group, PTZ_CONTROL_NAMES.zoom);
  const primaryControlNames = new Set<string>(Object.values(PTZ_CONTROL_NAMES));
  const auxiliaryControls = group.controls.filter(
    (control) => !primaryControlNames.has(control.name) && isUsableAuxiliaryControl(control)
  );
  const [speed, setSpeed] = useState(3);
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [presets, setPresets] = useState<(PtzPreset | null)[]>([null, null, null]);
  const [presetTruthLoaded, setPresetTruthLoaded] = useState(false);
  const [motorPosition, setMotorPosition] = useState<MotorPosition | null>(null);
  const [axisDrafts, setAxisDrafts] = useState<{ pan: number | null; tilt: number | null }>({
    pan: null,
    tilt: null
  });
  const [activeVector, setActiveVector] = useState<PtzVector | null>(null);
  const jogActiveRef = useRef(false);
  const jogTimerRef = useRef<number | null>(null);
  const telemetryTimerRef = useRef<number | null>(null);
  const hidWritable = pixyHid.status?.writable === true;
  const knownControls = pixyHid.status?.known_controls ?? [];
  const hidPtzReady = hidWritable && knownControls.includes("ptz_direction");
  const hidPtzRelativeReady = hidWritable && knownControls.includes("ptz_relative");
  const hidPtzAbsoluteReady = hidWritable && knownControls.includes("ptz_absolute");
  const hidPtzRecenterReady = hidWritable && knownControls.includes("ptz_recenter");
  const hidPtzVectorReady = hidWritable && knownControls.includes("ptz_vector");
  const hidPresetSaveReady = hidWritable && knownControls.includes("ptz_preset_save");
  const hidPresetLoadReady = hidWritable && knownControls.includes("ptz_preset_load");
  const hidPresetClearReady = hidWritable && knownControls.includes("ptz_preset_clear");
  const hidMotorSpeedReady = hidWritable && knownControls.includes("motor_speed");
  const hidPresetPending = pixyHid.pendingCommand?.startsWith("ptz-preset-") ?? false;

  const pollTelemetry = useCallback(async () => {
    const [panResult, tiltResult] = await Promise.all([
      runHidQuery("motor_pos_pan"),
      runHidQuery("motor_pos_tilt")
    ]);
    const panPosition = motorPositionFromQuery(panResult);
    const tiltPosition = motorPositionFromQuery(tiltResult);
    if (panPosition && tiltPosition) {
      setMotorPosition({ pan: panPosition.current, tilt: tiltPosition.current });
    }
  }, [runHidQuery]);

  const scheduleTelemetryPoll = useCallback(() => {
    if (telemetryTimerRef.current !== null) {
      window.clearTimeout(telemetryTimerRef.current);
    }
    telemetryTimerRef.current = window.setTimeout(() => {
      telemetryTimerRef.current = null;
      void pollTelemetry().catch(() => undefined);
    }, PTZ_TELEMETRY_SETTLE_MS);
  }, [pollTelemetry]);

  // Continuous vector motion: serialized sends, a heartbeat for the backend
  // dead-man while held, ordered + retried stops, keepalive stop on page exit.
  const vectorDrive = usePtzVectorDrive(pixyHid.sendPtzVector, {
    onStopped: scheduleTelemetryPoll,
    onHalt: () => {
      cancelJogTimers();
      setActiveVector(null);
    }
  });

  // Live gimbal position: polled while the HID channel is writable.
  useEffect(() => {
    if (!hidWritable) {
      setMotorPosition(null);
      return;
    }
    const tick = async () => {
      try {
        await pollTelemetry();
      } catch {
        // Telemetry is best-effort; keep the last good reading.
      }
    };
    void tick();
    const intervalId = window.setInterval(() => void tick(), PTZ_TELEMETRY_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [hidWritable, pollTelemetry]);

  // Hydrate preset slots from the device so filled/empty state is real.
  useEffect(() => {
    if (!hidWritable) {
      setPresetTruthLoaded(false);
      return;
    }
    let cancelled = false;
    const hydrate = async () => {
      const results = await Promise.all(
        PRESET_QUERY_NAMES.map((name) => runHidQuery(name).catch(() => null))
      );
      if (cancelled) {
        return;
      }
      const states = results.map((result) => (result ? presetStateFromQuery(result) : null));
      if (states.every((state) => state === null)) {
        return;
      }
      setPresetTruthLoaded(true);
      setPresets((current) =>
        current.map((preset, index) => {
          const state = states[index];
          if (state?.saved) {
            return { pan: state.pan, tilt: state.tilt, zoom: preset?.zoom ?? null };
          }
          return null;
        })
      );
    };
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [hidWritable, runHidQuery]);

  // Preselect the speed button closest to the device's configured motor speed.
  useEffect(() => {
    if (!hidWritable || !hidMotorSpeedReady) {
      return;
    }
    let cancelled = false;
    void runHidQuery("motor_speed_pan")
      .then((result) => {
        if (cancelled) {
          return;
        }
        const dps = motorSpeedFromQuery(result);
        if (dps === null || dps <= 0) {
          return;
        }
        setSpeed(
          SPEEDS.reduce((best, candidate) =>
            Math.abs(PTZ_MOTOR_SPEED_DPS[candidate] - dps) < Math.abs(PTZ_MOTOR_SPEED_DPS[best] - dps)
              ? candidate
              : best
          )
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hidWritable, hidMotorSpeedReady, runHidQuery]);

  const refreshPresetSlot = useCallback(
    async (index: number) => {
      const result = await runHidQuery(PRESET_QUERY_NAMES[index]).catch(() => null);
      const state = result ? presetStateFromQuery(result) : null;
      if (!state) {
        return;
      }
      setPresetTruthLoaded(true);
      setPresets((current) =>
        current.map((preset, presetIndex) =>
          presetIndex === index
            ? state.saved
              ? { pan: state.pan, tilt: state.tilt, zoom: preset?.zoom ?? null }
              : null
            : preset
        )
      );
    },
    [runHidQuery]
  );

  const moveAxis = async (control: V4L2Control | undefined, direction: number, hidDirection: PtzDirection) => {
    if (trackingLocksPtz) {
      return;
    }
    if (hidPtzRelativeReady) {
      await pixyHid.sendPtzRelative(hidDirection, PTZ_RELATIVE_DEGREES_BY_SPEED[speed] ?? 3);
      scheduleTelemetryPoll();
      return;
    }
    if (hidPtzReady) {
      await pixyHid.sendPtzDirection(hidDirection);
      scheduleTelemetryPoll();
      return;
    }
    if (hidPtzVectorReady) {
      const vector = ptzVectorForDirection(hidDirection, speed);
      setActiveVector(vector);
      await vectorDrive.move(vector);
      return;
    }
    if (!control || control.flags.includes("inactive")) {
      return;
    }
    await controls.setValue(control.name, clamp(control.value + stepFor(control) * direction, control));
  };

  const stopPtzVector = async () => {
    setActiveVector(null);
    await vectorDrive.stop();
  };

  function cancelJogTimers() {
    jogActiveRef.current = false;
    if (jogTimerRef.current !== null) {
      window.clearTimeout(jogTimerRef.current);
      jogTimerRef.current = null;
    }
  }

  const stopJog = () => {
    cancelJogTimers();
    void stopPtzVector();
  };

  // Unmount: the vector drive stops any motion itself; clear local timers.
  useEffect(
    () => () => {
      cancelJogTimers();
      if (telemetryTimerRef.current !== null) {
        window.clearTimeout(telemetryTimerRef.current);
        telemetryTimerRef.current = null;
      }
    },
    []
  );

  const startJog = (control: V4L2Control | undefined, direction: number, hidDirection: PtzDirection) => {
    if (trackingLocksPtz) {
      return;
    }
    if (directionBlocked(control)) {
      return;
    }
    stopJog();
    jogActiveRef.current = true;

    const repeat = async () => {
      await moveAxis(control, direction, hidDirection);
      if (jogActiveRef.current) {
        jogTimerRef.current = window.setTimeout(() => void repeat(), PTZ_JOG_REPEAT_MS_BY_SPEED[speed] ?? 220);
      }
    };

    void moveAxis(control, direction, hidDirection).then(() => {
      if (jogActiveRef.current) {
        jogTimerRef.current = window.setTimeout(() => void repeat(), PTZ_JOG_INITIAL_REPEAT_MS);
      }
    });
  };

  const keyJog = async (
    event: KeyboardEvent<HTMLButtonElement>,
    control: V4L2Control | undefined,
    direction: number,
    hidDirection: PtzDirection
  ) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    await moveAxis(control, direction, hidDirection);
  };

  const padKeyJog = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      void centerPtz();
      return;
    }
    const jog = JOG_KEYS[event.key];
    if (!jog) {
      return;
    }
    event.preventDefault();
    const control = jog.axis === "pan" ? pan : tilt;
    void moveAxis(control, jog.sign, jog.direction);
  };

  // Keyboard nudges on the vector-only path start continuous motion (key
  // repeat acts as the heartbeat); releasing the key stops it.
  const padKeyRelease = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!JOG_KEYS[event.key] && event.key !== "Enter" && event.key !== " ") {
      return;
    }
    if (vectorDrive.isMoving() && !jogActiveRef.current) {
      void stopPtzVector();
    }
  };

  const centerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      void centerPtz();
    }
  };

  const centerPtz = async () => {
    if (trackingLocksPtz) {
      return;
    }
    cancelJogTimers();
    await stopPtzVector();
    if (hidPtzRecenterReady) {
      await pixyHid.recenterPtz();
      scheduleTelemetryPoll();
      if (zoom && !zoom.flags.includes("inactive")) {
        await controls.setValue(zoom.name, clamp(zoom.default ?? zoom.min ?? 0, zoom));
      }
      return;
    }
    const centerable = [pan, tilt].filter((control): control is V4L2Control => Boolean(control));
    for (const control of centerable) {
      if (!control.flags.includes("inactive")) {
        await controls.setValue(control.name, clamp(0, control));
      }
    }
    if (zoom && !zoom.flags.includes("inactive")) {
      await controls.setValue(zoom.name, clamp(zoom.default ?? zoom.min ?? 0, zoom));
    }
  };

  const vectorFromPointer = (event: PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return ptzVectorFromPadPoint(
      { width: rect.width, height: rect.height },
      { x: event.clientX - rect.left, y: event.clientY - rect.top }
    );
  };

  const updateVectorPreview = (event: PointerEvent<HTMLButtonElement>) => {
    if (trackingLocksPtz) {
      return null;
    }
    if (!hidPtzVectorReady) {
      return null;
    }
    const vector = vectorFromPointer(event);
    setActiveVector(vector);
    return vector;
  };

  const sendDragVector = async (vector: PtzVector) => {
    if (trackingLocksPtz) {
      return;
    }
    if (isCenteredVector(vector)) {
      // Dragged back to the middle while held: halt instead of re-sending
      // the last off-center vector on every heartbeat.
      await vectorDrive.stop();
      return;
    }
    await vectorDrive.move(vector);
  };

  const commitVectorPad = async (event: PointerEvent<HTMLButtonElement>) => {
    if (trackingLocksPtz) {
      return;
    }
    if (!hidPtzVectorReady) {
      await centerPtz();
      return;
    }
    const vector = vectorFromPointer(event);
    setActiveVector(vector);
    if (isCenteredVector(vector)) {
      await centerPtz();
      return;
    }
    await stopPtzVector();
  };

  const axisValue = (axis: "pan" | "tilt"): number | null =>
    axisDrafts[axis] ?? motorPosition?.[axis] ?? null;

  const draftAxis = (axis: "pan" | "tilt", degrees: number) => {
    setAxisDrafts((current) => ({ ...current, [axis]: degrees }));
  };

  const commitAxis = async (axis: "pan" | "tilt") => {
    if (!hidPtzAbsoluteReady || trackingLocksPtz) {
      setAxisDrafts((current) => ({ ...current, [axis]: null }));
      return;
    }
    if (axisDrafts[axis] === null) {
      return;
    }
    const nextPan = axis === "pan" ? axisDrafts[axis] : axisValue("pan");
    const nextTilt = axis === "tilt" ? axisDrafts[axis] : axisValue("tilt");
    setAxisDrafts({ pan: null, tilt: null });
    if (nextPan === null || nextTilt === null) {
      return;
    }
    const targetPan = clampDegrees(nextPan, PTZ_PAN_RANGE_DEGREES);
    const targetTilt = clampDegrees(nextTilt, PTZ_TILT_RANGE_DEGREES);
    setMotorPosition({ pan: targetPan, tilt: targetTilt });
    await pixyHid.sendPtzAbsolute(targetPan, targetTilt);
    scheduleTelemetryPoll();
  };

  const applySpeed = (value: number) => {
    setSpeed(value);
    if (!hidMotorSpeedReady) {
      return;
    }
    const degreesPerSecond = PTZ_MOTOR_SPEED_DPS[value] ?? 60;
    void pixyHid
      .setMotorSpeed(1, degreesPerSecond)
      .then(() => pixyHid.setMotorSpeed(2, degreesPerSecond))
      .catch(() => undefined);
  };

  const savePreset = async () => {
    if (trackingLocksPtz) {
      return;
    }
    if (hidPresetSaveReady) {
      if ((await pixyHid.savePtzPreset((selectedPreset + 1) as PtzPresetSlot)) === false) {
        // The panel's error strip shows why; do not mark the slot as saved.
        return;
      }
      // Optimistic fill from the measured position; refreshPresetSlot replaces it
      // with the device's stored coordinates when the query succeeds.
      setPresets((current) =>
        current.map((preset, index) =>
          index === selectedPreset
            ? {
                pan: preset?.pan ?? motorPosition?.pan ?? 0,
                tilt: preset?.tilt ?? motorPosition?.tilt ?? 0,
                zoom: zoom?.value ?? null
              }
            : preset
        )
      );
      await refreshPresetSlot(selectedPreset);
      return;
    }
    if (!pan || !tilt || !zoom) {
      return;
    }
    setPresets((current) =>
      current.map((preset, index) =>
        index === selectedPreset ? { pan: pan.value, tilt: tilt.value, zoom: zoom.value } : preset
      )
    );
  };

  const gotoPreset = async () => {
    if (trackingLocksPtz) {
      return;
    }
    const preset = presets[selectedPreset];
    if (controls.pendingControl !== null) {
      return;
    }
    if (hidPresetLoadReady) {
      if (presetTruthLoaded && !preset) {
        return;
      }
      if ((await pixyHid.loadPtzPreset((selectedPreset + 1) as PtzPresetSlot)) === false) {
        return;
      }
      scheduleTelemetryPoll();
      if (preset?.zoom !== null && preset?.zoom !== undefined && zoom && !zoom.flags.includes("inactive")) {
        await controls.setValue(zoom.name, clamp(preset.zoom, zoom));
      }
      return;
    }
    if (!preset) {
      return;
    }
    if (pan && !pan.flags.includes("inactive")) {
      await controls.setValue(pan.name, clamp(preset.pan, pan));
    }
    if (tilt && !tilt.flags.includes("inactive")) {
      await controls.setValue(tilt.name, clamp(preset.tilt, tilt));
    }
    if (preset.zoom !== null && zoom && !zoom.flags.includes("inactive")) {
      await controls.setValue(zoom.name, clamp(preset.zoom, zoom));
    }
  };

  const clearPreset = async () => {
    if (trackingLocksPtz || !hidPresetClearReady) {
      return;
    }
    if ((await pixyHid.clearPtzPreset((selectedPreset + 1) as PtzPresetSlot)) === false) {
      return;
    }
    setPresets((current) => current.map((preset, index) => (index === selectedPreset ? null : preset)));
    await refreshPresetSlot(selectedPreset);
  };

  const presetTitle = (preset: PtzPreset | null, index: number): string => {
    if (preset) {
      // Device presets are stored in degrees; V4L2 fallback presets keep raw
      // control units, so only the HID path gets a coordinate readout.
      return hidPresetSaveReady || hidPresetLoadReady
        ? `Preset ${index + 1} · pan ${formatDegrees(preset.pan)} tilt ${formatDegrees(preset.tilt)}`
        : `Preset ${index + 1} saved`;
    }
    return presetTruthLoaded ? `Preset ${index + 1} · empty` : `Preset ${index + 1}`;
  };

  const disabled = controls.pendingControl !== null;
  const directionBlocked = (control: V4L2Control | undefined) =>
    trackingLocksPtz ||
    (hidPtzRelativeReady || hidPtzVectorReady || hidPtzReady
      ? disabled && !jogActiveRef.current
      : isBlocked(control, controls.pendingControl));
  const vectorPadDisabled =
    trackingLocksPtz || disabled || (!hidPtzRecenterReady && !hidPtzVectorReady && !pan && !tilt);
  const activeVectorPosition = activeVector ? vectorPadPosition(activeVector) : null;
  const touchNone = { touchAction: "none" } as const;

  return (
    <section className={`control-panel ptz-panel accent-${group.accent}`}>
      <div className="panel-title-row">
        <Icon size={18} />
        <h2>{group.title}</h2>
      </div>
      {trackingLocksPtz && (
        <div className="ptz-mode-lock">
          Tracking Mode owns PTZ. Switch Control Mode to Standard before moving, zooming, homing, or using presets.
        </div>
      )}
      {pixyHid.error && (
        <div className="mini-error" role="alert">
          {pixyHid.error}
        </div>
      )}
      {!hidWritable && pixyHid.status?.reason && <div className="mini-warning">{pixyHid.status.reason}</div>}

      <div className="ptz-deck">
        <div
          className="ptz-pad"
          role="group"
          aria-label="Pan and tilt controls"
          aria-describedby="ptz-pad-keyboard-hint"
          title={PAD_KEYBOARD_HINT}
          onKeyDown={padKeyJog}
          onKeyUp={padKeyRelease}
        >
          <span id="ptz-pad-keyboard-hint" hidden>
            {PAD_KEYBOARD_HINT} Enter or Space on the center button recenters.
          </span>
          <button
            className="ptz-direction ptz-up"
            style={touchNone}
            disabled={directionBlocked(tilt)}
            onPointerDown={() => startJog(tilt, 1, "up")}
            onPointerUp={stopJog}
            onPointerCancel={stopJog}
            onPointerLeave={stopJog}
            onKeyDown={(event) => void keyJog(event, tilt, 1, "up")}
            title="Tilt up"
            aria-label="Tilt up"
          >
            <ChevronsUp size={22} />
          </button>
          <button
            className="ptz-direction ptz-right"
            style={touchNone}
            disabled={directionBlocked(pan)}
            onPointerDown={() => startJog(pan, 1, "right")}
            onPointerUp={stopJog}
            onPointerCancel={stopJog}
            onPointerLeave={stopJog}
            onKeyDown={(event) => void keyJog(event, pan, 1, "right")}
            title="Pan right"
            aria-label="Pan right"
          >
            <ChevronsRight size={22} />
          </button>
          <button
            className="ptz-direction ptz-down"
            style={touchNone}
            disabled={directionBlocked(tilt)}
            onPointerDown={() => startJog(tilt, -1, "down")}
            onPointerUp={stopJog}
            onPointerCancel={stopJog}
            onPointerLeave={stopJog}
            onKeyDown={(event) => void keyJog(event, tilt, -1, "down")}
            title="Tilt down"
            aria-label="Tilt down"
          >
            <ChevronsDown size={22} />
          </button>
          <button
            className="ptz-direction ptz-left"
            style={touchNone}
            disabled={directionBlocked(pan)}
            onPointerDown={() => startJog(pan, -1, "left")}
            onPointerUp={stopJog}
            onPointerCancel={stopJog}
            onPointerLeave={stopJog}
            onKeyDown={(event) => void keyJog(event, pan, -1, "left")}
            title="Pan left"
            aria-label="Pan left"
          >
            <ChevronsLeft size={22} />
          </button>
          <button
            className="ptz-center"
            style={touchNone}
            disabled={vectorPadDisabled}
            onPointerDown={(event) => {
              const vector = updateVectorPreview(event);
              if (vector) {
                void sendDragVector(vector);
              }
            }}
            onPointerMove={(event) => {
              if (event.buttons === 1) {
                const vector = updateVectorPreview(event);
                if (vector) {
                  void sendDragVector(vector);
                }
              }
            }}
            onPointerCancel={() => void stopPtzVector()}
            onPointerLeave={() => void stopPtzVector()}
            onPointerUp={(event) => void commitVectorPad(event)}
            onKeyDown={centerKey}
            title={hidPtzVectorReady ? "Point PTZ (drag to steer; Enter or Space recenters)" : "Center PTZ"}
            aria-label="Center PTZ"
          >
            <Crosshair size={24} />
            {activeVectorPosition && (
              <span
                className="ptz-vector-puck"
                style={{ left: `${activeVectorPosition.x}%`, top: `${activeVectorPosition.y}%` }}
                aria-hidden="true"
              />
            )}
          </button>
        </div>

        <div className="ptz-axis-bank">
          <div className="ptz-position" title="Live gimbal position">
            <span className="ptz-position-label">Gimbal</span>
            {hidWritable ? (
              motorPosition ? (
                <strong>
                  pan {formatDegrees(motorPosition.pan)} · tilt {formatDegrees(motorPosition.tilt)}
                </strong>
              ) : (
                <span className="ptz-position-reading">reading…</span>
              )
            ) : (
              <span className="ptz-position-reading">HID read-only</span>
            )}
          </div>
          <div className="ptz-readouts">
            {hidPtzAbsoluteReady ? (
              <>
                <HidAxisSlider
                  label="Pan"
                  axis="pan"
                  range={PTZ_PAN_RANGE_DEGREES}
                  value={axisValue("pan")}
                  disabled={trackingLocksPtz}
                  onDraft={draftAxis}
                  onCommit={(axis) => void commitAxis(axis)}
                />
                <HidAxisSlider
                  label="Tilt"
                  axis="tilt"
                  range={PTZ_TILT_RANGE_DEGREES}
                  value={axisValue("tilt")}
                  disabled={trackingLocksPtz}
                  onDraft={draftAxis}
                  onCommit={(axis) => void commitAxis(axis)}
                />
              </>
            ) : (
              <>
                <AxisControl
                  label="Pan"
                  control={pan}
                  disabled={trackingLocksPtz || controls.pendingControl === pan?.name}
                  onSetValue={(value) => controls.setValue(PTZ_CONTROL_NAMES.pan, value)}
                />
                <AxisControl
                  label="Tilt"
                  control={tilt}
                  disabled={trackingLocksPtz || controls.pendingControl === tilt?.name}
                  onSetValue={(value) => controls.setValue(PTZ_CONTROL_NAMES.tilt, value)}
                />
              </>
            )}
            <AxisControl
              label="Zoom"
              control={zoom}
              disabled={trackingLocksPtz || controls.pendingControl === zoom?.name}
              onSetValue={(value) => controls.setValue(PTZ_CONTROL_NAMES.zoom, value)}
            />
          </div>
        </div>

        <div className="ptz-presets">
          <div className="ptz-presets-label">Presets</div>
          <div className="ptz-preset-slots">
            {presets.map((preset, index) => (
              <button
                key={index}
                className={`${selectedPreset === index ? "is-selected" : ""} ${preset ? "is-filled" : ""}`}
                onClick={() => setSelectedPreset(index)}
                aria-pressed={selectedPreset === index}
                aria-label={`Preset ${index + 1}`}
                title={presetTitle(preset, index)}
              >
                {index + 1}
              </button>
            ))}
          </div>
          <div className="ptz-preset-actions">
            <button
              className="secondary-button"
              disabled={
                trackingLocksPtz ||
                disabled ||
                hidPresetPending ||
                (!hidPresetSaveReady && (!pan || !tilt || !zoom))
              }
              onClick={() => void savePreset()}
              aria-label="Save PTZ preset"
              title="Save PTZ preset"
            >
              <Save size={16} />
              Save
            </button>
            <button
              className="secondary-button"
              disabled={
                trackingLocksPtz ||
                disabled ||
                hidPresetPending ||
                (!hidPresetLoadReady && !presets[selectedPreset]) ||
                (hidPresetLoadReady && presetTruthLoaded && !presets[selectedPreset])
              }
              onClick={() => void gotoPreset()}
              aria-label="Goto PTZ preset"
              title="Goto PTZ preset"
            >
              <Home size={16} />
              Goto
            </button>
            {hidPresetClearReady && (
              <button
                className="secondary-button"
                disabled={trackingLocksPtz || disabled || hidPresetPending}
                onClick={() => void clearPreset()}
                aria-label="Clear PTZ preset"
                title="Clear PTZ preset"
              >
                <Trash2 size={16} />
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="ptz-footer">
        <div className="ptz-speed">
          <span>Speed</span>
          <div className="ptz-speed-buttons">
            {SPEEDS.map((value) => (
              <button
                key={value}
                className={speed === value ? "is-selected" : ""}
                onClick={() => applySpeed(value)}
                aria-pressed={speed === value}
                aria-label={`Speed ${value}`}
                title={hidMotorSpeedReady ? `Motor speed ${PTZ_MOTOR_SPEED_DPS[value]}°/s` : `Speed ${value}`}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
        <button
          className="secondary-button ptz-home-button"
          disabled={trackingLocksPtz || disabled || (!hidPtzRecenterReady && !pan && !tilt)}
          onClick={() => void centerPtz()}
          aria-label="Home PTZ"
          title="Home PTZ"
        >
          <Home size={16} />
          Home
        </button>
      </div>

      {auxiliaryControls.length > 0 && (
        <div className="control-stack ptz-raw-controls">
          {auxiliaryControls.map((control) => (
            <ControlRenderer
              key={control.name}
              control={control}
              disabled={trackingLocksPtz || controls.pendingControl === control.name}
              onSetValue={(value) => controls.setValue(control.name, value)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
