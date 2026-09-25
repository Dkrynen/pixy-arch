import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseControlsResult } from "../../hooks/useControls";
import type { UseDevicesResult } from "../../hooks/useDevices";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import { fetchVideoRecordingStatus } from "../../lib/apiClient";
import type { Device } from "../../types/api";
import { DeviceRail } from "./DeviceRail";

vi.mock("../../lib/apiClient", () => ({
  fetchVideoRecordingStatus: vi.fn()
}));

const mockedRecordingStatus = vi.mocked(fetchVideoRecordingStatus);

const pixyDevice: Device = {
  path: "/dev/video0",
  name: "EMEET PIXY: EMEET PIXY",
  driver: "uvcvideo",
  bus_info: "usb-0000:c8:00.3-1",
  is_capture: true
};

const loopbackDevice: Device = {
  path: "/dev/video10",
  name: "PixyPilot Virtual",
  driver: "v4l2 loopback",
  bus_info: "platform:v4l2loopback-010",
  is_capture: true
};

describe("DeviceRail", () => {
  beforeEach(() => {
    mockedRecordingStatus.mockReset();
    mockedRecordingStatus.mockResolvedValue({
      recording: false,
      device_name: null,
      path: null,
      started_at: null,
      reason: null
    });
  });

  it("shows the selected device, a labelled picker, and driver info", async () => {
    render(
      <DeviceRail
        devices={devices({ list: [pixyDevice], selected: "video0" })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("EMEET PIXY")).toBeInTheDocument();
    expect(screen.getByText(/\/dev\/video0/)).toBeInTheDocument();

    const picker = screen.getByRole("combobox", { name: "Select video device" });
    expect(picker).toHaveDisplayValue("video0 · EMEET PIXY");
    expect(screen.getByText(/uvcvideo/)).toBeInTheDocument();
    expect(screen.getByText(/usb-0000:c8:00.3-1/)).toBeInTheDocument();
    await act(async () => undefined);
  });

  it("marks the Pixy Arch virtual camera by name, including the legacy label", async () => {
    render(
      <DeviceRail
        devices={devices({
          list: [
            pixyDevice,
            { ...loopbackDevice, path: "/dev/video11", name: "Pixy Arch Virtual", driver: null, bus_info: null },
            { ...loopbackDevice, path: "/dev/video12", name: "PixyPilot Virtual", driver: null, bus_info: null }
          ],
          selected: "video0"
        })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByRole("option", { name: /video11/ })).toHaveTextContent("video11 · Virtual");
    expect(screen.getByRole("option", { name: /video12/ })).toHaveTextContent("video12 · Virtual");
    await act(async () => undefined);
  });

  it("marks virtual loopback devices in the picker", async () => {
    render(
      <DeviceRail
        devices={devices({ list: [pixyDevice, loopbackDevice], selected: "video0" })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    const option = screen.getByRole("option", { name: /video10/ });
    expect(option).toHaveTextContent("Virtual");
    await act(async () => undefined);
  });

  it("shows a scanning state while the first device scan runs", async () => {
    render(
      <DeviceRail
        devices={devices({ list: [], selected: null, isLoading: true })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("Scanning devices…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Scanning/ })).toBeDisabled();
    await act(async () => undefined);
  });

  it("shows an empty state with a connect hint when no capture device exists", async () => {
    render(
      <DeviceRail
        devices={devices({ list: [], selected: null })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("No camera selected")).toBeInTheDocument();
    expect(screen.getByText(/Connect the PIXY/)).toBeInTheDocument();
    expect(screen.getByText("Awaiting PIXY")).toBeInTheDocument();
    await act(async () => undefined);
  });

  it("surfaces the backend-unreachable state", async () => {
    render(
      <DeviceRail
        devices={devices({ list: [], selected: null, error: "Failed to fetch" })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    expect(screen.getByText("Backend unreachable")).toBeInTheDocument();
    expect(screen.getByText("Failed to fetch")).toBeInTheDocument();
    await act(async () => undefined);
  });

  it("shows a REC badge while the selected device is recording", async () => {
    mockedRecordingStatus.mockResolvedValue({
      recording: true,
      device_name: "video0",
      path: "/recordings/pixypilot-video0-20260918-100000.mkv",
      started_at: "2026-09-18T10:00:00Z",
      reason: null
    });

    render(
      <DeviceRail
        devices={devices({ list: [pixyDevice], selected: "video0" })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    await waitFor(() => expect(screen.getByText("REC")).toBeInTheDocument());
  });

  it("hides the REC badge when a different device is recording", async () => {
    mockedRecordingStatus.mockResolvedValue({
      recording: true,
      device_name: "video2",
      path: "/recordings/x.mkv",
      started_at: "2026-09-18T10:00:00Z",
      reason: null
    });

    render(
      <DeviceRail
        devices={devices({ list: [pixyDevice], selected: "video0" })}
        controls={controls()}
        videoFormats={videoFormats()}
        pixyHid={pixyHid()}
      />
    );

    await waitFor(() => expect(mockedRecordingStatus).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByText("REC")).not.toBeInTheDocument();
  });

  it("wires the format picker to useVideoFormats", async () => {
    const formats = videoFormats();
    render(
      <DeviceRail
        devices={devices({ list: [pixyDevice], selected: "video0" })}
        controls={controls()}
        videoFormats={formats}
        pixyHid={pixyHid()}
      />
    );

    const picker = screen.getByRole("combobox", { name: "Select video format" });
    expect(picker).toHaveDisplayValue("MJPG 1280x720 30fps");

    fireEvent.change(picker, { target: { value: "MJPG:3840:2160:333333" } });
    expect(formats.setSelectedKey).toHaveBeenCalledWith("MJPG:3840:2160:333333");
    await act(async () => undefined);
  });
});

function devices({
  list,
  selected,
  isLoading = false,
  error = null
}: {
  list: Device[];
  selected: string | null;
  isLoading?: boolean;
  error?: string | null;
}): UseDevicesResult {
  return {
    devices: list,
    selectedDeviceName: selected,
    selectedDevice: list.find((device) => device.path === `/dev/${selected}`) ?? null,
    isLoading,
    error,
    setSelectedDeviceName: vi.fn(),
    refresh: vi.fn(async () => undefined)
  };
}

function controls(): UseControlsResult {
  return {
    controls: [
      {
        name: "pan_absolute",
        label: "Pan (Absolute)",
        control_id: "0x1",
        group: "Camera",
        kind: "int",
        value: 0,
        default: 0,
        min: -100,
        max: 100,
        step: 1,
        value_label: null,
        flags: [],
        menu: []
      }
    ],
    groups: [],
    isLoading: false,
    error: null,
    pendingControl: null,
    refresh: vi.fn(),
    setValue: vi.fn(),
    setValues: vi.fn()
  } as unknown as UseControlsResult;
}

function videoFormats(): UseVideoFormatsResult {
  return {
    formats: [
      {
        pixel_format: "MJPG",
        description: "Motion-JPEG",
        width: 3840,
        height: 2160,
        fps: 30,
        frame_interval_100ns: 333333,
        label: "MJPG 3840x2160 30fps"
      },
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

function pixyHid(): UsePixyHidResult {
  return {
    status: {
      available: true,
      path: "/dev/hidraw0",
      readable: true,
      writable: true,
      reason: null,
      known_controls: ["tracking"]
    }
  } as unknown as UsePixyHidResult;
}
