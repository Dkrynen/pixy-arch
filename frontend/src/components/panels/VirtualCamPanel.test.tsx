import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVirtualCamResult, VirtualCamRuntimeStatus } from "../../hooks/useVirtualCam";
import type { VideoFormatOption } from "../../types/api";
import { VirtualCamPanel } from "./VirtualCamPanel";

const mjpg1080: VideoFormatOption = {
  pixel_format: "MJPG",
  description: "Motion-JPEG",
  width: 1920,
  height: 1080,
  fps: 30,
  frame_interval_100ns: 333333,
  label: "MJPG 1920x1080 30fps"
};

const mjpg720: VideoFormatOption = {
  pixel_format: "MJPG",
  description: "Motion-JPEG",
  width: 1280,
  height: 720,
  fps: 60,
  frame_interval_100ns: 166666,
  label: "MJPG 1280x720 60fps"
};

const yuyv480: VideoFormatOption = {
  pixel_format: "YUYV",
  description: "YUYV 4:2:2",
  width: 640,
  height: 480,
  fps: 30,
  frame_interval_100ns: 333333,
  label: "YUYV 640x480 30fps"
};

function status(overrides: Partial<VirtualCamRuntimeStatus> = {}): VirtualCamRuntimeStatus {
  return {
    available: true,
    sink_path: "/dev/video10",
    running: false,
    pid: null,
    pipeline: "transform",
    source_device: null,
    output_width: null,
    output_height: null,
    output_pixel_format: null,
    fps: null,
    frames: null,
    consumers: 0,
    mode: "off",
    armed: false,
    transform: { mirror: false, rotate: 0, zoom: 1 },
    reason: null,
    last_error: null,
    ...overrides
  };
}

function virtualCam(overrides: Partial<UseVirtualCamResult> = {}): UseVirtualCamResult {
  return {
    status: status(),
    isLoading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    ...overrides
  };
}

function videoFormats(formats: VideoFormatOption[] = [mjpg1080, mjpg720, yuyv480]): UseVideoFormatsResult {
  return {
    formats,
    selectedFormat: mjpg1080,
    selectedKey: "MJPG:1920:1080:333333",
    isLoading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    setSelectedKey: vi.fn()
  };
}


function privacySafety(overrides: Partial<UsePrivacySafetyResult> = {}): UsePrivacySafetyResult {
  return {
    settings: null,
    settingsLoaded: true,
    startupPrivacyEnabled: true,
    startupPrivacyState: "enabled",
    privacyCommandState: "idle",
    settingsError: null,
    settingsPending: false,
    refreshSettings: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    enterPrivacy: vi.fn(),
    leavePrivacy: vi.fn(),
    ...overrides
  };
}

describe("VirtualCamPanel", () => {
  it("shows ready state with the sink path when idle", () => {
    render(<VirtualCamPanel virtualCam={virtualCam()} videoFormats={videoFormats()} privacySafety={privacySafety()} />);

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("/dev/video10")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start virtual camera" })).toBeEnabled();
  });

  it("disables start when no loopback device is available", () => {
    render(
      <VirtualCamPanel
        virtualCam={virtualCam({
          status: status({ available: false, sink_path: null, reason: "no v4l2loopback device found" })
        })}
        videoFormats={videoFormats()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText("No loopback device")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start virtual camera" })).toBeDisabled();
  });

  it("starts with the selected camera format including its pixel format", () => {
    const cam = virtualCam();
    render(<VirtualCamPanel virtualCam={cam} videoFormats={videoFormats()} privacySafety={privacySafety()} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Start virtual camera" }));

    expect(cam.start).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: "transform",
        input_width: 640,
        input_height: 480,
        input_fps: 30,
        input_format: "yuyv422",
        output_width: 640,
        output_height: 480
      })
    );
  });

  it("labels the quality options with resolution, fps and encoding", () => {
    render(<VirtualCamPanel virtualCam={virtualCam()} videoFormats={videoFormats()} privacySafety={privacySafety()} />);

    expect(screen.getByText("Camera format")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1920×1080 · 30 fps · MJPG" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1280×720 · 60 fps · MJPG" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "640×480 · 30 fps · YUYV" })).toBeInTheDocument();
  });

  it("shows runtime details while streaming", () => {
    render(
      <VirtualCamPanel
        virtualCam={virtualCam({
          status: status({
            running: true,
            pid: 321,
            source_device: "/dev/video0",
            output_width: 1920,
            output_height: 1080,
            output_pixel_format: "YUYV",
            fps: 30,
            consumers: 2
          })
        })}
        videoFormats={videoFormats()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText("Streaming (transform)")).toBeInTheDocument();
    expect(screen.getByText("/dev/video0 → /dev/video10")).toBeInTheDocument();
    expect(screen.getByText(/1920×1080 · YUYV · 30 fps · 2 consumers/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop virtual camera" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeDisabled();
  });

  it("surfaces the last pipeline error when idle", () => {
    render(
      <VirtualCamPanel
        virtualCam={virtualCam({
          status: status({ last_error: "ffmpeg exited (code 1): Device or resource busy" })
        })}
        videoFormats={videoFormats()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText(/Last run ended:/)).toBeInTheDocument();
    expect(screen.getByText(/Device or resource busy/)).toBeInTheDocument();
  });

  it("shows inline errors from the hook", () => {
    render(
      <VirtualCamPanel
        virtualCam={virtualCam({ error: "ffmpeg is not installed or not on PATH" })}
        videoFormats={videoFormats()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText("ffmpeg is not installed or not on PATH")).toBeInTheDocument();
  });

  it("hides transform controls in whiteboard mode", () => {
    render(<VirtualCamPanel virtualCam={virtualCam()} videoFormats={videoFormats()} privacySafety={privacySafety()} />);

    expect(screen.getByText("Mirror")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Whiteboard" }));
    expect(screen.queryByText("Mirror")).not.toBeInTheDocument();
    expect(screen.queryByText("Rotate")).not.toBeInTheDocument();
  });

  it("shows standby state while armed on demand", () => {
    render(
      <VirtualCamPanel
        virtualCam={virtualCam({
          status: status({ mode: "standby", armed: true, output_width: 1920, output_height: 1080, fps: 30 })
        })}
        videoFormats={videoFormats()}
        privacySafety={privacySafety()}
      />
    );

    expect(screen.getByText("Standby")).toBeInTheDocument();
    expect(screen.getByText(/camera off until an app connects/)).toBeInTheDocument();
    expect(screen.getByText(/stays listed in OBS/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start virtual camera" })).toBeEnabled();
  });

  it("saves the on-demand setting from the toggle", () => {
    const safety = privacySafety({
      settings: {
        virtualcam: {
          device: null,
          label: "PixyPilot Virtual",
          autostart: true,
          on_demand: true,
          idle_grace_seconds: 8
        }
      } as never
    });
    render(<VirtualCamPanel virtualCam={virtualCam()} videoFormats={videoFormats()} privacySafety={safety} />);

    fireEvent.click(screen.getByRole("button", { name: "Run the camera only while an app uses it" }));

    expect(safety.saveSettings).toHaveBeenCalledWith({ virtualcam: { on_demand: false } });
  });
});
