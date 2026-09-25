import { useEffect, useRef, useSyncExternalStore } from "react";

import type { UseAudioResult } from "../hooks/useAudio";
import type { UseControlsResult } from "../hooks/useControls";
import type { UseDevicesResult } from "../hooks/useDevices";
import type { UsePixyHidResult } from "../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../hooks/useVideoFormats";

export type CommandLogCategory =
  | "hid"
  | "v4l2"
  | "stream"
  | "focus"
  | "audio"
  | "record"
  | "safety"
  | "system";

export type CommandLogTone = "info" | "ok" | "warn" | "error";

export type CommandLogEntry = {
  id: number;
  at: number;
  category: CommandLogCategory;
  message: string;
  tone: CommandLogTone;
};

export const COMMAND_LOG_CATEGORIES: CommandLogCategory[] = [
  "hid",
  "v4l2",
  "stream",
  "focus",
  "audio",
  "record",
  "safety",
  "system"
];

const MAX_ENTRIES = 120;
const DEDUPE_WINDOW_MS = 1500;

let entries: CommandLogEntry[] = [];
let nextId = 1;
let lastSignature: string | null = null;
let lastSignatureAt = 0;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function appendCommandLog(input: {
  category: CommandLogCategory;
  message: string;
  tone?: CommandLogTone;
}): CommandLogEntry | null {
  const signature = `${input.category}:${input.message}`;
  const now = Date.now();
  if (signature === lastSignature && now - lastSignatureAt < DEDUPE_WINDOW_MS) {
    return null;
  }
  lastSignature = signature;
  lastSignatureAt = now;

  const entry: CommandLogEntry = {
    id: nextId,
    at: now,
    category: input.category,
    message: input.message,
    tone: input.tone ?? "info"
  };
  nextId += 1;
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  emit();
  return entry;
}

export function clearCommandLog(): void {
  entries = [];
  lastSignature = null;
  emit();
}

export function getCommandLogEntries(): CommandLogEntry[] {
  return entries;
}

export function subscribeCommandLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useCommandLogEntries(): CommandLogEntry[] {
  return useSyncExternalStore(subscribeCommandLog, getCommandLogEntries, getCommandLogEntries);
}

export function resetCommandLogForTests(): void {
  entries = [];
  nextId = 1;
  lastSignature = null;
  lastSignatureAt = 0;
}

export type CommandLogSources = {
  devices: UseDevicesResult;
  controls: UseControlsResult;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
  audio: UseAudioResult;
  privacySafety: UsePrivacySafetyResult;
};

type Snapshot = {
  deviceCount: number;
  selectedDeviceName: string | null;
  devicesError: string | null;
  controlCount: number;
  pendingControl: string | null;
  controlsError: string | null;
  formatLabel: string | null;
  formatsError: string | null;
  previewEnabled: boolean;
  recording: boolean;
  recordingPath: string | null;
  captureError: string | null;
  hidLastCommand: string | null;
  hidError: string | null;
  focusMode: string | null;
  focusPoint: string | null;
  micMuted: boolean | null;
  monitorRunning: boolean | null;
  meterRunning: boolean | null;
  audioError: string | null;
  startupPrivacyState: string;
  privacyCommandState: string;
  settingsError: string | null;
};

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function snapshotOf(sources: CommandLogSources): Snapshot {
  return {
    deviceCount: sources.devices.devices.length,
    selectedDeviceName: sources.devices.selectedDeviceName,
    devicesError: sources.devices.error,
    controlCount: sources.controls.controls.length,
    pendingControl: sources.controls.pendingControl,
    controlsError: sources.controls.error,
    formatLabel: sources.videoFormats.selectedFormat?.label ?? null,
    formatsError: sources.videoFormats.error,
    previewEnabled: sources.videoCapture.previewEnabled,
    recording: sources.videoCapture.status?.recording === true,
    recordingPath: sources.videoCapture.status?.path ?? null,
    captureError: sources.videoCapture.error,
    hidLastCommand: sources.pixyHid.lastCommand,
    hidError: sources.pixyHid.error,
    focusMode: sources.pixyHid.focusMeteringMode,
    focusPoint: sources.pixyHid.focusMeteringPoint
      ? `${sources.pixyHid.focusMeteringPoint.x},${sources.pixyHid.focusMeteringPoint.y}`
      : null,
    micMuted: sources.audio.status?.muted ?? null,
    monitorRunning: sources.audio.status?.monitor_running ?? null,
    meterRunning: sources.audio.status?.meter_running ?? null,
    audioError: sources.audio.error,
    startupPrivacyState: sources.privacySafety.startupPrivacyState,
    privacyCommandState: sources.privacySafety.privacyCommandState,
    settingsError: sources.privacySafety.settingsError
  };
}

const STARTUP_PRIVACY_MESSAGES: Record<string, { message: string; tone: CommandLogTone }> = {
  enabled: { message: "startup privacy on (applied by the service at boot)", tone: "info" },
  disabled: { message: "startup privacy off", tone: "info" },
  unknown: { message: "startup privacy setting unavailable", tone: "warn" }
};

const PRIVACY_COMMAND_MESSAGES: Record<string, { message: string; tone: CommandLogTone }> = {
  sending: { message: "privacy sending", tone: "info" },
  applied: { message: "privacy on, mic muted", tone: "ok" },
  "mic-failed": { message: "privacy on, mic mute failed", tone: "warn" },
  failed: { message: "privacy command failed", tone: "error" }
};

