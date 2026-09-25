import type {
  AudioCommandResult,
  AudioMonitorResult,
  AudioStatus,
  AudioMode,
  AppSettings,
  AppSettingsUpdate,
  AutomationSettings,
  AutomationStatus,
  ControlPreset,
  ControlPresetCreateRequest,
  ControlPresetDeleteResult,
  Device,
  FirmwareStatus,
  FocusMeteringPoint,
  FocusMeteringMode,
  MirrorMode,
  PcapImportRecord,
  PixyHidCommandResult,
  PixyHidDeviceState,
  PixyHidDiagnosticSnapshot,
  PixyHidQueryName,
  PixyHidRawQueryResult,
  PixyHidStatus,
  PtzDirection,
  PtzPresetSlot,
  PtzVector,
  TargetTrackingMode,
  TrackingMode,
  UvcExtensionSelectorProbe,
  UvcExtensionSnapshot,
  V4L2Control,
  VideoFormatOption,
  VideoRecordingStatus,
  VideoStreamStopResult,
  VirtualCamActionResult,
  VirtualCamStartRequest,
  VirtualCamStatus
} from "../types/api";

const API_BASE = "";

/**
 * Turns a FastAPI error `detail` into a readable message. Plain HTTP errors
 * carry a string; request validation (422) carries a list of `{loc, msg}`
 * entries, rendered as `server.host: <msg>` joined by "; ".
 */
export function errorDetailMessage(detail: unknown, fallback: string): string {
  if (typeof detail === "string" && detail.trim()) {
    return detail;
  }
  const items = Array.isArray(detail) ? detail : detail && typeof detail === "object" ? [detail] : [];
  const parts = items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return typeof item === "string" ? item : "";
      }
      const { loc, msg } = item as { loc?: unknown; msg?: unknown };
      if (typeof msg !== "string" || !msg) {
        return "";
      }
      const path = Array.isArray(loc)
        ? loc.filter((part) => part !== "body" && (typeof part === "string" || typeof part === "number")).join(".")
        : "";
      return path ? `${path}: ${msg}` : msg;
    })
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("; ") : fallback;
}

async function errorFromResponse(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => null);
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  return new Error(errorDetailMessage(detail, response.statusText || `HTTP ${response.status}`));
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response.json() as Promise<T>;
}

/**
 * Fire-and-forget request that survives page unload (`keepalive`). Used for
 * safety stops on pagehide/blur where nothing can await the response.
 */
function sendKeepalive(path: string, method: string, body?: unknown): void {
  try {
    void fetch(`${API_BASE}${path}`, {
      method,
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).catch(() => undefined);
  } catch {
    // The page is going away; the backend dead-man timers are the backstop.
  }
}

export async function fetchDevices(): Promise<Device[]> {
  return requestJson<Device[]>("/api/devices");
}

export async function fetchSettings(): Promise<AppSettings> {
  return requestJson<AppSettings>("/api/settings");
}

export async function updateSettings(update: AppSettingsUpdate): Promise<AppSettings> {
  return requestJson<AppSettings>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(update)
  });
}

export async function fetchControlPresets(): Promise<ControlPreset[]> {
  return requestJson<ControlPreset[]>("/api/control-presets");
}

