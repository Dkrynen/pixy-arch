import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchControls, setControlValue } from "../lib/apiClient";
import type { V4L2Control } from "../types/api";
import { useControls } from "./useControls";

vi.mock("../lib/apiClient", () => ({
  fetchControls: vi.fn(),
  setControlValue: vi.fn()
}));

const mockedFetchControls = vi.mocked(fetchControls);
const mockedSetControlValue = vi.mocked(setControlValue);

function control(overrides: Partial<V4L2Control>): V4L2Control {
  return {
    name: "brightness",
    label: "Brightness",
    control_id: "0x1",
    group: "User Controls",
    kind: "int",
    value: 0,
    default: 0,
    min: 0,
    max: 255,
    step: 1,
    value_label: null,
    flags: [],
    menu: [],
    ...overrides
  };
}

describe("useControls", () => {
  beforeEach(() => {
    mockedFetchControls.mockReset();
    mockedSetControlValue.mockReset();
  });

  it("ignores a late control list for a device that is no longer selected", async () => {
    let resolveA!: (controls: V4L2Control[]) => void;
    mockedFetchControls.mockImplementation((deviceName: string) =>
      deviceName === "video0"
        ? new Promise<V4L2Control[]>((resolve) => {
            resolveA = resolve;
          })
        : Promise.resolve([control({ name: "zoom_absolute", label: "Zoom" })])
    );

    const { result, rerender } = renderHook(({ device }) => useControls(device), {
      initialProps: { device: "video0" as string | null }
    });
    rerender({ device: "video2" });
    await waitFor(() => expect(result.current.controls.map((item) => item.name)).toEqual(["zoom_absolute"]));

    await act(async () => {
      resolveA([control({ name: "brightness" })]);
    });

    expect(result.current.controls.map((item) => item.name)).toEqual(["zoom_absolute"]);
    expect(result.current.isLoading).toBe(false);
  });

  it("does not apply a control write reply after the device changed", async () => {
    mockedFetchControls.mockImplementation(async (deviceName: string) =>
      deviceName === "video0" ? [control({ name: "brightness", value: 10 })] : [control({ name: "brightness", value: 99 })]
    );
    let finishWrite!: (value: V4L2Control) => void;
    mockedSetControlValue.mockImplementation(
      () =>
        new Promise<V4L2Control>((resolve) => {
          finishWrite = resolve;
        })
    );

    const { result, rerender } = renderHook(({ device }) => useControls(device), {
      initialProps: { device: "video0" as string | null }
    });
    await waitFor(() => expect(result.current.controls[0]?.value).toBe(10));

    let write!: Promise<void>;
    act(() => {
      write = result.current.setValue("brightness", 20);
    });
    rerender({ device: "video2" });
    await waitFor(() => expect(result.current.controls[0]?.value).toBe(99));

    await act(async () => {
      finishWrite(control({ name: "brightness", value: 20 }));
      await write;
    });

    expect(result.current.controls[0]?.value).toBe(99);
    expect(result.current.pendingControl).toBeNull();
  });

  it("refreshes controls after changing an active-state parent control", async () => {
    const initialControls = [
      control({
        name: "auto_exposure",
        label: "Auto Exposure",
        kind: "menu",
        value: 3,
        value_label: "Aperture Priority Mode"
      }),
      control({
        name: "exposure_time_absolute",
        label: "Exposure",
        value: 300,
        flags: ["inactive"]
      })
    ];
    const refreshedControls = [
      control({
        name: "auto_exposure",
        label: "Auto Exposure",
        kind: "menu",
        value: 1,
        value_label: "Manual Mode"
      }),
      control({
        name: "exposure_time_absolute",
        label: "Exposure",
        value: 300,
        flags: []
      })
    ];

    mockedFetchControls.mockResolvedValueOnce(initialControls).mockResolvedValueOnce(refreshedControls);
    mockedSetControlValue.mockResolvedValue(refreshedControls[0]);

    const { result } = renderHook(() => useControls("video0"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setValue("auto_exposure", 1);
    });

    expect(mockedSetControlValue).toHaveBeenCalledWith("video0", "auto_exposure", 1);
    expect(mockedFetchControls).toHaveBeenCalledTimes(2);
    expect(result.current.controls.find((item) => item.name === "exposure_time_absolute")?.flags).toEqual([]);
  });

  it("refreshes after changing a compact menu control like power line frequency", async () => {
    const initialControls = [
      control({
        name: "power_line_frequency",
        label: "Power Line Frequency",
        kind: "menu",
        value: 2,
        value_label: "60 Hz",
        menu: [
          { value: 0, label: "Disabled" },
          { value: 1, label: "50 Hz" },
          { value: 2, label: "60 Hz" }
        ]
      })
    ];
    const refreshedControls = [
      control({
        name: "power_line_frequency",
        label: "Power Line Frequency",
        kind: "menu",
        value: 1,
        value_label: "50 Hz",
        menu: initialControls[0].menu
      })
    ];

    mockedFetchControls.mockResolvedValueOnce(initialControls).mockResolvedValueOnce(refreshedControls);
    mockedSetControlValue.mockResolvedValue(refreshedControls[0]);

    const { result } = renderHook(() => useControls("video0"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setValue("power_line_frequency", 1);
    });

    expect(mockedSetControlValue).toHaveBeenCalledWith("video0", "power_line_frequency", 1);
    expect(mockedFetchControls).toHaveBeenCalledTimes(2);
    expect(result.current.controls[0].value).toBe(1);
    expect(result.current.controls[0].value_label).toBe("50 Hz");
  });

  it("refreshes after writing a dependent control so the auto-mode parent stays truthful", async () => {
    const initialControls = [
      control({
        name: "auto_exposure",
        label: "Auto Exposure",
        kind: "menu",
        value: 3,
        value_label: "Aperture Priority Mode"
      }),
      control({
        name: "exposure_time_absolute",
        label: "Exposure",
        value: 300,
        flags: ["inactive"]
      })
    ];
    const refreshedControls = [
      control({
        name: "auto_exposure",
        label: "Auto Exposure",
        kind: "menu",
        value: 1,
        value_label: "Manual Mode"
      }),
      control({
        name: "exposure_time_absolute",
        label: "Exposure",
        value: 500,
        flags: []
      })
    ];

    mockedFetchControls.mockResolvedValueOnce(initialControls).mockResolvedValueOnce(refreshedControls);
    mockedSetControlValue.mockResolvedValue(refreshedControls[1]);

    const { result } = renderHook(() => useControls("video0"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setValue("exposure_time_absolute", 500);
    });

    expect(mockedSetControlValue).toHaveBeenCalledWith("video0", "exposure_time_absolute", 500);
    // The backend flips auto_exposure to Manual first, so the whole list must refresh.
    expect(mockedFetchControls).toHaveBeenCalledTimes(2);
    expect(result.current.controls.find((item) => item.name === "auto_exposure")?.value).toBe(1);
    expect(result.current.controls.find((item) => item.name === "exposure_time_absolute")?.flags).toEqual([]);
  });

  it("rolls back only the failed control when a write is rejected", async () => {
    const initialControls = [
      control({ name: "brightness", label: "Brightness", value: 10 }),
      control({ name: "contrast", label: "Contrast", value: 20 })
    ];

    mockedFetchControls.mockResolvedValue(initialControls);
    mockedSetControlValue.mockRejectedValue(new Error("brightness must be <= 255"));

    const { result } = renderHook(() => useControls("video0"));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.setValue("brightness", 300);
    });

    expect(result.current.error).toBe("brightness must be <= 255");
    expect(result.current.controls.find((item) => item.name === "brightness")?.value).toBe(10);
    expect(result.current.controls.find((item) => item.name === "contrast")?.value).toBe(20);
  });
});
