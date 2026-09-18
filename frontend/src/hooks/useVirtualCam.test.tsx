import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchVirtualCamStatus, startVirtualCam, stopVirtualCam } from "../lib/apiClient";
import type { VirtualCamRuntimeStatus } from "./useVirtualCam";
import { useVirtualCam } from "./useVirtualCam";

vi.mock("../lib/apiClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/apiClient")>("../lib/apiClient");
  return {
    ...actual,
    fetchVirtualCamStatus: vi.fn(),
    startVirtualCam: vi.fn(),
    stopVirtualCam: vi.fn()
  };
});

const mockedFetchStatus = vi.mocked(fetchVirtualCamStatus);
const mockedStart = vi.mocked(startVirtualCam);
const mockedStop = vi.mocked(stopVirtualCam);

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
    transform: { mirror: false, rotate: 0, zoom: 1 },
    reason: null,
    last_error: null,
    ...overrides
  };
}

describe("useVirtualCam", () => {
  beforeEach(() => {
    mockedFetchStatus.mockReset();
    mockedStart.mockReset();
    mockedStop.mockReset();
    mockedFetchStatus.mockResolvedValue(status());
    mockedStart.mockResolvedValue({ ok: true, running: true, pid: 1, sink_path: "/dev/video10", reason: null });
    mockedStop.mockResolvedValue({ ok: true, running: false, pid: null, sink_path: "/dev/video10", reason: null });
  });

  it("loads the current status on mount", async () => {
    const { result } = renderHook(() => useVirtualCam());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockedFetchStatus).toHaveBeenCalledTimes(1);
    expect(result.current.status?.sink_path).toBe("/dev/video10");
    expect(result.current.status?.consumers).toBe(0);
  });

  it("surfaces fetch failures as errors", async () => {
    mockedFetchStatus.mockRejectedValue(new Error("backend down"));

    const { result } = renderHook(() => useVirtualCam());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe("backend down");
  });

  it("starts the pipeline with the given request and refreshes", async () => {
    const { result } = renderHook(() => useVirtualCam());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    mockedFetchStatus.mockResolvedValue(
      status({ running: true, pid: 42, source_device: "/dev/video0", output_width: 1920, output_height: 1080, output_pixel_format: "YUYV", fps: 30 })
    );

    await act(async () => {
      await result.current.start({ pipeline: "transform", input_format: "mjpeg", input_width: 1920, input_height: 1080 });
    });

    expect(mockedStart).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: "transform", input_format: "mjpeg" })
    );
    expect(result.current.status?.running).toBe(true);
    expect(result.current.status?.output_pixel_format).toBe("YUYV");
    expect(result.current.error).toBeNull();
  });

  it("reports start failures and pulls last_error from status", async () => {
    mockedStart.mockRejectedValue(new Error("ffmpeg exited immediately: Device or resource busy"));
    mockedFetchStatus.mockResolvedValue(
      status({ last_error: "ffmpeg exited immediately: Device or resource busy" })
    );

    const { result } = renderHook(() => useVirtualCam());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.start({ pipeline: "transform" });
    });

    expect(result.current.error).toContain("Device or resource busy");
    expect(result.current.status?.last_error).toContain("Device or resource busy");
    expect(result.current.pending).toBe(false);
  });

  it("stops the pipeline and refreshes status", async () => {
    mockedFetchStatus.mockResolvedValue(status({ running: true, pid: 7 }));
    const { result } = renderHook(() => useVirtualCam());
    await waitFor(() => expect(result.current.status?.running).toBe(true));

    mockedFetchStatus.mockResolvedValue(status({ running: false }));
    await act(async () => {
      await result.current.stop();
    });

    expect(mockedStop).toHaveBeenCalledTimes(1);
    expect(result.current.status?.running).toBe(false);
  });

  it("polls status while the pipeline is running", async () => {
    vi.useFakeTimers();
    try {
      mockedFetchStatus.mockResolvedValue(status({ running: true, consumers: 1 }));
      const { result } = renderHook(() => useVirtualCam());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.status?.running).toBe(true);
      mockedFetchStatus.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(mockedFetchStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(mockedFetchStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps polling while stopped so external starts are adopted", async () => {
    // A pipeline started by another client (or the autostart task) must show
    // up without a reload — the poll runs unconditionally.
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useVirtualCam());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.status?.running).toBe(false);
      mockedFetchStatus.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(mockedFetchStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
