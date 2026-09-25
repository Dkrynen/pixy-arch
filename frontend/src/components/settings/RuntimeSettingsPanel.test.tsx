import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { AppSettings } from "../../types/api";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

function settings(host = "127.0.0.1"): AppSettings {
  return {
    safety: { start_in_privacy: true },
    server: { host, port: 8000, reload: false, url: `http://${host}:8000` },
    frontend: {
      dist_path: "/home/user/pixy-arch/frontend/dist",
      dev_server_host: "127.0.0.1",
      dev_server_port: 5173,
      single_port: true
    },
    storage: {
      presets_path: "/home/user/pixy-arch/config/presets.yaml",
      recordings_dir: "/home/user/pixy-arch/recordings"
    },
    hid: { path: null, report_gap_ms: 25 },
    virtualcam: { device: null, label: "Pixy Arch Virtual", autostart: true, on_demand: true, idle_grace_seconds: 8 },
    config: { path: "/home/user/pixy-arch/config/pixypilot.yaml" }
  };
}

function privacySafety(overrides: Partial<UsePrivacySafetyResult> = {}): UsePrivacySafetyResult {
  return {
    settings: settings(),
    settingsLoaded: true,
    startupPrivacyEnabled: true,
    startupPrivacyState: "enabled",
    privacyCommandState: "idle",
    settingsError: null,
    settingsPending: false,
    refreshSettings: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(settings()),
    enterPrivacy: vi.fn(),
    leavePrivacy: vi.fn(),
    ...overrides
  };
}

describe("RuntimeSettingsPanel", () => {
  it("edits the Vite dev server port through runtime settings", async () => {
    const user = userEvent.setup();
    const saveSettings = vi.fn().mockResolvedValue(settings());

    render(<RuntimeSettingsPanel privacySafety={privacySafety({ saveSettings })} />);

    await user.click(screen.getByRole("button", { name: "Edit Vite port" }));
    const input = screen.getByDisplayValue("5173");
    await user.clear(input);
    await user.type(input, "5174");
    await user.click(screen.getByRole("button", { name: "Save Vite port" }));

    expect(saveSettings).toHaveBeenCalledWith({ frontend: { dev_server: { port: 5174 } } });
    expect(await screen.findByText("Vite port saved")).toBeInTheDocument();
  });

  it("shows restart scope for bind and Vite settings", () => {
    render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);

    expect(screen.getAllByText("dev restart").length).toBeGreaterThan(0);
    expect(screen.getAllByText("restart").length).toBeGreaterThan(0);
    expect(screen.getAllByText("live").length).toBeGreaterThan(0);
  });

  it("groups rows under their section headers", () => {
    render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);

    expect(screen.getByText("Safety")).toBeInTheDocument();
    expect(screen.getByText("Backend")).toBeInTheDocument();
    expect(screen.getByText("Frontend")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("HID")).toBeInTheDocument();
  });

  it("keeps the row open and shows the error when saving fails", async () => {
    const user = userEvent.setup();
    const saveSettings = vi.fn().mockRejectedValue(new Error("disk full"));

    render(
      <RuntimeSettingsPanel
        privacySafety={privacySafety({ saveSettings, settingsError: "disk full" })}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit HID gap" }));
    const input = screen.getByDisplayValue("25");
    await user.clear(input);
    await user.type(input, "30");
    await user.click(screen.getByRole("button", { name: "Save HID gap" }));

    expect(saveSettings).toHaveBeenCalledWith({ hid: { report_gap_ms: 30 } });
    expect(screen.getByText("disk full")).toBeInTheDocument();
    expect(screen.queryByText(/saved/)).not.toBeInTheDocument();
    // Row stays in edit mode so the draft isn't lost.
    expect(screen.getByDisplayValue("30")).toBeInTheDocument();
  });

  it("shows YAML-only paths as display-only rows with a hint instead of an editor", () => {
    render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);

    expect(screen.getByText("/home/user/pixy-arch/frontend/dist")).toBeInTheDocument();
    expect(screen.getByText("/home/user/pixy-arch/config/presets.yaml")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit UI dist" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit Presets" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Edit config/pixypilot.yaml to change")).toHaveLength(2);
    // Recordings is still editable through the API.
    expect(screen.getByRole("button", { name: "Edit Recordings" })).toBeInTheDocument();
  });

  it("warns that a non-loopback bind host exposes the unauthenticated API", () => {
    render(<RuntimeSettingsPanel privacySafety={privacySafety({ settings: settings("0.0.0.0") })} />);

    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent("0.0.0.0");
    expect(warning).toHaveTextContent(/no authentication/);
    expect(warning).toHaveTextContent(/view the camera, record, move it, and unmute the mic/);
  });

  it("shows no exposure warning for loopback hosts", () => {
    const { unmount } = render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();

    render(<RuntimeSettingsPanel privacySafety={privacySafety({ settings: settings("localhost") })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("warns while a non-loopback host is being typed and rejects non-IP hosts", async () => {
    const user = userEvent.setup();
    render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);

    await user.click(screen.getByRole("button", { name: "Edit Bind host" }));
    const input = screen.getByRole("textbox", { name: "Bind host" });
    await user.clear(input);
    await user.type(input, "192.168.1.20");

    expect(screen.getByRole("alert")).toHaveTextContent("192.168.1.20");
    expect(screen.getByRole("button", { name: "Save Bind host" })).toBeEnabled();

    await user.clear(input);
    await user.type(input, "pixy.local");
    expect(screen.getByRole("button", { name: "Save Bind host" })).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("only accepts a /dev/hidrawN path or empty for the HID path", async () => {
    const user = userEvent.setup();
    render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);

    await user.click(screen.getByRole("button", { name: "Edit HID path" }));
    const input = screen.getByRole("textbox", { name: "HID path" });
    await user.type(input, "/dev/video0");
    expect(screen.getByRole("button", { name: "Save HID path" })).toBeDisabled();

    await user.clear(input);
    await user.type(input, "/dev/hidraw3");
    expect(screen.getByRole("button", { name: "Save HID path" })).toBeEnabled();

    await user.clear(input);
    expect(screen.getByRole("button", { name: "Save HID path" })).toBeEnabled();
  });

  it("names the select used to edit the startup setting", async () => {
    const user = userEvent.setup();
    render(<RuntimeSettingsPanel privacySafety={privacySafety()} />);

    await user.click(screen.getByRole("button", { name: "Edit Startup" }));
    expect(screen.getByRole("combobox", { name: "Startup" })).toHaveValue("true");
  });
});