function diffSnapshots(prev: Snapshot | undefined, next: Snapshot): void {
  const firstPass = prev === undefined;
  const was = prev ?? ({} as Partial<Snapshot>);

  if (next.devicesError && next.devicesError !== was.devicesError) {
    appendCommandLog({ category: "system", message: `device scan failed: ${next.devicesError}`, tone: "error" });
  }
  if (!firstPass && next.deviceCount !== was.deviceCount) {
    appendCommandLog({
      category: "system",
      message:
        next.deviceCount > (was.deviceCount ?? 0)
          ? `capture device appeared (${next.deviceCount} visible)`
          : next.deviceCount === 0
            ? "capture device removed"
            : `capture device removed (${next.deviceCount} visible)`,
      tone: next.deviceCount > (was.deviceCount ?? 0) ? "ok" : "warn"
    });
  }
  if (!firstPass && next.selectedDeviceName !== was.selectedDeviceName && next.selectedDeviceName) {
    appendCommandLog({ category: "system", message: `selected ${next.selectedDeviceName}` });
  }

  if (next.controlsError && next.controlsError !== was.controlsError) {
    appendCommandLog({ category: "v4l2", message: `control error: ${next.controlsError}`, tone: "error" });
  }
  if (next.pendingControl && next.pendingControl !== was.pendingControl) {
    appendCommandLog({ category: "v4l2", message: `write ${next.pendingControl}` });
  }
  if (!firstPass && next.controlCount > 0 && (was.controlCount ?? 0) === 0) {
    appendCommandLog({ category: "v4l2", message: `${next.controlCount} controls enumerated` });
  }

  if (next.formatsError && next.formatsError !== was.formatsError) {
    appendCommandLog({ category: "stream", message: `format error: ${next.formatsError}`, tone: "error" });
  }
  if (next.formatLabel && next.formatLabel !== was.formatLabel) {
    appendCommandLog({ category: "stream", message: `format ${next.formatLabel}` });
  }

  if (!firstPass && next.previewEnabled !== was.previewEnabled) {
    appendCommandLog({
      category: "stream",
      message: next.previewEnabled ? "preview started" : "preview stopped"
    });
  }
  if (!firstPass && next.recording !== was.recording) {
    if (next.recording) {
      appendCommandLog({ category: "record", message: "recording started", tone: "ok" });
    } else {
      appendCommandLog({
        category: "record",
        message: next.recordingPath ? `recording saved ${fileName(next.recordingPath)}` : "recording stopped"
      });
    }
  }
  if (next.captureError && next.captureError !== was.captureError) {
    appendCommandLog({ category: "stream", message: `capture error: ${next.captureError}`, tone: "error" });
  }

  if (next.hidLastCommand && next.hidLastCommand !== was.hidLastCommand) {
    appendCommandLog({ category: "hid", message: next.hidLastCommand, tone: "ok" });
  }
  if (next.hidError && next.hidError !== was.hidError) {
    appendCommandLog({ category: "hid", message: `command failed: ${next.hidError}`, tone: "error" });
  }
  if (!firstPass && next.focusMode !== was.focusMode && next.focusMode) {
    appendCommandLog({ category: "focus", message: `metering ${next.focusMode}` });
  }
  if (!firstPass && next.focusPoint !== was.focusPoint && next.focusPoint) {
    appendCommandLog({ category: "focus", message: `metering point ${next.focusPoint}` });
  }

  if (next.audioError && next.audioError !== was.audioError) {
    appendCommandLog({ category: "audio", message: `audio error: ${next.audioError}`, tone: "error" });
  }
  if (!firstPass && next.micMuted !== was.micMuted && next.micMuted !== null) {
    appendCommandLog({ category: "audio", message: next.micMuted ? "mic muted" : "mic live" });
  }
  if (!firstPass && next.monitorRunning !== was.monitorRunning && next.monitorRunning !== null) {
    appendCommandLog({
      category: "audio",
      message: next.monitorRunning ? "level monitor on" : "level monitor off"
    });
  }
  if (!firstPass && next.meterRunning !== was.meterRunning && next.meterRunning !== null) {
    appendCommandLog({
      category: "audio",
      message: next.meterRunning ? "level meter on" : "level meter off"
    });
  }

  if (!firstPass && next.startupPrivacyState !== was.startupPrivacyState) {
    const entry = STARTUP_PRIVACY_MESSAGES[next.startupPrivacyState];
    if (entry) {
      appendCommandLog({ category: "safety", message: entry.message, tone: entry.tone });
    }
  }
  if (!firstPass && next.privacyCommandState !== was.privacyCommandState) {
    const entry = PRIVACY_COMMAND_MESSAGES[next.privacyCommandState];
    if (entry) {
      appendCommandLog({ category: "safety", message: entry.message, tone: entry.tone });
    }
  }
  if (next.settingsError && next.settingsError !== was.settingsError) {
    appendCommandLog({ category: "safety", message: `settings error: ${next.settingsError}`, tone: "error" });
  }
}

/**
 * Mirrors state transitions from the deck's data hooks into the shared
 * command log. Mounted once at the app root so events are captured even while
 * the diagnostics view (which renders the log) is hidden.
 */
export function useCommandLogFeed(sources: CommandLogSources): void {
  const previousRef = useRef<Snapshot | undefined>(undefined);
  const sourcesRef = useRef<CommandLogSources>(sources);
  sourcesRef.current = sources;

  useEffect(() => {
    const next = snapshotOf(sourcesRef.current);
    diffSnapshots(previousRef.current, next);
    previousRef.current = next;
  });
}