export async function createControlPreset(request: ControlPresetCreateRequest): Promise<ControlPreset> {
  return requestJson<ControlPreset>("/api/control-presets", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export async function deleteControlPreset(presetId: string): Promise<ControlPresetDeleteResult> {
  return requestJson<ControlPresetDeleteResult>(`/api/control-presets/${encodeURIComponent(presetId)}`, {
    method: "DELETE"
  });
}

export async function fetchControls(deviceName: string): Promise<V4L2Control[]> {
  return requestJson<V4L2Control[]>(`/api/devices/${encodeURIComponent(deviceName)}/controls`);
}

export async function setControlValue(
  deviceName: string,
  controlName: string,
  value: number
): Promise<V4L2Control> {
  return requestJson<V4L2Control>(
    `/api/devices/${encodeURIComponent(deviceName)}/controls/${encodeURIComponent(controlName)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ value })
    }
  );
}

export async function fetchVideoFormats(deviceName: string): Promise<VideoFormatOption[]> {
  return requestJson<VideoFormatOption[]>(`/api/devices/${encodeURIComponent(deviceName)}/formats`);
}

export async function setVideoFormat(
  deviceName: string,
  format: Pick<VideoFormatOption, "pixel_format" | "width" | "height" | "fps" | "frame_interval_100ns">
): Promise<VideoFormatOption> {
  return requestJson<VideoFormatOption>(`/api/devices/${encodeURIComponent(deviceName)}/format`, {
    method: "PATCH",
    body: JSON.stringify(format)
  });
}

export async function fetchUvcExtensionSelectors(deviceName: string): Promise<UvcExtensionSelectorProbe[]> {
  return requestJson<UvcExtensionSelectorProbe[]>(
    `/api/devices/${encodeURIComponent(deviceName)}/uvc-extension/selectors`
  );
}

export async function captureUvcExtensionSnapshot(deviceName: string, save = false): Promise<UvcExtensionSnapshot> {
  return requestJson<UvcExtensionSnapshot>(
    `/api/devices/${encodeURIComponent(deviceName)}/uvc-extension/capture?save=${save ? "true" : "false"}`,
    { method: "POST" }
  );
}

export async function fetchPcapImports(): Promise<PcapImportRecord[]> {
  return requestJson<PcapImportRecord[]>("/api/pcap-imports");
}

export async function uploadPcapImport(
  file: File,
  metadata: { action?: string; notes?: string; source?: string } = {}
): Promise<PcapImportRecord> {
  const params = new URLSearchParams({
    filename: file.name,
    source: metadata.source ?? "windows"
  });
  if (metadata.action) {
    params.set("action", metadata.action);
  }
  if (metadata.notes) {
    params.set("notes", metadata.notes);
  }

  const response = await fetch(`${API_BASE}/api/pcap-imports?${params.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.tcpdump.pcap"
    },
    body: file
  });

  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  return response.json() as Promise<PcapImportRecord>;
}

export function videoStreamUrl(
  deviceName: string,
  format: Pick<VideoFormatOption, "pixel_format" | "width" | "height" | "fps" | "frame_interval_100ns">,
  token = Date.now()
): string {
  const params = new URLSearchParams({
    pixel_format: format.pixel_format,
    width: String(format.width),
    height: String(format.height),
    fps: String(format.fps),
    t: String(token)
  });
  if (format.frame_interval_100ns) {
    params.set("frame_interval_100ns", String(format.frame_interval_100ns));
  }
  return `${API_BASE}/api/devices/${encodeURIComponent(deviceName)}/stream?${params.toString()}`;
}

/**
 * The preview is an <img>, which hides why a stream request failed. After the
 * preview gives up, re-request the stream once to read the backend's reason
 * (422 out-of-range format, 503 setup failure). A stream that answers OK is
 * aborted at once and reported as `null`.
 */
export async function fetchStreamError(url: string): Promise<string | null> {
  const controller = new AbortController();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.ok) {
      controller.abort();
      return null;
    }
    return (await errorFromResponse(response)).message;
  } catch {
    return null;
  }
}

export async function stopVideoStream(deviceName: string): Promise<VideoStreamStopResult> {
  return requestJson<VideoStreamStopResult>(`/api/devices/${encodeURIComponent(deviceName)}/stream/stop`, {
    method: "POST"
  });
}

export async function fetchVideoRecordingStatus(): Promise<VideoRecordingStatus> {
  return requestJson<VideoRecordingStatus>("/api/video/recording/status");
}

export async function startVideoRecording(
  deviceName: string,
  format: Pick<VideoFormatOption, "pixel_format" | "width" | "height" | "fps" | "frame_interval_100ns">
): Promise<VideoRecordingStatus> {
  return requestJson<VideoRecordingStatus>(`/api/devices/${encodeURIComponent(deviceName)}/recording/start`, {
    method: "POST",
    body: JSON.stringify(format)
  });
}

export async function stopVideoRecording(): Promise<VideoRecordingStatus> {
  return requestJson<VideoRecordingStatus>("/api/video/recording/stop", {
    method: "POST"
  });
}

export async function fetchPixyHidStatus(): Promise<PixyHidStatus> {
  return requestJson<PixyHidStatus>("/api/pixy-hid/status");
}

export async function fetchPixyHidState(): Promise<PixyHidDeviceState> {
  return requestJson<PixyHidDeviceState>("/api/pixy-hid/state");
}

