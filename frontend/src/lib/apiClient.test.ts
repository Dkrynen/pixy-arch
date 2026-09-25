import { afterEach, describe, expect, it, vi } from "vitest";

import {
  errorDetailMessage,
  fetchStreamError,
  stopAudioMeterKeepalive,
  stopPixyPtzKeepalive,
  updateAutomationSettings,
  updateSettings,
  uploadPcapImport
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

  it("surfaces the backend reason when automation settings cannot be saved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(500, { detail: "automation settings could not be saved: read-only file system" })
    );

    await expect(
      updateAutomationSettings({
        enabled: false,
        video_device: "auto",
        on_open: "tracking",
        on_close: "privacy",
        grace_seconds: 8,
        poll_seconds: 1,
        exclude_processes: ["pipewire", "wireplumber"],
        unmute_mic: true
      })
    ).rejects.toThrow("automation settings could not be saved: read-only file system");
  });

  it("reads the reason for a failed stream and aborts a stream that works", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(503, { detail: "camera stream could not be started: device busy" }))
      .mockResolvedValueOnce(new Response("frames", { status: 200 }));

    await expect(fetchStreamError("/api/devices/video0/stream?width=1920")).resolves.toBe(
      "camera stream could not be started: device busy"
    );
    await expect(fetchStreamError("/api/devices/video0/stream?width=1920")).resolves.toBeNull();
    const signal = (fetchSpy.mock.calls[1][1] as RequestInit).signal;
    expect(signal?.aborted).toBe(true);
  });

  it("shows a readable message for an oversized PCAP upload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(413, { detail: "capture exceeds the 512 MB upload limit" }, "Payload Too Large")
    );
    const file = new File(["x"], "big.pcapng");

    await expect(uploadPcapImport(file)).rejects.toThrow("capture exceeds the 512 MB upload limit");
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
