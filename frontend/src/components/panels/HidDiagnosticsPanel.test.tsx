import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { capturePixyHidDiagnostics, fetchPixyHidQuery } from "../../lib/apiClient";
import type { PixyHidDiagnosticSnapshot } from "../../types/api";
import { HidDiagnosticsPanel, hidSnapshotFileName } from "./HidDiagnosticsPanel";

vi.mock("../../lib/apiClient", () => ({
  capturePixyHidDiagnostics: vi.fn(),
  fetchPixyHidQuery: vi.fn()
}));

const captureMock = vi.mocked(capturePixyHidDiagnostics);
const queryMock = vi.mocked(fetchPixyHidQuery);

function snapshot(filePath: string | null = null): PixyHidDiagnosticSnapshot {
  return {
    captured_at: "2026-06-10T12:00:00+00:00",
    path: "/dev/hidraw14",
    file_path: filePath,
    queries: [
      {
        name: "tracking_state",
        request_hex: "09 01 01 01",
        response_hex: "09 01 01 01 00 01 00 01 03",
        value_index: 8,
        raw_value: 3,
        raw_bits: [0, 1],
        ascii_value: null,
        ascii_preview: "........",
        path: "/dev/hidraw14"
      }
    ]
  };
}

describe("HidDiagnosticsPanel", () => {
  it("names downloaded snapshots with the Pixy Arch prefix", () => {
    expect(hidSnapshotFileName("2026-06-10T12:00:00+00:00")).toBe("pixy-arch-hid-2026-06-10T1200000000.json");
    expect(hidSnapshotFileName(undefined)).toBe("pixy-arch-hid-snapshot.json");
  });

  beforeEach(() => {
    captureMock.mockReset();
    queryMock.mockReset();
  });

  it("captures and displays raw HID bit data", async () => {
    const user = userEvent.setup();
    captureMock.mockResolvedValue(snapshot());

    render(<HidDiagnosticsPanel />);

    await user.click(screen.getByRole("button", { name: /capture/i }));

    expect(captureMock).toHaveBeenCalledWith(false);
    const queryList = await screen.findByText("bits 0,1");
    expect(within(queryList.closest(".diagnostic-query-list") as HTMLElement).getByText("tracking state")).toBeInTheDocument();
    expect(screen.getByText("0x03")).toBeInTheDocument();
    expect(screen.getByText(/ASCII/)).toHaveTextContent("ASCII ........");
  });

  it("saves a diagnostic snapshot through the backend", async () => {
    const user = userEvent.setup();
    captureMock.mockResolvedValue(snapshot("/home/user/pixy-arch/diagnostics/hid/pixy-arch-hid-test.json"));

    render(<HidDiagnosticsPanel />);

    await user.click(screen.getByRole("button", { name: /^save$/i }));

    expect(captureMock).toHaveBeenCalledWith(true);
    expect(await screen.findByText(/diagnostics\/hid\/pixy-arch-hid-test\.json/)).toBeInTheDocument();
  });

  it("runs a single HID query through the explorer and decodes it", async () => {
    const user = userEvent.setup();
    queryMock.mockResolvedValue({
      name: "tracking_state",
      request_hex: "09 01 01 01",
      response_hex: "09 01 01 01 00 01 00 01 02",
      value_index: 8,
      raw_value: 2,
      raw_bits: [1],
      ascii_value: null,
      ascii_preview: null,
      path: "/dev/hidraw14"
    });

    render(<HidDiagnosticsPanel />);

    await user.click(screen.getByRole("button", { name: /run/i }));

    expect(queryMock).toHaveBeenCalledWith("tracking_state");
    expect(await screen.findByText("Privacy")).toBeInTheDocument();
    expect(screen.getByText("0x02")).toBeInTheDocument();
  });

  it("runs the explorer query selected in the dropdown", async () => {
    const user = userEvent.setup();
    queryMock.mockResolvedValue({
      name: "audio_state",
      request_hex: "09 05 00 04",
      response_hex: "09 05 00 04 00 01 00 01 02",
      value_index: 8,
      raw_value: 2,
      raw_bits: [1],
      ascii_value: null,
      ascii_preview: null,
      path: "/dev/hidraw14"
    });

    render(<HidDiagnosticsPanel />);

    await user.selectOptions(screen.getByRole("combobox", { name: "HID query" }), "audio_state");
    await user.click(screen.getByRole("button", { name: /run/i }));

    expect(queryMock).toHaveBeenCalledWith("audio_state");
    expect(await screen.findByText("Live")).toBeInTheDocument();
  });

  it("reports when the device gives no response to a query", async () => {
    const user = userEvent.setup();
    queryMock.mockResolvedValue({
      name: "denoise_state",
      request_hex: "09 45 00 01",
      response_hex: null,
      value_index: 8,
      raw_value: null,
      raw_bits: [],
      ascii_value: null,
      ascii_preview: null,
      path: "/dev/hidraw14"
    });

    render(<HidDiagnosticsPanel />);

    await user.selectOptions(screen.getByRole("combobox", { name: "HID query" }), "denoise_state");
    await user.click(screen.getByRole("button", { name: /run/i }));

    expect(await screen.findByText(/no response from device/)).toBeInTheDocument();
    expect(screen.getByText("no response")).toBeInTheDocument();
  });
});