export async function fetchPixyHidQueries(): Promise<PixyHidRawQueryResult[]> {
  return requestJson<PixyHidRawQueryResult[]>("/api/pixy-hid/queries");
}

export async function fetchPixyHidQuery(queryName: PixyHidQueryName): Promise<PixyHidRawQueryResult> {
  return requestJson<PixyHidRawQueryResult>(`/api/pixy-hid/query/${encodeURIComponent(queryName)}`);
}

export async function capturePixyHidDiagnostics(save = false): Promise<PixyHidDiagnosticSnapshot> {
  return requestJson<PixyHidDiagnosticSnapshot>(`/api/pixy-hid/diagnostics/capture?save=${save ? "true" : "false"}`, {
    method: "POST"
  });
}

export async function setPixyTracking(mode: TrackingMode): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/tracking", {
    method: "PATCH",
    body: JSON.stringify({ mode })
  });
}

export async function setPixyTargetTracking(
  mode: TargetTrackingMode,
  options: { x?: number; y?: number; scale?: number } = {}
): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/target-tracking", {
    method: "PATCH",
    body: JSON.stringify({ mode, ...options })
  });
}

export async function setPixyGesture(enabled: boolean): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/gesture", {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export async function setPixyAutoRotate(enabled: boolean): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/auto-rotate", {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export async function setPixyMirror(mode: MirrorMode): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/mirror", {
    method: "PATCH",
    body: JSON.stringify({
      horizontal: mode === "h" || mode === "hv",
      vertical: mode === "v" || mode === "hv"
    })
  });
}

export async function setPixyFocusMetering(
  mode: FocusMeteringMode,
  point?: FocusMeteringPoint
): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/focus-metering", {
    method: "PATCH",
    body: JSON.stringify({ mode, ...point })
  });
}

export async function setPixyAudio(mode: AudioMode): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/audio", {
    method: "PATCH",
    body: JSON.stringify({ mode })
  });
}

export async function setPixyAutoPrivacy(timeoutSeconds: number): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/auto-privacy", {
    method: "PATCH",
    body: JSON.stringify({ timeout_seconds: timeoutSeconds })
  });
}

export async function sendPixyPtzDirection(direction: PtzDirection): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-direction", {
    method: "PATCH",
    body: JSON.stringify({ direction })
  });
}

export async function sendPixyPtzRelative(direction: PtzDirection, degrees: number): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-relative", {
    method: "PATCH",
    body: JSON.stringify({ direction, degrees })
  });
}

export async function sendPixyPtzAbsolute(pan: number, tilt: number): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-absolute", {
    method: "PATCH",
    body: JSON.stringify({ pan, tilt })
  });
}

export async function recenterPixyPtz(): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-recenter", {
    method: "PATCH"
  });
}

export async function sendPixyPtzVector(vector: PtzVector): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-vector", {
    method: "PATCH",
    body: JSON.stringify({ z: 0, ...vector })
  });
}

/** Zero-vector stop sent with `keepalive` so it still lands during pagehide. */
export function stopPixyPtzKeepalive(): void {
  sendKeepalive("/api/pixy-hid/ptz-vector", "PATCH", { x: 0, y: 0, z: 0 });
}

export async function savePixyPtzPreset(slot: PtzPresetSlot): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-preset/save", {
    method: "PATCH",
    body: JSON.stringify({ slot })
  });
}

export async function loadPixyPtzPreset(slot: PtzPresetSlot): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-preset/load", {
    method: "PATCH",
    body: JSON.stringify({ slot })
  });
}

export async function fetchAudioStatus(): Promise<AudioStatus> {
  return requestJson<AudioStatus>("/api/audio/status");
}

export async function setAudioMute(muted: boolean): Promise<AudioCommandResult> {
  return requestJson<AudioCommandResult>("/api/audio/mute", {
    method: "PATCH",
    body: JSON.stringify({ muted })
  });
}

export async function setAudioVolume(volume: number): Promise<AudioCommandResult> {
  return requestJson<AudioCommandResult>("/api/audio/volume", {
    method: "PATCH",
    body: JSON.stringify({ volume })
  });
}

export async function setAudioDefaultSource(): Promise<AudioCommandResult> {
  return requestJson<AudioCommandResult>("/api/audio/default-source", { method: "POST" });
}

export async function startAudioMonitor(): Promise<AudioMonitorResult> {
  return requestJson<AudioMonitorResult>("/api/audio/monitor/start", { method: "POST" });
}

