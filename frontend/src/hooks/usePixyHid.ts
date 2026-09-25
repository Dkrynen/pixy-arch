import { useCallback, useEffect, useRef, useState } from "react";

import {
  capturePixyPowerOnDefault,
  clearPixyPtzPreset,
  disablePixyPowerOnDefault,
  fetchPixyHidQuery,
  fetchPixyHidState,
  fetchPixyHidStatus,
  pixyGoToDefault,
  setPixyAudio,
  setPixyAutoPrivacy,
  setPixyAutoRotate,
  setPixyDenoise,
  setPixyEvLock,
  setPixyFocusLock,
  setPixyGesture,
  setPixyFocusMetering,
  setPixyMirror,
  setPixyMotorSpeed,
  setPixyRemotePairing,
  setPixyWbLock,
  loadPixyPtzPreset,
  recenterPixyPtz,
  sendPixyPtzDirection,
  sendPixyPtzAbsolute,
  sendPixyPtzRelative,
  sendPixyPtzVector,
  savePixyPtzPreset,
  setPixyTargetTracking,
  setPixyTracking
} from "../lib/apiClient";
import type {
  AudioMode,
  FocusMeteringPoint,
  FocusMeteringMode,
  MirrorMode,
  PixyHidQueryName,
  PixyHidRawQueryResult,
  PixyHidStatus,
  PtzDirection,
  PtzPresetSlot,
  PtzVector,
  TargetTrackingMode,
  TrackingMode
} from "../types/api";

export type DeviceTrackingState = "standard" | "tracking" | "privacy" | "non_privacy" | "unknown";

const NON_PRIVACY_READBACK_RETRIES = 4;
const NON_PRIVACY_READBACK_RETRY_MS = 250;

// Queries the panel can surface as device-reported state. `audio_state` and
// `gesture_state` already arrive through /state; the sweep covers the rest.
const EXTENDED_READBACK_QUERIES: PixyHidQueryName[] = [
  "mirror_horizontal_state",
  "mirror_vertical_state",
  "auto_rotate_state",
  "focus_metering_state",
  "auto_privacy_state",
  "denoise_state",
  "wb_lock_state",
  "ev_lock_state",
  "focus_lock_state",
  "remote_pairing_state",
  "power_on_default_state",
  "motor_pos_pan",
  "motor_pos_tilt",
  "motor_speed_pan",
  "motor_speed_tilt"
];

const AUDIO_MODE_BY_RAW: Record<number, AudioMode> = {
  1: "noise_cancel",
  2: "live",
  3: "original"
};

const FOCUS_METERING_BY_RAW: Record<number, FocusMeteringMode> = {
  0: "center",
  1: "human_face",
  2: "selected_area"
};

