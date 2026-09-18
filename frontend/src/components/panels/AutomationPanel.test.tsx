import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AutomationStatus, UseAutomationResult } from "../../hooks/useAutomation";
import { AutomationPanel } from "./AutomationPanel";

function status(overrides: Partial<AutomationStatus> = {}): AutomationStatus {
  return {
    running: true,
    camera_in_use: false,
    holders: [],
    saved_mode: null,
    last_action: null,
    mic_unmuted: false,
    settings: {
      enabled: true,
      video_device: "/dev/video0",
      on_open: "tracking",
      on_close: "privacy",
      grace_seconds: 8,
      poll_seconds: 1,
      exclude_processes: [],
      unmute_mic: true
    },
    ...overrides
  };
}

function automation(overrides: Partial<UseAutomationResult> = {}): UseAutomationResult {
  return {
    status: status(),
    isLoading: false,
    pending: false,
    error: null,
    refresh: vi.fn(),
    applySettings: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("AutomationPanel", () => {
  it("shows the watching state and the device being watched", () => {
    render(<AutomationPanel automation={automation()} />);

    expect(screen.getByText("Watching for calls")).toBeInTheDocument();
    expect(screen.getByText(/Watching \/dev\/video0/)).toBeInTheDocument();
  });

  it("shows the in-call state with holders and automation mic state", () => {
    render(
      <AutomationPanel
        automation={automation({
          status: status({
            camera_in_use: true,
            holders: ["firefox"],
            mic_unmuted: true,
            last_action: "call-start:tracking+unmute"
          })
        })}
      />
    );

    expect(screen.getByText("Call in progress")).toBeInTheDocument();
    expect(screen.getByText(/Held by firefox/)).toBeInTheDocument();
    expect(screen.getByText(/Mic unmuted by automation/)).toBeInTheDocument();
  });

  it("toggles automation and the mic unmute behaviour", async () => {
    const user = userEvent.setup();
    const applySettings = vi.fn().mockResolvedValue(undefined);

    render(<AutomationPanel automation={automation({ applySettings })} />);

    await user.click(screen.getByRole("button", { name: "Call automation" }));
    expect(applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, unmute_mic: true })
    );

    await user.click(screen.getByRole("button", { name: "Unmute mic during calls" }));
    expect(applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, unmute_mic: false })
    );
  });

  it("switches call-end behaviour and explains what it does", async () => {
    const user = userEvent.setup();
    const applySettings = vi.fn().mockResolvedValue(undefined);

    render(<AutomationPanel automation={automation({ applySettings })} />);
    expect(screen.getByText(/Parks the lens in privacy mode/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({ on_close: "previous" }));
  });

  it("explains that PipeWire and the preview never count as a call", () => {
    render(<AutomationPanel automation={automation()} />);
    expect(screen.getByText(/never count as a call/)).toBeInTheDocument();
  });

  it("renders a stopped state when the watcher is off", () => {
    render(<AutomationPanel automation={automation({ status: status({ running: false }) })} />);
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });
});
