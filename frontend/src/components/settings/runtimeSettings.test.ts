import { describe, expect, it } from "vitest";

import type { AppSettings } from "../../types/api";
import { isLoopbackHost, isValidBindHost, runtimeSettings } from "./runtimeSettings";

function settings(): AppSettings {
  return {
    safety: { start_in_privacy: true },
    server: { host: "127.0.0.1", port: 8000, reload: false, url: "http://127.0.0.1:8000" },
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

describe("runtimeSettings", () => {
  it("never builds a PATCH for the YAML-only dist and presets paths", () => {
    const rows = runtimeSettings(settings());
    const dist = rows.find((row) => row.id === "frontend-dist");
    const presets = rows.find((row) => row.id === "presets");

    expect(dist?.apply).toBeUndefined();
    expect(presets?.apply).toBeUndefined();
    expect(dist?.readOnlyHint).toMatch(/config\/pixypilot\.yaml/);
    expect(rows.find((row) => row.id === "recordings")?.apply?.("/tmp/rec")).toEqual({
      storage: { recordings: "/tmp/rec" }
    });
  });

  it.each([
    ["127.0.0.1", true],
    ["127.0.1.1", true],
    ["localhost", true],
    ["LOCALHOST", true],
    ["::1", true],
    ["0.0.0.0", false],
    ["::", false],
    ["192.168.1.20", false],
    ["fe80::1", false]
  ])("classifies %s as loopback=%s", (host, loopback) => {
    expect(isLoopbackHost(host)).toBe(loopback);
  });

  it.each([
    ["127.0.0.1", true],
    ["0.0.0.0", true],
    ["localhost", true],
    ["::", true],
    ["fe80::1%eth0", true],
    ["256.1.1.1", false],
    ["pixy.local", false],
    ["", false]
  ])("validates bind host %s as %s", (host, valid) => {
    expect(isValidBindHost(host)).toBe(valid);
  });
});