export type UsePixyHidResult = {
  status: PixyHidStatus | null;
  isLoading: boolean;
  pendingCommand: string | null;
  error: string | null;
  lastCommand: string | null;
  trackingMode: TrackingMode | null;
  deviceTrackingState: DeviceTrackingState;
  deviceTrackingRawValue: number | null;
  deviceTrackingRawBits: number[];
  targetTrackingMode: TargetTrackingMode | null;
  targetTrackingRawValue: number | null;
  gestureEnabled: boolean | null;
  autoRotateEnabled: boolean | null;
  mirrorMode: MirrorMode | null;
  focusMeteringMode: FocusMeteringMode | null;
  focusMeteringPoint: FocusMeteringPoint | null;
  audioMode: AudioMode | null;
  autoPrivacySeconds: number | null;
  // Optional device-reported readbacks populated by the extended query sweep.
  // Optional so other panels' UsePixyHidResult mocks keep compiling.
  denoiseEnabled?: boolean | null;
  wbLockEnabled?: boolean | null;
  evLockEnabled?: boolean | null;
  focusLockEnabled?: boolean | null;
  remotePairingEnabled?: boolean | null;
  powerOnDefaultEnabled?: boolean | null;
  powerOnDefaultPosition?: { pan: number; tilt: number } | null;
  motorPosPanDeg?: number | null;
  motorPosTiltDeg?: number | null;
  motorSpeedPanDeg?: number | null;
  motorSpeedTiltDeg?: number | null;
  /** State queries the device does not answer on this firmware (denoise, remote pairing). */
  unsupportedReadbacks?: PixyHidQueryName[];
  /** True once the extended query sweep has completed at least once. */
  extendedReadbackReady?: boolean;
  refresh: () => Promise<void>;
  refreshStatus: (options?: { showLoading?: boolean }) => Promise<void>;
  // Commands resolve true when the device accepted them and false when they
  // failed (the reason lands in `error`), so callers never report a failed
  // command as success.
  setTrackingMode: (mode: TrackingMode) => Promise<boolean>;
  setTargetTrackingMode: (mode: TargetTrackingMode) => Promise<boolean>;
  setGestureEnabled: (enabled: boolean) => Promise<boolean>;
  setAutoRotateEnabled: (enabled: boolean) => Promise<boolean>;
  setMirrorMode: (mode: MirrorMode) => Promise<boolean>;
  setFocusMeteringMode: (mode: FocusMeteringMode, point?: FocusMeteringPoint) => Promise<boolean>;
  setAudioMode: (mode: AudioMode) => Promise<boolean>;
  setAutoPrivacySeconds: (seconds: number) => Promise<boolean>;
  sendPtzDirection: (direction: PtzDirection) => Promise<boolean>;
  sendPtzRelative: (direction: PtzDirection, degrees: number) => Promise<boolean>;
  sendPtzAbsolute: (pan: number, tilt: number) => Promise<boolean>;
  sendPtzVector: (vector: PtzVector) => Promise<boolean>;
  recenterPtz: () => Promise<boolean>;
  savePtzPreset: (slot: PtzPresetSlot) => Promise<boolean>;
  loadPtzPreset: (slot: PtzPresetSlot) => Promise<boolean>;
  clearPtzPreset: (slot: PtzPresetSlot) => Promise<boolean>;
  capturePowerOnDefault: () => Promise<boolean>;
  disablePowerOnDefault: () => Promise<boolean>;
  goToDefault: () => Promise<boolean>;
  setDenoise: (enabled: boolean) => Promise<boolean>;
  setWbLock: (enabled: boolean) => Promise<boolean>;
  setEvLock: (enabled: boolean, exposure?: number) => Promise<boolean>;
  setFocusLock: (enabled: boolean) => Promise<boolean>;
  setRemotePairing: (enabled: boolean) => Promise<boolean>;
  setMotorSpeed: (axis: number, degreesPerSecond: number) => Promise<boolean>;
};

