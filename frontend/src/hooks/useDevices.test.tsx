import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchDevices } from "../lib/apiClient";
import { useDevices } from "./useDevices";

vi.mock("../lib/apiClient", () => ({
  fetchDevices: vi.fn()
}));

const mockedFetchDevices = vi.mocked(fetchDevices);

describe("useDevices", () => {
  beforeEach(() => {
    mockedFetchDevices.mockReset();
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
