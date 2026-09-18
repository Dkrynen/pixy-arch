import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { UseAudioResult } from "../hooks/useAudio";
import type { UseControlsResult } from "../hooks/useControls";
import type { UseDevicesResult } from "../hooks/useDevices";
import type { UsePixyHidResult } from "../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../hooks/useVideoFormats";
import {
  appendCommandLog,
  clearCommandLog,
  getCommandLogEntries,
  resetCommandLogForTests,
  useCommandLogEntries,
  useCommandLogFeed,
  type CommandLogSources
} from "./commandLog";

describe("commandLog store", () => {
  beforeEach(() => {
    resetCommandLogForTests();
  });

  it("appends entries newest-first and notifies subscribers", () => {
    const { result } = renderHook(() => useCommandLogEntries());

    act(() => {
      appendCommandLog({ category: "hid", message: "tracking:privacy", tone: "ok" });
      appendCommandLog({ category: "system", message: "video4linux add /dev/video0" });
    });

    expect(result.current).toHaveLength(2);
    expect(result.current[0].message).toBe("video4linux add /dev/video0");
    expect(result.current[1].message).toBe("tracking:privacy");
    expect(result.current[0].at).toBeGreaterThan(0);
  });

  it("dedupes identical messages inside the dedupe window", () => {
    appendCommandLog({ category: "system", message: "event link lost — retrying", tone: "warn" });
    expect(appendCommandLog({ category: "system", message: "event link lost — retrying", tone: "warn" })).toBeNull();
    expect(getCommandLogEntries()).toHaveLength(1);
  });

  it("clears entries", () => {
    appendCommandLog({ category: "hid", message: "gesture:on" });
    clearCommandLog();
    expect(getCommandLogEntries()).toHaveLength(0);
  });

  it("bounds the log to the max entry count", () => {
    for (let index = 0; index < 140; index += 1) {
      appendCommandLog({ category: "system", message: `event ${index}` });
    }
    expect(getCommandLogEntries().length).toBeLessThanOrEqual(120);
    expect(getCommandLogEntries()[0].message).toBe("event 139");
  });
});

describe("useCommandLogFeed", () => {
  beforeEach(() => {
    resetCommandLogForTests();
  });

  it("logs state transitions from deck hooks", () => {
    const initial = sources();
    const { rerender } = renderHook(
      ({ sources: current }) => useCommandLogFeed(current),
      { initialProps: { sources: initial } }
    );

    // First pass only snapshots; no transition entries yet.
    expect(getCommandLogEntries()).toHaveLength(0);

    const next = sources();
    next.pixyHid.lastCommand = "tracking:privacy";
    next.controls.pendingControl = "brightness";
    next.videoCapture.previewEnabled = true;
    next.audio.status = { ...next.audio.status!, muted: true };
    rerender({ sources: next });

    const messages = getCommandLogEntries().map((entry) => `${entry.category}:${entry.message}`);
    expect(messages).toContain("hid:tracking:privacy");
    expect(messages).toContain("v4l2:write brightness");
    expect(messages).toContain("stream:preview started");
    expect(messages).toContain("audio:mic muted");
  });

  it("logs device list changes and errors", () => {
    const initial = sources();
    const { rerender } = renderHook(
      ({ sources: current }) => useCommandLogFeed(current),
      { initialProps: { sources: initial } }
    );

    const appeared = sources();
    appeared.devices.devices = [captureDevice("/dev/video0"), captureDevice("/dev/video2")];
    rerender({ sources: appeared });

    const removed = sources();
    removed.devices.devices = [];
    removed.devices.error = "Failed to fetch";
    rerender({ sources: removed });

    const messages = getCommandLogEntries().map((entry) => entry.message);
    expect(messages).toContain("capture device appeared (2 visible)");
    expect(messages).toContain("capture device removed");
    expect(messages).toContain("device scan failed: Failed to fetch");
  });

  it("logs recording lifecycle with the saved file name", () => {
    const initial = sources();
    const { rerender } = renderHook(
      ({ sources: current }) => useCommandLogFeed(current),
      { initialProps: { sources: initial } }
    );

    const recording = sources();
    recording.videoCapture.status = {
      recording: true,
      device_name: "video0",
      path: null,
      started_at: "2026-09-18T10:00:00Z",
      reason: null
    };
    rerender({ sources: recording });

    const stopped = sources();
    stopped.videoCapture.status = {
      recording: false,
      device_name: "video0",
      path: "/recordings/pixypilot-video0-20260918-100000.mkv",
      started_at: null,
      reason: null
    };
    rerender({ sources: stopped });

    const messages = getCommandLogEntries().map((entry) => `${entry.category}:${entry.message}`);
    expect(messages).toContain("record:recording started");
    expect(messages).toContain("record:recording saved pixypilot-video0-20260918-100000.mkv");
  });
});

function captureDevice(path: string) {
  return {
    path,
    name: "EMEET PIXY: EMEET PIXY",
    driver: "uvcvideo",
    bus_info: "usb-test",
    is_capture: true
  };
}

function sources(): CommandLogSources {
  return {
    devices: {
      devices: [captureDevice("/dev/video0")],
      selectedDeviceName: "video0",
      selectedDevice: captureDevice("/dev/video0"),
      isLoading: false,
      error: null,
      setSelectedDeviceName: () => undefined,
      refresh: async () => undefined
    } as UseDevicesResult,
    controls: {
      controls: [],
      groups: [],
      isLoading: false,
      error: null,
      pendingControl: null,
      refresh: async () => undefined,
      setValue: async () => undefined,
      setValues: async () => undefined
    } as unknown as UseControlsResult,
    videoFormats: {
      formats: [],
      selectedFormat: null,
      selectedKey: "",
      isLoading: false,
      pending: false,
      error: null,
      refresh: async () => undefined,
      setSelectedKey: async () => undefined
    } as UseVideoFormatsResult,
    videoCapture: {
      previewEnabled: false,
      streamUrl: null,
      status: { recording: false, device_name: null, path: null, started_at: null, reason: null },
      pending: false,
      error: null,
      togglePreview: () => undefined,
      restartPreview: () => undefined,
      refreshStatus: async () => undefined,
      startRecording: async () => undefined,
      stopRecording: async () => undefined
    } as UseVideoCaptureResult,
    pixyHid: {
      status: null,
      isLoading: false,
      pendingCommand: null,
      error: null,
      lastCommand: null,
      focusMeteringMode: null,
      focusMeteringPoint: null
    } as unknown as UsePixyHidResult,
    audio: {
      status: {
        available: true,
        card: 0,
        name: "EMEET PIXY",
        muted: false,
        volume: 50,
        source_node: "node",
        default_source: false,
        monitor_running: false,
        reason: null
      },
      isLoading: false,
      pending: false,
      error: null,
      refresh: async () => undefined,
      setMuted: async () => undefined,
      setVolume: async () => undefined,
      setDefaultSource: async () => undefined,
      setMonitorRunning: async () => undefined
    } as UseAudioResult,
    privacySafety: {
      settings: null,
      settingsLoaded: true,
      startupPrivacyEnabled: true,
      startupPrivacyState: "sent",
      settingsError: null,
      settingsPending: false,
      refreshSettings: async () => undefined,
      saveSettings: async () => {
        throw new Error("not implemented");
      },
      enterPrivacy: async () => undefined,
      leavePrivacy: async () => undefined
    } as UsePrivacySafetyResult
  };
}