export function usePixyHid(): UsePixyHidResult {
  const [status, setStatus] = useState<PixyHidStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCommand, setPendingCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [trackingMode, setTrackingModeState] = useState<TrackingMode | null>(null);
  const [deviceTrackingState, setDeviceTrackingState] = useState<DeviceTrackingState>("unknown");
  const [deviceTrackingRawValue, setDeviceTrackingRawValue] = useState<number | null>(null);
  const [deviceTrackingRawBits, setDeviceTrackingRawBits] = useState<number[]>([]);
  const [targetTrackingMode, setTargetTrackingModeState] = useState<TargetTrackingMode | null>(null);
  const [targetTrackingRawValue, setTargetTrackingRawValue] = useState<number | null>(null);
  const [gestureEnabled, setGestureEnabledState] = useState<boolean | null>(null);
  const [autoRotateEnabled, setAutoRotateEnabledState] = useState<boolean | null>(null);
  const [mirrorMode, setMirrorModeState] = useState<MirrorMode | null>(null);
  const [focusMeteringMode, setFocusMeteringModeState] = useState<FocusMeteringMode | null>(null);
  const [focusMeteringPoint, setFocusMeteringPointState] = useState<FocusMeteringPoint | null>(null);
  const [audioMode, setAudioModeState] = useState<AudioMode | null>(null);
  const [autoPrivacySeconds, setAutoPrivacySecondsState] = useState<number | null>(null);
  const [denoiseEnabled, setDenoiseEnabledState] = useState<boolean | null>(null);
  const [wbLockEnabled, setWbLockEnabledState] = useState<boolean | null>(null);
  const [evLockEnabled, setEvLockEnabledState] = useState<boolean | null>(null);
  const [focusLockEnabled, setFocusLockEnabledState] = useState<boolean | null>(null);
  const [remotePairingEnabled, setRemotePairingEnabledState] = useState<boolean | null>(null);
  const [powerOnDefaultEnabled, setPowerOnDefaultEnabledState] = useState<boolean | null>(null);
  const [powerOnDefaultPosition, setPowerOnDefaultPositionState] = useState<{ pan: number; tilt: number } | null>(null);
  const [motorPosPanDeg, setMotorPosPanDegState] = useState<number | null>(null);
  const [motorPosTiltDeg, setMotorPosTiltDegState] = useState<number | null>(null);
  const [motorSpeedPanDeg, setMotorSpeedPanDegState] = useState<number | null>(null);
  const [motorSpeedTiltDeg, setMotorSpeedTiltDegState] = useState<number | null>(null);
  const [unsupportedReadbacks, setUnsupportedReadbacks] = useState<PixyHidQueryName[]>([]);
  const [extendedReadbackReady, setExtendedReadbackReady] = useState(false);
  const mirrorBitsRef = useRef<{ h: boolean | null; v: boolean | null }>({ h: null, v: null });

  const clearAssertedState = useCallback(() => {
    setTrackingModeState(null);
    setDeviceTrackingState("unknown");
    setDeviceTrackingRawValue(null);
    setDeviceTrackingRawBits([]);
    setTargetTrackingModeState(null);
    setTargetTrackingRawValue(null);
    setGestureEnabledState(null);
    setAutoRotateEnabledState(null);
    setMirrorModeState(null);
    setFocusMeteringModeState(null);
    setFocusMeteringPointState(null);
    setAudioModeState(null);
    setAutoPrivacySecondsState(null);
    setDenoiseEnabledState(null);
    setWbLockEnabledState(null);
    setEvLockEnabledState(null);
    setFocusLockEnabledState(null);
    setRemotePairingEnabledState(null);
    setPowerOnDefaultEnabledState(null);
    setPowerOnDefaultPositionState(null);
    setMotorPosPanDegState(null);
    setMotorPosTiltDegState(null);
    setMotorSpeedPanDegState(null);
    setMotorSpeedTiltDegState(null);
    setUnsupportedReadbacks([]);
    setExtendedReadbackReady(false);
    mirrorBitsRef.current = { h: null, v: null };
  }, []);

  const markReadbackSupport = useCallback((name: PixyHidQueryName, supported: boolean) => {
    setUnsupportedReadbacks((current) => {
      if (supported) {
        return current.includes(name) ? current.filter((entry) => entry !== name) : current;
      }
      return current.includes(name) ? current : [...current, name];
    });
  }, []);

  const applyQueryResult = useCallback(
    (result: PixyHidRawQueryResult) => {
      const answered = result.response_hex !== null;
      markReadbackSupport(result.name, answered);
      if (!answered) {
        return;
      }
      switch (result.name) {
        case "gesture_state":
          setGestureEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "audio_state":
          setAudioModeState(result.raw_value === null ? null : (AUDIO_MODE_BY_RAW[result.raw_value] ?? null));
          break;
        case "mirror_horizontal_state":
        case "mirror_vertical_state": {
          const bits = mirrorBitsRef.current;
          if (result.name === "mirror_horizontal_state") {
            bits.h = result.raw_value === null ? null : result.raw_value === 1;
          } else {
            bits.v = result.raw_value === null ? null : result.raw_value === 1;
          }
          if (bits.h !== null || bits.v !== null) {
            setMirrorModeState(mirrorModeFromBits(bits.h === true, bits.v === true));
          }
          break;
        }
        case "auto_rotate_state":
          setAutoRotateEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "focus_metering_state": {
          const mode = result.raw_value === null ? null : (FOCUS_METERING_BY_RAW[result.raw_value] ?? null);
          setFocusMeteringModeState(mode);
          const bytes = hexBytes(result.response_hex);
          if (mode === "selected_area" && bytes && bytes.length > 10) {
            setFocusMeteringPointState({ x: bytes[9], y: bytes[10] });
          }
          break;
        }
        case "auto_privacy_state": {
          const seconds = leUint32(result.response_hex, 8);
          if (seconds !== null) {
            setAutoPrivacySecondsState(seconds);
          }
          break;
        }
        case "denoise_state":
          setDenoiseEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "wb_lock_state":
          setWbLockEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "ev_lock_state":
          setEvLockEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "focus_lock_state":
          setFocusLockEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "remote_pairing_state":
          setRemotePairingEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          break;
        case "power_on_default_state": {
          setPowerOnDefaultEnabledState(result.raw_value === null ? null : result.raw_value === 1);
          const pan = leFloat(result.response_hex, 9);
          const tilt = leFloat(result.response_hex, 13);
          if (pan !== null && tilt !== null) {
            setPowerOnDefaultPositionState({ pan: roundDegrees(pan), tilt: roundDegrees(tilt) });
          }
          break;
        }
        case "motor_pos_pan": {
          const position = leFloat(result.response_hex, 13) ?? leFloat(result.response_hex, 9);
          if (position !== null) {
            setMotorPosPanDegState(roundDegrees(position));
          }
          break;
        }
        case "motor_pos_tilt": {
          const position = leFloat(result.response_hex, 13) ?? leFloat(result.response_hex, 9);
          if (position !== null) {
            setMotorPosTiltDegState(roundDegrees(position));
          }
          break;
        }
        case "motor_speed_pan": {
          const speed = leFloat(result.response_hex, 9);
          if (speed !== null) {
            setMotorSpeedPanDegState(roundDegrees(speed));
          }
          break;
        }
        case "motor_speed_tilt": {
          const speed = leFloat(result.response_hex, 9);
          if (speed !== null) {
            setMotorSpeedTiltDegState(roundDegrees(speed));
          }
          break;
        }
        default:
          break;
      }
    },
    [markReadbackSupport]
  );

  const confirmQuery = useCallback(
    async (names: PixyHidQueryName | PixyHidQueryName[]) => {
      const list = Array.isArray(names) ? names : [names];
      for (const name of list) {
        try {
          const result = await fetchPixyHidQuery(name);
          applyQueryResult(result);
        } catch {
          // Confirmation is best-effort; the command already ran.
        }
      }
    },
    [applyQueryResult]
  );

  const refreshExtendedState = useCallback(async () => {
    for (const name of EXTENDED_READBACK_QUERIES) {
      try {
        const result = await fetchPixyHidQuery(name);
        applyQueryResult(result);
      } catch {
        // A failed query leaves the asserted value in place.
      }
    }
    setExtendedReadbackReady(true);
  }, [applyQueryResult]);

  const refreshMotorPositions = useCallback(async () => {
    await confirmQuery(["motor_pos_pan", "motor_pos_tilt"]);
  }, [confirmQuery]);

  const refreshDeviceState = useCallback(
    async (options: { expectNonPrivacy?: boolean; extended?: boolean } = {}) => {
      try {
        const attempts = options.expectNonPrivacy ? NON_PRIVACY_READBACK_RETRIES : 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const deviceState = await fetchPixyHidState();
          const rawValue = deviceState.tracking_raw_value;
          if (options.expectNonPrivacy && rawValue === 2 && attempt < attempts - 1) {
            await delay(NON_PRIVACY_READBACK_RETRY_MS);
            continue;
          }
          setDeviceTrackingRawValue(rawValue);
          setDeviceTrackingRawBits(deviceState.tracking_raw_bits);
          setTargetTrackingModeState(deviceState.target_tracking_mode);
          setTargetTrackingRawValue(deviceState.target_tracking_raw_value);
          if (rawValue === 0 || deviceState.tracking_mode === "off") {
            setDeviceTrackingState("standard");
            setTrackingModeState("off");
          } else if (rawValue === 1 || deviceState.tracking_mode === "tracking") {
            setDeviceTrackingState("tracking");
            setTrackingModeState("tracking");
          } else if (rawValue === 2 || deviceState.tracking_mode === "privacy") {
            setDeviceTrackingState("privacy");
            setTrackingModeState("privacy");
          } else if (rawValue === 3) {
            setDeviceTrackingState("non_privacy");
            setTrackingModeState((current) => (current === "privacy" ? null : current));
          } else {
            setDeviceTrackingState("unknown");
          }
          // /state already reports audio DSP and gesture — reflect them instead
          // of leaving the panel on last-asserted values.
          setAudioModeState(deviceState.audio_mode);
          setGestureEnabledState(deviceState.gesture_enabled);
          if (options.extended) {
            await refreshExtendedState();
          }
          return;
        }
        if (options.extended) {
          await refreshExtendedState();
        }
      } catch {
        setDeviceTrackingState("unknown");
        setDeviceTrackingRawValue(null);
        setDeviceTrackingRawBits([]);
        setTargetTrackingModeState(null);
        setTargetTrackingRawValue(null);
      }
    },
    [refreshExtendedState]
  );

  const refreshStatusInternal = useCallback(async (options: { clearState?: boolean; showLoading?: boolean } = {}) => {
    if (options.showLoading !== false) {
      setIsLoading(true);
    }
    setError(null);
    if (options.clearState) {
      clearAssertedState();
    }
    try {
      const nextStatus = await fetchPixyHidStatus();
      setStatus(nextStatus);
      if (nextStatus.writable) {
        await refreshDeviceState({ extended: true });
      } else {
        setDeviceTrackingState("unknown");
        setDeviceTrackingRawValue(null);
        setDeviceTrackingRawBits([]);
        setTargetTrackingModeState(null);
        setTargetTrackingRawValue(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect Pixy HID");
    } finally {
      setIsLoading(false);
    }
  }, [clearAssertedState, refreshDeviceState]);

  const refreshStatus = useCallback(async (options: { showLoading?: boolean } = {}) => {
    await refreshStatusInternal({ clearState: false, showLoading: options.showLoading });
  }, [refreshStatusInternal]);

  const refresh = useCallback(async () => {
    await refreshStatusInternal({ clearState: true, showLoading: true });
  }, [refreshStatusInternal]);

  useEffect(() => {
    void refreshStatus({ showLoading: true });
  }, [refreshStatus]);

  const runCommand = useCallback(
    async (command: string, action: () => Promise<void>): Promise<boolean> => {
      setPendingCommand(command);
      setError(null);
      try {
        await action();
        setLastCommand(command);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to run Pixy HID command");
        return false;
      } finally {
        setPendingCommand(null);
      }
    },
    []
  );

  const setTrackingMode = useCallback(
    async (mode: TrackingMode) =>
      runCommand(`tracking:${mode}`, async () => {
        await setPixyTracking(mode);
        setTrackingModeState(mode);
        await refreshDeviceState({ expectNonPrivacy: mode !== "privacy" });
      }),
    [refreshDeviceState, runCommand]
  );

  const setGestureEnabled = useCallback(
    async (enabled: boolean) =>
      runCommand(`gesture:${enabled ? "on" : "off"}`, async () => {
        await setPixyGesture(enabled);
        setGestureEnabledState(enabled);
        await confirmQuery("gesture_state");
      }),
    [confirmQuery, runCommand]
  );

  const setTargetTrackingMode = useCallback(
    async (mode: TargetTrackingMode) =>
      runCommand(`target-tracking:${mode}`, async () => {
        await setPixyTargetTracking(mode);
        setTrackingModeState(mode === "off" ? "off" : "tracking");
        setTargetTrackingModeState(mode);
        await refreshDeviceState({ expectNonPrivacy: mode !== "off" });
      }),
    [refreshDeviceState, runCommand]
  );

  const setAutoRotateEnabled = useCallback(
    async (enabled: boolean) =>
      runCommand(`auto-rotate:${enabled ? "on" : "off"}`, async () => {
        await setPixyAutoRotate(enabled);
        setAutoRotateEnabledState(enabled);
        await confirmQuery("auto_rotate_state");
      }),
    [confirmQuery, runCommand]
  );

  const setMirrorMode = useCallback(
    async (mode: MirrorMode) =>
      runCommand(`mirror:${mode}`, async () => {
        await setPixyMirror(mode);
        setMirrorModeState(mode);
        // Mirror only applies while a video stream is open; the device query
        // is the source of truth and reverts the toggle when it did not take.
        mirrorBitsRef.current = {
          h: mode === "h" || mode === "hv",
          v: mode === "v" || mode === "hv"
        };
        await confirmQuery(["mirror_horizontal_state", "mirror_vertical_state"]);
      }),
    [confirmQuery, runCommand]
  );

  const setFocusMeteringMode = useCallback(
    async (mode: FocusMeteringMode, point?: FocusMeteringPoint) =>
      runCommand(`focus-metering:${mode}${point ? `:${point.x},${point.y}` : ""}`, async () => {
        await setPixyFocusMetering(mode, point);
        setFocusMeteringModeState(mode);
        setFocusMeteringPointState(point ?? null);
        await confirmQuery("focus_metering_state");
      }),
    [confirmQuery, runCommand]
  );

  const setAudioMode = useCallback(
    async (mode: AudioMode) =>
      runCommand(`audio:${mode}`, async () => {
        await setPixyAudio(mode);
        setAudioModeState(mode);
        await confirmQuery("audio_state");
      }),
    [confirmQuery, runCommand]
  );

  const setAutoPrivacySeconds = useCallback(
    async (seconds: number) =>
      runCommand(`auto-privacy:${seconds}`, async () => {
        await setPixyAutoPrivacy(seconds);
        setAutoPrivacySecondsState(seconds);
        await confirmQuery("auto_privacy_state");
      }),
    [confirmQuery, runCommand]
  );

  const sendPtzDirection = useCallback(
    async (direction: PtzDirection) =>
      runCommand(`ptz:${direction}`, async () => {
        await sendPixyPtzDirection(direction);
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const sendPtzRelative = useCallback(
    async (direction: PtzDirection, degrees: number) =>
      runCommand(`ptz-relative:${direction}:${degrees}`, async () => {
        await sendPixyPtzRelative(direction, degrees);
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const sendPtzAbsolute = useCallback(
    async (pan: number, tilt: number) =>
      runCommand(`ptz-absolute:${pan},${tilt}`, async () => {
        await sendPixyPtzAbsolute(pan, tilt);
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const sendPtzVector = useCallback(
    async (vector: PtzVector) =>
      runCommand(`ptz-vector:${vector.x},${vector.y},${vector.z ?? 0}`, async () => {
        await sendPixyPtzVector(vector);
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const recenterPtz = useCallback(
    async () =>
      runCommand("ptz-recenter", async () => {
        await recenterPixyPtz();
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const savePtzPreset = useCallback(
    async (slot: PtzPresetSlot) =>
      runCommand(`ptz-preset-save:${slot}`, async () => {
        await savePixyPtzPreset(slot);
      }),
    [runCommand]
  );

  const loadPtzPreset = useCallback(
    async (slot: PtzPresetSlot) =>
      runCommand(`ptz-preset-load:${slot}`, async () => {
        await loadPixyPtzPreset(slot);
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const clearPtzPreset = useCallback(
    async (slot: PtzPresetSlot) =>
      runCommand(`ptz-preset-clear:${slot}`, async () => {
        await clearPixyPtzPreset(slot);
      }),
    [runCommand]
  );

  const capturePowerOnDefault = useCallback(
    async () =>
      runCommand("power-on-default:capture", async () => {
        await capturePixyPowerOnDefault();
        await confirmQuery("power_on_default_state");
      }),
    [confirmQuery, runCommand]
  );

  const disablePowerOnDefault = useCallback(
    async () =>
      runCommand("power-on-default:disable", async () => {
        await disablePixyPowerOnDefault();
        await confirmQuery("power_on_default_state");
      }),
    [confirmQuery, runCommand]
  );

  const goToDefault = useCallback(
    async () =>
      runCommand("go-to-default", async () => {
        await pixyGoToDefault();
        await refreshMotorPositions();
      }),
    [refreshMotorPositions, runCommand]
  );

  const setDenoise = useCallback(
    async (enabled: boolean) =>
      runCommand(`denoise:${enabled ? "on" : "off"}`, async () => {
        await setPixyDenoise(enabled);
        setDenoiseEnabledState(enabled);
        await confirmQuery("denoise_state");
      }),
    [confirmQuery, runCommand]
  );

  const setWbLock = useCallback(
    async (enabled: boolean) =>
      runCommand(`wb-lock:${enabled ? "on" : "off"}`, async () => {
        await setPixyWbLock(enabled);
        setWbLockEnabledState(enabled);
        await confirmQuery("wb_lock_state");
      }),
    [confirmQuery, runCommand]
  );

  const setEvLock = useCallback(
    async (enabled: boolean, exposure = 0) =>
      runCommand(`ev-lock:${enabled ? "on" : "off"}`, async () => {
        await setPixyEvLock(enabled, exposure);
        setEvLockEnabledState(enabled);
        await confirmQuery("ev_lock_state");
      }),
    [confirmQuery, runCommand]
  );

  const setFocusLock = useCallback(
    async (enabled: boolean) =>
      runCommand(`focus-lock:${enabled ? "on" : "off"}`, async () => {
        await setPixyFocusLock(enabled);
        setFocusLockEnabledState(enabled);
        await confirmQuery("focus_lock_state");
      }),
    [confirmQuery, runCommand]
  );

  const setRemotePairing = useCallback(
    async (enabled: boolean) =>
      runCommand(`remote-pairing:${enabled ? "on" : "off"}`, async () => {
        await setPixyRemotePairing(enabled);
        setRemotePairingEnabledState(enabled);
        await confirmQuery("remote_pairing_state");
      }),
    [confirmQuery, runCommand]
  );

  const setMotorSpeed = useCallback(
    async (axis: number, degreesPerSecond: number) =>
      runCommand(`motor-speed:${axis}:${degreesPerSecond}`, async () => {
        await setPixyMotorSpeed(axis, degreesPerSecond);
        if (axis === 1) {
          setMotorSpeedPanDegState(degreesPerSecond);
        } else {
          setMotorSpeedTiltDegState(degreesPerSecond);
        }
        await confirmQuery(axis === 1 ? "motor_speed_pan" : "motor_speed_tilt");
      }),
    [confirmQuery, runCommand]
  );

  return {
    status,
    isLoading,
    pendingCommand,
    error,
    lastCommand,
    trackingMode,
    deviceTrackingState,
    deviceTrackingRawValue,
    deviceTrackingRawBits,
    targetTrackingMode,
    targetTrackingRawValue,
    gestureEnabled,
    autoRotateEnabled,
    mirrorMode,
    focusMeteringMode,
    focusMeteringPoint,
    audioMode,
    autoPrivacySeconds,
    denoiseEnabled,
    wbLockEnabled,
    evLockEnabled,
    focusLockEnabled,
    remotePairingEnabled,
    powerOnDefaultEnabled,
    powerOnDefaultPosition,
    motorPosPanDeg,
    motorPosTiltDeg,
    motorSpeedPanDeg,
    motorSpeedTiltDeg,
    unsupportedReadbacks,
    extendedReadbackReady,
    refresh,
    refreshStatus,
    setTrackingMode,
    setTargetTrackingMode,
    setGestureEnabled,
    setAutoRotateEnabled,
    setMirrorMode,
    setFocusMeteringMode,
    setAudioMode,
    setAutoPrivacySeconds,
    sendPtzDirection,
    sendPtzRelative,
    sendPtzAbsolute,
    sendPtzVector,
    recenterPtz,
    savePtzPreset,
    loadPtzPreset,
    clearPtzPreset,
    capturePowerOnDefault,
    disablePowerOnDefault,
    goToDefault,
    setDenoise,
    setWbLock,
    setEvLock,
    setFocusLock,
    setRemotePairing,
    setMotorSpeed
  };
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function hexBytes(hex: string | null): number[] | null {
  if (!hex) {
    return null;
  }
  const bytes = hex
    .trim()
    .split(/\s+/)
    .map((part) => Number.parseInt(part, 16));
  return bytes.every((byte) => Number.isFinite(byte) && byte >= 0 && byte <= 0xff) ? bytes : null;
}

function leFloat(hex: string | null, index: number): number | null {
  const bytes = hexBytes(hex);
  if (!bytes || bytes.length < index + 4) {
    return null;
  }
  const view = new DataView(new Uint8Array(bytes.slice(index, index + 4)).buffer);
  const value = view.getFloat32(0, true);
  return Number.isFinite(value) ? value : null;
}

function leUint32(hex: string | null, index: number): number | null {
  const bytes = hexBytes(hex);
  if (!bytes || bytes.length < index + 4) {
    return null;
  }
  return (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0;
}

function mirrorModeFromBits(horizontal: boolean, vertical: boolean): MirrorMode {
  if (horizontal && vertical) {
    return "hv";
  }
  if (horizontal) {
    return "h";
  }
  if (vertical) {
    return "v";
  }
  return "off";
}

function roundDegrees(value: number): number {
  return Math.round(value * 100) / 100;
}
