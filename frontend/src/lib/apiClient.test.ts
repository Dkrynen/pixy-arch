import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorDetailMessage,
  stopAudioMeterKeepalive,
  stopPixyPtzKeepalive,
  updateAutomationSettings,
  updateSettings
} from "./apiClient";

function jsonResponse(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" }
  });
}

describe("errorDetailMessage", () => {
  it("passes string details through", () => {
    expect(errorDetailMessage("HID device busy", "Bad Request")).toBe("HID device busy");
  });

  it("renders FastAPI validation errors as field: message", () => {
    expect(
      errorDetailMessage(
        [
          { loc: ["body", "server", "host"], msg: "Value error, must be an IP literal or localhost", type: "value_error" },
          { loc: ["body", "frontend", "dist"], msg: "Extra inputs are not permitted", type: "extra_forbidden" }
        ],
        "Unprocessable Entity"
      )
    ).toBe(
      "server.host: Value error, must be an IP literal or localhost; frontend.dist: Extra inputs are not permitted"
    );
  });

  it("falls back when the detail is missing or unusable", () => {
    expect(errorDetailMessage(undefined, "Internal Server Error")).toBe("Internal Server Error");
    expect(errorDetailMessage([{ loc: ["body"] }], "Unprocessable Entity")).toBe("Unprocessable Entity");
  });
});

describe("apiClient requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces a readable message for a 422 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(422, { detail: [{ loc: ["body", "hid", "path"], msg: "must be /dev/hidrawN or empty" }] }, "Unprocessable Entity")
    );

    await expect(updateSettings({ hid: { path: "/dev/video0" } })).rejects.toThrow(
      "hid.path: must be /dev/hidrawN or empty"
    );
  });

  it("PATCHes automation with only the changed fields", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, {}));

    await updateAutomationSettings({ enabled: false });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/automation/settings",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) })
    );
  });

  it("sends safety stops as keepalive requests that never throw", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    expect(() => stopPixyPtzKeepalive()).not.toThrow();
    expect(() => stopAudioMeterKeepalive()).not.toThrow();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/pixy-hid/ptz-vector",
      expect.objectContaining({ method: "PATCH", keepalive: true, body: JSON.stringify({ x: 0, y: 0, z: 0 }) })
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/audio/meter/stop",
      expect.objectContaining({ method: "POST", keepalive: true })
    );
  });
});
