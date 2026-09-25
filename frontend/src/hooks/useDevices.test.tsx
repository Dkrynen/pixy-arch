import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDevices } from "../lib/apiClient";
import type { Device } from "../types/api";
import { SELECTED_DEVICE_STORAGE_KEY, useDevices } from "./useDevices";

vi.mock("../lib/apiClient", () => ({
  fetchDevices: vi.fn()
}));

const mockedFetchDevices = vi.mocked(fetchDevices);

function capture(path: string, name: string, driver = "uvcvideo"): Device {
  return { path, name, driver, bus_info: `usb-${path}`, is_capture: true };
}

describe("useDevices", () => {
  beforeEach(() => {
    mockedFetchDevices.mockReset();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("prefers the physical PIXY over a lower-numbered virtual camera", async () => {
    mockedFetchDevices.mockResolvedValue([
      capture("/dev/video0", "Pixy Arch Virtual", "v4l2 loopback"),
      capture("/dev/video1", "PixyPilot Virtual", "v4l2 loopback"),
      capture("/dev/video3", "Integrated Webcam"),
      capture("/dev/video12", "EMEET PIXY: EMEET PIXY")
    ]);

    const { result } = renderHook(() => useDevices());

    await waitFor(() => expect(result.current.selectedDeviceName).toBe("video12"));
  });

  it("falls back to the lowest-numbered non-virtual node, sorted numerically", async () => {
    mockedFetchDevices.mockResolvedValue([
      capture("/dev/video10", "USB Cam B"),
      capture("/dev/video2", "USB Cam A"),
      capture("/dev/video0", "Pixy Arch Virtual", "v4l2 loopback")
    ]);

    const { result } = renderHook(() => useDevices());

    await waitFor(() => expect(result.current.selectedDeviceName).toBe("video2"));
  });

  it("remembers an explicit choice and restores it on the next load", async () => {
    const devices = [capture("/dev/video0", "EMEET PIXY"), capture("/dev/video4", "USB Cam")];
    mockedFetchDevices.mockResolvedValue(devices);

    const first = renderHook(() => useDevices());
    await waitFor(() => expect(first.result.current.selectedDeviceName).toBe("video0"));
    act(() => {
      first.result.current.setSelectedDeviceName("video4");
    });
    expect(first.result.current.selectedDeviceName).toBe("video4");
    expect(JSON.parse(window.localStorage.getItem(SELECTED_DEVICE_STORAGE_KEY) ?? "{}")).toEqual({
      path: "/dev/video4",
      name: "USB Cam"
    });
    first.unmount();

    const second = renderHook(() => useDevices());
    await waitFor(() => expect(second.result.current.selectedDeviceName).toBe("video4"));
  });

  it("follows a remembered camera to its new node number after a replug", async () => {
    window.localStorage.setItem(SELECTED_DEVICE_STORAGE_KEY, JSON.stringify({ path: "/dev/video4", name: "USB Cam" }));
    mockedFetchDevices.mockResolvedValue([
      capture("/dev/video0", "EMEET PIXY"),
      capture("/dev/video4", "Pixy Arch Virtual", "v4l2 loopback"),
      capture("/dev/video6", "USB Cam")
    ]);

    const { result } = renderHook(() => useDevices());

    await waitFor(() => expect(result.current.selectedDeviceName).toBe("video6"));
  });

  it("still selects a default when localStorage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    mockedFetchDevices.mockResolvedValue([capture("/dev/video0", "EMEET PIXY"), capture("/dev/video2", "USB Cam")]);

    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.selectedDeviceName).toBe("video0"));

    act(() => {
      result.current.setSelectedDeviceName("video2");
    });
    expect(result.current.selectedDeviceName).toBe("video2");
  });

  it("filters metadata-only devices from the controllable device list", async () => {
    mockedFetchDevices.mockResolvedValue([
      {
        path: "/dev/video0",
        name: "EMEET PIXY",
        driver: "uvcvideo",
        bus_info: "usb-test",
        is_capture: true
      },
      {
        path: "/dev/video1",
        name: "EMEET PIXY",
        driver: "uvcvideo",
        bus_info: "usb-test",
        is_capture: false
      }
    ]);

    const { result } = renderHook(() => useDevices());

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    expect(result.current.devices).toHaveLength(1);
    expect(result.current.devices[0].path).toBe("/dev/video0");
    expect(result.current.selectedDeviceName).toBe("video0");
  });

  it("surfaces an error and an empty list when the backend is unreachable", async () => {
    // Simulates the app pointing at a dead port: fetch() rejects outright.
    mockedFetchDevices.mockRejectedValue(new Error("Failed to fetch"));

    const { result } = renderHook(() => useDevices());

    await waitFor(() => expect(result.current.isLoading).toBe(false), { timeout: 5000 });

    expect(result.current.error).toBe("Failed to fetch");
    expect(result.current.devices).toHaveLength(0);
    expect(result.current.selectedDeviceName).toBeNull();
    expect(result.current.selectedDevice).toBeNull();
  });

  it("falls back to the first capture device when the selection disappears", async () => {
    mockedFetchDevices.mockResolvedValue([
      {
        path: "/dev/video0",
        name: "EMEET PIXY",
        driver: "uvcvideo",
        bus_info: "usb-test",
        is_capture: true
      },
      {
        path: "/dev/video2",
        name: "Other Cam",
        driver: "uvcvideo",
        bus_info: "usb-test2",
        is_capture: true
      }
    ]);

    const { result } = renderHook(() => useDevices());
    await waitFor(() => expect(result.current.selectedDeviceName).toBe("video0"), { timeout: 5000 });

    // Simulate a hotplug remove: the previously selected node is gone.
    mockedFetchDevices.mockResolvedValue([
      {
        path: "/dev/video2",
        name: "Other Cam",
        driver: "uvcvideo",
        bus_info: "usb-test2",
        is_capture: true
      }
    ]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.selectedDeviceName).toBe("video2");
  });

  it("runs a trailing refresh when one is requested mid-flight", async () => {
    // Hotplug bursts fire refresh per udev event; the last event must not be
    // dropped just because a scan was already running.
    let resolveFirst: (devices: Awaited<ReturnType<typeof fetchDevices>>) => void = () => undefined;
    mockedFetchDevices
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValue([
        {
          path: "/dev/video0",
          name: "EMEET PIXY",
          driver: "uvcvideo",
          bus_info: "usb-test",
          is_capture: true
        }
      ]);

    const { result } = renderHook(() => useDevices());

    await act(async () => {
      const second = result.current.refresh();
      resolveFirst([]);
      await second;
    });

    await waitFor(() => expect(mockedFetchDevices).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(result.current.selectedDeviceName).toBe("video0");
  });

});
