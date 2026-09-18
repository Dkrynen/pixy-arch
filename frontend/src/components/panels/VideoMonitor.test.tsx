import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import { VideoMonitor } from "./VideoMonitor";

function videoFormats(): UseVideoFormatsResult {
  return {
    formats: [
      {
        pixel_format: "MJPG",
        description: "Motion-JPEG",
        width: 1280,
        height: 720,
        fps: 30,
        frame_interval_100ns: 333333,
        label: "MJPG 1280x720 30fps"
      }
    ],
    selectedKey: "MJPG:1280:720:333333",
    selectedFormat: {
      pixel_format: "MJPG",
      description: "Motion-JPEG",
      width: 1280,
      height: 720,
      fps: 30,
      frame_interval_100ns: 333333,
      label: "MJPG 1280x720 30fps"
    },
    isLoading: false,
    pending: false,
    error: null,
    setSelectedKey: vi.fn(),
    refresh: vi.fn()
  };
}

function videoCapture(overrides: Partial<UseVideoCaptureResult> = {}): UseVideoCaptureResult {
  return {
    previewEnabled: true,
    streamUrl: "/api/devices/video0/stream",
    status: {
      recording: false,
      device_name: null,
      path: null,
      started_at: null,
      reason: null
    },
    pending: false,
    error: null,
    refreshStatus: vi.fn(),
    togglePreview: vi.fn(),
    restartPreview: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    ...overrides
  };
}

function pixyHid(setFocusMeteringMode = vi.fn().mockResolvedValue(undefined)): UsePixyHidResult {
  return {
    status: {
      available: true,
      path: "/dev/hidraw14",
      readable: true,
      writable: true,
      reason: null,
      known_controls: ["focus_metering"]
    },
    isLoading: false,
    pendingCommand: null,
    error: null,
    lastCommand: null,
    trackingMode: null,
    deviceTrackingState: "unknown",
    deviceTrackingRawValue: null,
    deviceTrackingRawBits: [],
    targetTrackingMode: null,
    targetTrackingRawValue: null,
    gestureEnabled: null,
    autoRotateEnabled: null,
    mirrorMode: null,
    focusMeteringMode: null,
    focusMeteringPoint: null,
    audioMode: null,
    autoPrivacySeconds: null,
    refresh: vi.fn(),
    refreshStatus: vi.fn(),
    setTrackingMode: vi.fn(),
    setTargetTrackingMode: vi.fn(),
    setGestureEnabled: vi.fn(),
    setAutoRotateEnabled: vi.fn(),
    setMirrorMode: vi.fn(),
    setFocusMeteringMode,
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

describe("VideoMonitor", () => {
  it("warns that preview owns the camera while streaming", () => {
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture({ previewEnabled: true })}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("Preview owns the camera. Hide preview before opening it in another app.")).toBeInTheDocument();
  });

  it("shows that other apps can use the camera when preview is stopped", () => {
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture({ previewEnabled: false, streamUrl: null })}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("Preview is stopped. The camera is available to other apps.")).toBeInTheDocument();
  });

  it("sends selected-area focus coordinates from a preview click", async () => {
    const setFocusMeteringMode = vi.fn().mockResolvedValue(undefined);
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid(setFocusMeteringMode)}
      />
    );
    const frame = screen.getByAltText("Live camera stream").parentElement!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      toJSON: () => ({})
    });

    fireEvent.pointerUp(frame, { clientX: 640, clientY: 360 });

    await waitFor(() =>
    expect(setFocusMeteringMode).toHaveBeenCalledWith("selected_area", { x: 64, y: 64 })
    );
    expect(frame.querySelector(".focus-target-region")).not.toBeNull();
  });

  it("restarts the preview stream after an image load error", async () => {
    vi.useFakeTimers();
    const restartPreview = vi.fn();
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture({ restartPreview })}
        pixyHid={pixyHid()}
      />
    );

    fireEvent.error(screen.getByAltText("Live camera stream"));
    vi.advanceTimersByTime(750);

    expect(restartPreview).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("shows a connecting state until the first frame loads", () => {
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("Connecting to camera…")).toBeInTheDocument();

    fireEvent.load(screen.getByAltText("Live camera stream"));

    expect(screen.queryByText("Connecting to camera…")).not.toBeInTheDocument();
  });

  it("gives up reconnecting after repeated failures and offers a retry", () => {
    vi.useFakeTimers();
    const restartPreview = vi.fn();
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture({ restartPreview })}
        pixyHid={pixyHid()}
      />
    );
    const img = screen.getByAltText("Live camera stream");

    for (const delay of [750, 1500, 2250, 3000]) {
      fireEvent.error(img);
      vi.advanceTimersByTime(delay);
    }
    fireEvent.error(img);

    expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry preview" });
    fireEvent.click(retry);

    expect(restartPreview).toHaveBeenCalledTimes(5);
    expect(screen.queryByText("Preview unavailable")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("shows the privacy overlay while the device reports privacy mode", () => {
    const hid = pixyHid();
    hid.deviceTrackingState = "privacy";
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={hid}
      />
    );

    expect(screen.getByText("Lens closed")).toBeInTheDocument();
    expect(screen.getByText(/Privacy mode is on/)).toBeInTheDocument();
  });

  it("shows recording progress and disables preview while recording", () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture({
          previewEnabled: false,
          streamUrl: null,
          status: {
            recording: true,
            device_name: "video0",
            path: "/recordings/take.mkv",
            started_at: startedAt,
            reason: null
          }
        })}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("Recording in progress")).toBeInTheDocument();
    expect(screen.getByText(/Recording 01:0[4-6]/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show stream" })).toBeDisabled();
    expect(screen.getByText(/Recording owns the camera/)).toBeInTheDocument();
  });

  it("does not send focus commands while another HID command is pending", async () => {
    const setFocusMeteringMode = vi.fn().mockResolvedValue(undefined);
    const hid = pixyHid(setFocusMeteringMode);
    hid.pendingCommand = "tracking:privacy";
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={hid}
      />
    );
    const frame = screen.getByAltText("Live camera stream").parentElement!;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
      top: 0,
      left: 0,
      right: 1280,
      bottom: 720,
      toJSON: () => ({})
    });

    fireEvent.pointerUp(frame, { clientX: 640, clientY: 360 });

    await Promise.resolve();
    expect(setFocusMeteringMode).not.toHaveBeenCalled();
  });

  it("offers a reset to center focus while region focus is active", async () => {
    const setFocusMeteringMode = vi.fn().mockResolvedValue(undefined);
    const hid = pixyHid(setFocusMeteringMode);
    hid.focusMeteringMode = "selected_area";
    hid.focusMeteringPoint = { x: 64, y: 64 };
    render(
      <VideoMonitor
        deviceName="video0"
        videoFormats={videoFormats()}
        videoCapture={videoCapture()}
        pixyHid={hid}
      />
    );

    expect(screen.getByText("Region focus")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Center" }));

    await waitFor(() => expect(setFocusMeteringMode).toHaveBeenCalledWith("center"));
  });
});
