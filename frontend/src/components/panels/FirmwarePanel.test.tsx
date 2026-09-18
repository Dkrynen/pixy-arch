import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { UseFirmwareResult } from "../../hooks/useFirmware";
import type { FirmwareStatus } from "../../types/api";
import { FirmwarePanel } from "./FirmwarePanel";

function status(overrides: Partial<FirmwareStatus> = {}): FirmwareStatus {
  return {
    components: [
      {
        name: "isp",
        current: "0x04",
        latest: null,
        update_available: null,
        request_hex: "09 01 00 04",
        response_hex: "09 01 00 04 00 02 00 02 04 20"
      },
      {
        name: "mcu",
        current: "0x07",
        latest: "2.0.9",
        update_available: true,
        request_hex: "09 61 00 04",
        response_hex: "09 61 00 04 00 02 00 02 07 20"
      }
    ],
    manifest_url: "https://example.com/manifest.json",
    manifest_checked: false,
    serial_number: "260318603028",
    reason: null,
    ...overrides
  };
}

function firmware(overrides: Partial<UseFirmwareResult> = {}): UseFirmwareResult {
  return {
    status: status(),
    isLoading: false,
    checking: false,
    error: null,
    refresh: vi.fn(),
    checkUpdates: vi.fn(),
    ...overrides
  };
}

describe("FirmwarePanel", () => {
  it("shows labeled components, serial and raw-value honesty note", () => {
    render(<FirmwarePanel firmware={firmware()} />);

    expect(screen.getByText("ISP (FIC7608)")).toBeInTheDocument();
    expect(screen.getByText("Motor MCU (CW32)")).toBeInTheDocument();
    expect(screen.getByText("Serial")).toBeInTheDocument();
    expect(screen.getByText("260318603028")).toBeInTheDocument();
    expect(screen.getByText(/raw bytes from the camera/)).toBeInTheDocument();
    expect(screen.getByText(/2\.0\.9/)).toBeInTheDocument();
    expect(screen.getByText(/update available/)).toBeInTheDocument();
  });

  it("marks components without a manifest entry after a check", () => {
    render(<FirmwarePanel firmware={firmware({ status: status({ manifest_checked: true }) })} />);

    expect(screen.getByText(/no manifest entry/)).toBeInTheDocument();
    expect(screen.getByText(/Checked https:\/\/example\.com\/manifest\.json/)).toBeInTheDocument();
  });

  it("surfaces a failed update check without claiming up to date", () => {
    render(
      <FirmwarePanel
        firmware={firmware({ status: status({ reason: "update manifest could not be fetched" }) })}
      />
    );

    expect(screen.getByText("update manifest could not be fetched")).toBeInTheDocument();
    expect(screen.queryByText(/up to date/)).not.toBeInTheDocument();
  });

  it("triggers the update check from the button", async () => {
    const user = userEvent.setup();
    const result = firmware();

    render(<FirmwarePanel firmware={result} />);
    await user.click(screen.getByRole("button", { name: /check for updates/i }));

    expect(result.checkUpdates).toHaveBeenCalledOnce();
  });
});
