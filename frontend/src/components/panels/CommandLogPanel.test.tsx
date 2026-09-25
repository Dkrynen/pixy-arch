import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseAudioResult } from "../../hooks/useAudio";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import { appendCommandLog, resetCommandLogForTests } from "../../lib/commandLog";
import { CommandLogPanel } from "./CommandLogPanel";

describe("CommandLogPanel", () => {
  beforeEach(() => {
    resetCommandLogForTests();
  });

  it("summarizes the active camera command state", () => {
    render(
      <CommandLogPanel
        controls={controls()}
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid()}
        audio={audio()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText("Command Log")).toBeInTheDocument();
    expect(screen.getByText("tracking:privacy")).toBeInTheDocument();
    expect(screen.getByText("writing brightness")).toBeInTheDocument();
    expect(screen.getByText("selected_area @ 64,32")).toBeInTheDocument();
    expect(screen.getByText("MJPG 1280x720 30fps")).toBeInTheDocument();
    expect(screen.getByText("recording")).toBeInTheDocument();
    expect(screen.getByText("mic muted")).toBeInTheDocument();
    expect(screen.getByText("startup privacy on")).toBeInTheDocument();
  });

  it("reports a failed privacy command honestly in the safety summary", () => {
    render(
      <CommandLogPanel
        controls={controls()}
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid()}
        audio={audio()}
        privacySafety={{ ...privacySafety(), privacyCommandState: "failed" }}
      />
    );

    expect(screen.getByText("privacy failed")).toBeInTheDocument();
    expect(screen.queryByText("startup privacy on")).not.toBeInTheDocument();
  });

  it("renders timestamped feed entries and an empty state", () => {
    render(
      <CommandLogPanel
        controls={controls()}
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid()}
        audio={audio()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });

  it("lists feed entries and filters them by category", () => {
    appendCommandLog({ category: "hid", message: "tracking:privacy", tone: "ok" });
    appendCommandLog({ category: "system", message: "video4linux add /dev/video0" });
    appendCommandLog({ category: "record", message: "recording started", tone: "ok" });

    render(
      <CommandLogPanel
        controls={controls()}
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid()}
        audio={audio()}
        privacySafety={privacySafety()}
      />
    );

    const feed = screen.getByRole("log", { name: "Event feed" });
    expect(feed).toHaveTextContent("video4linux add /dev/video0");
    expect(feed).toHaveTextContent("recording started");

    fireEvent.click(screen.getByRole("button", { name: /System/ }));
    expect(feed).toHaveTextContent("video4linux add /dev/video0");
    expect(feed).not.toHaveTextContent("recording started");

    fireEvent.click(screen.getByRole("button", { name: /All/ }));
    expect(feed).toHaveTextContent("recording started");
  });

  it("clears the feed from the clear button", () => {
    appendCommandLog({ category: "hid", message: "gesture:on" });

    render(
      <CommandLogPanel
        controls={controls()}
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid()}
        audio={audio()}
        privacySafety={privacySafety()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear event log" }));
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });
});

function controls(): UseControlsResult {
  return {
    controls: [],
    groups: [],
    isLoading: false,
    error: null,
    pendingControl: "brightness",
    refresh: vi.fn(),
    setValue: vi.fn(),
    setValues: vi.fn()
  };
}

function videoFormats(): UseVideoFormatsResult {
  return {
    formats: [],
    selectedFormat: {
      pixel_format: "MJPG",
      description: "Motion-JPEG",
      width: 1280,
      height: 720,
      fps: 30,
      frame_interval_100ns: 333333,
      label: "MJPG 1280x720 30fps"
    },
    selectedKey: "MJPG:1280:720:333333",
    isLoading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    setSelectedKey: vi.fn()
  };
}

function videoCapture(): UseVideoCaptureResult {
  return {
    previewEnabled: true,
    streamUrl: "/stream",
    status: {
      recording: true,
      device_name: "video0",
      path: "/tmp/test.mkv",
      started_at: "2026-06-10T10:00:00Z",
      reason: null
    },
    pending: false,
    error: null,
    togglePreview: vi.fn(),
    restartPreview: vi.fn(),
    refreshStatus: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn()
  };
}

function pixyHid(): UsePixyHidResult {
  return {
    status: {
      available: true,
      path: "/dev/hidraw14",
      readable: true,
      writable: true,
      reason: null,
      known_controls: ["tracking", "focus_metering"]
    },
    isLoading: false,
    pendingCommand: null,
    error: null,
    lastCommand: "tracking:privacy",
    trackingMode: "privacy",
    deviceTrackingState: "unknown",
    deviceTrackingRawValue: null,
    deviceTrackingRawBits: [],
    targetTrackingMode: null,
    targetTrackingRawValue: null,
    gestureEnabled: null,
    autoRotateEnabled: null,
    mirrorMode: null,
    focusMeteringMode: "selected_area",
    focusMeteringPoint: { x: 64, y: 32 },
    audioMode: null,
    autoPrivacySeconds: null,
    refresh: vi.fn(),
    refreshStatus: vi.fn(),
    setTrackingMode: vi.fn(),
    setTargetTrackingMode: vi.fn(),
    setGestureEnabled: vi.fn(),
    setAutoRotateEnabled: vi.fn(),
    setMirrorMode: vi.fn(),
    setFocusMeteringMode: vi.fn(),
    setAudioMode: vi.fn(),
    setAutoPrivacySeconds: vi.fn(),
    sendPtzDirection: vi.fn(),
    sendPtzRelative: vi.fn(),
    sendPtzAbsolute: vi.fn(),
    sendPtzVector: vi.fn(),
    recenterPtz: vi.fn(),
    savePtzPreset: vi.fn(),
    loadPtzPreset: vi.fn(),
    clearPtzPreset: vi.fn(),
    capturePowerOnDefault: vi.fn(),
    disablePowerOnDefault: vi.fn(),
    goToDefault: vi.fn(),
    setDenoise: vi.fn(),
    setWbLock: vi.fn(),
    setEvLock: vi.fn(),
    setFocusLock: vi.fn(),
    setRemotePairing: vi.fn(),
    setMotorSpeed: vi.fn(),
  };
}

function audio(): UseAudioResult {
  return {
    status: {
      available: true,
      card: 3,
      name: "EMEET PIXY",
      muted: true,
      volume: 10,
      source_node: null,
      default_source: null,
      monitor_running: false,
      reason: null
    },
    isLoading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setDefaultSource: vi.fn(),
    setMonitorRunning: vi.fn(),
    setMeterRunning: vi.fn(),
    restoreDefaultSource: vi.fn()
  };
}

function privacySafety(): UsePrivacySafetyResult {
  return {
    settings: null,
    settingsLoaded: true,
    startupPrivacyEnabled: true,
    startupPrivacyState: "enabled",
    privacyCommandState: "idle",
    settingsError: null,
    settingsPending: false,
    refreshSettings: vi.fn(),
    saveSettings: vi.fn(),
    enterPrivacy: vi.fn(),
    leavePrivacy: vi.fn()
  };
}