export async function stopAudioMonitor(): Promise<AudioMonitorResult> {
  return requestJson<AudioMonitorResult>("/api/audio/monitor/stop", { method: "POST" });
}

export async function clearPixyPtzPreset(slot: PtzPresetSlot): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ptz-preset/clear", {
    method: "PATCH",
    body: JSON.stringify({ slot })
  });
}

export async function capturePixyPowerOnDefault(): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/power-on-default/capture", { method: "PATCH" });
}

export async function disablePixyPowerOnDefault(): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/power-on-default/disable", { method: "PATCH" });
}

export async function pixyGoToDefault(): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/go-to-default", { method: "PATCH" });
}

export async function setPixyDenoise(enabled: boolean): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/denoise", {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export async function setPixyWbLock(enabled: boolean): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/wb-lock", {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export async function setPixyEvLock(enabled: boolean, exposure = 0): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/ev-lock", {
    method: "PATCH",
    body: JSON.stringify({ enabled, exposure })
  });
}

export async function setPixyFocusLock(enabled: boolean): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/focus-lock", {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export async function setPixyRemotePairing(enabled: boolean): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/remote-pairing", {
    method: "PATCH",
    body: JSON.stringify({ enabled })
  });
}

export async function setPixyMotorSpeed(axis: number, degreesPerSecond: number): Promise<PixyHidCommandResult> {
  return requestJson<PixyHidCommandResult>("/api/pixy-hid/motor-speed", {
    method: "PATCH",
    body: JSON.stringify({ axis, degrees_per_second: degreesPerSecond })
  });
}

export async function fetchVirtualCamStatus(): Promise<VirtualCamStatus> {
  return requestJson<VirtualCamStatus>("/api/virtualcam/status");
}

export async function startVirtualCam(request: VirtualCamStartRequest): Promise<VirtualCamActionResult> {
  return requestJson<VirtualCamActionResult>("/api/virtualcam/start", {
    method: "POST",
    body: JSON.stringify(request)
  });
}

export async function stopVirtualCam(): Promise<VirtualCamActionResult> {
  return requestJson<VirtualCamActionResult>("/api/virtualcam/stop", { method: "POST" });
}

export async function fetchAutomationStatus(): Promise<AutomationStatus> {
  return requestJson<AutomationStatus>("/api/automation/status");
}

// The backend replaces (and persists) the whole automation model: omitted
// fields fall back to defaults, so callers must send a complete settings
// object (useAutomation builds it from the freshest confirmed state).
export async function updateAutomationSettings(settings: AutomationSettings): Promise<AutomationStatus> {
  return requestJson<AutomationStatus>("/api/automation/settings", {
    method: "PATCH",
    body: JSON.stringify(settings)
  });
}

export async function fetchFirmwareStatus(checkUpdates = false): Promise<FirmwareStatus> {
  return requestJson<FirmwareStatus>(`/api/firmware/status${checkUpdates ? "?check_updates=true" : ""}`);
}

// Audio level meter routes (backend: GET/POST /api/audio/meter*). These mirror
// the monitor helpers above; AudioMonitorResult.level carries the RMS percent.
export async function fetchAudioMeter(): Promise<AudioMonitorResult> {
  return requestJson<AudioMonitorResult>("/api/audio/meter");
}

export async function startAudioMeter(): Promise<AudioMonitorResult> {
  return requestJson<AudioMonitorResult>("/api/audio/meter/start", { method: "POST" });
}

export async function stopAudioMeter(): Promise<AudioMonitorResult> {
  return requestJson<AudioMonitorResult>("/api/audio/meter/stop", { method: "POST" });
}

/** Meter stop sent with `keepalive` so it still lands during pagehide. */
export function stopAudioMeterKeepalive(): void {
  sendKeepalive("/api/audio/meter/stop", "POST");
}

// Delete an imported capture (backend: DELETE /api/pcap-imports/{id}).
export async function deletePcapImport(captureId: string): Promise<PcapImportRecord> {
  return requestJson<PcapImportRecord>(`/api/pcap-imports/${encodeURIComponent(captureId)}`, {
    method: "DELETE"
  });
}

// Restore the audio default source the backend captured on set-default.
export async function restoreAudioDefaultSource(): Promise<AudioCommandResult> {
  return requestJson<AudioCommandResult>("/api/audio/default-source/restore", { method: "POST" });
}
