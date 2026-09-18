import { useEffect, useState } from "react";
import { Aperture, Camera, Cpu, Crosshair, Focus, RotateCw, SlidersHorizontal, Sparkles } from "lucide-react";

import { fetchVideoRecordingStatus } from "../../lib/apiClient";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UseDevicesResult } from "../../hooks/useDevices";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import { formatKey, type UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import type { Device, VideoRecordingStatus } from "../../types/api";
import "./DeviceRail.css";

function deviceNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function shortDeviceName(name: string): string {
  // Card names arrive as "EMEET PIXY: EMEET PIXY" — the first segment is enough.
  const head = name.split(":")[0]?.trim();
  return head || name;
}

function isVirtualDevice(device: Device): boolean {
  const haystack = `${device.driver ?? ""} ${device.bus_info ?? ""} ${device.name}`.toLowerCase();
  return haystack.includes("v4l2loopback") || haystack.includes("loopback");
}

type Props = {
  devices: UseDevicesResult;
  controls: UseControlsResult;
  videoFormats: UseVideoFormatsResult;
  pixyHid: UsePixyHidResult;
};

function hasAnyControl(controls: UseControlsResult, names: string[]): boolean {
  return controls.controls.some((control) => names.includes(control.name));
}

const RECORDING_POLL_MS = 5000;

function useRecordingStatus(selectedDeviceName: string | null): VideoRecordingStatus | null {
  const [status, setStatus] = useState<VideoRecordingStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const next = await fetchVideoRecordingStatus();
        if (!cancelled) {
          setStatus(next);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
        }
      }
    }
    void poll();
    const timer = window.setInterval(() => void poll(), RECORDING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedDeviceName]);

  return status;
}

export function DeviceRail({ devices, controls, videoFormats, pixyHid }: Props) {
  const selectedDeviceName = devices.selectedDeviceName ?? "";
  const selectedDevice = devices.selectedDevice;
  const recordingStatus = useRecordingStatus(devices.selectedDeviceName);
  const recordingHere =
    recordingStatus?.recording === true &&
    (recordingStatus.device_name === null || recordingStatus.device_name === devices.selectedDeviceName);
  const recordingFile = recordingStatus?.path?.split("/").at(-1) ?? null;

  const scanning = devices.isLoading && devices.devices.length === 0;
  const backendDown = devices.error !== null && devices.devices.length === 0;

  const capabilityRows = [
    {
      label: "PTZ Control",
      detail: "Pan, Tilt, Zoom",
      ready: hasAnyControl(controls, ["pan_absolute", "tilt_absolute", "zoom_absolute"]),
      icon: Crosshair
    },
    {
      label: "Image Control",
      detail: "WB, Color, NR",
      ready: hasAnyControl(controls, ["brightness", "contrast", "saturation", "sharpness"]),
      icon: SlidersHorizontal
    },
    {
      label: "Focus Control",
      detail: "Auto, Manual",
      ready: hasAnyControl(controls, ["focus_absolute", "focus_automatic_continuous"]),
      icon: Focus
    },
    {
      label: "Exposure Control",
      detail: "Auto, Manual",
      ready: hasAnyControl(controls, ["auto_exposure", "exposure_time_absolute"]),
      icon: Aperture
    },
    {
      label: "Smart Pixy",
      detail: "Framing, Gesture",
      ready: pixyHid.status?.writable === true,
      icon: Sparkles,
      partial: pixyHid.status?.available === true && pixyHid.status?.writable !== true
    }
  ];

  return (
    <aside className="device-rail">
      <div className="panel-title-row">
        <Camera size={18} />
        <h2>Device Bay</h2>
        {recordingHere && (
          <span className="device-rec-badge" title={recordingFile ? `Recording ${recordingFile}` : "Recording"}>
            REC
          </span>
        )}
      </div>

      <div className="device-picker">
        <div className="device-picker-readout">
          <Camera size={24} />
          <div>
            <strong>
              {scanning
                ? "Scanning devices…"
                : (selectedDevice ? shortDeviceName(selectedDevice.name) : "No camera selected")}
            </strong>
            <small>
              {selectedDeviceName
                ? `/dev/${selectedDeviceName}`
                : scanning
                  ? "Probing /dev/video*"
                  : backendDown
                    ? "Backend unreachable"
                    : "Awaiting PIXY"}
              {selectedDevice ? " - Capture" : ""}
            </small>
          </div>
        </div>
        <select
          className="device-select"
          aria-label="Select video device"
          value={selectedDeviceName}
          disabled={devices.devices.length === 0}
          onChange={(event) => devices.setSelectedDeviceName(event.target.value)}
        >
          {devices.devices.length === 0 && <option value="">No devices</option>}
          {devices.devices.map((device) => {
            const deviceName = deviceNameFromPath(device.path);
            const virtual = isVirtualDevice(device);
            return (
              <option key={device.path} value={deviceName}>
                {deviceName.toUpperCase()} - {virtual ? "Virtual" : shortDeviceName(device.name)}
              </option>
            );
          })}
        </select>
        {!scanning && !backendDown && devices.devices.length === 0 && (
          <small className="device-hint">Connect the PIXY over USB, then refresh.</small>
        )}
        {backendDown && (
          <small className="device-hint device-hint-error">{devices.error}</small>
        )}
      </div>

      <div className="format-picker">
        <div>
          <strong>Video Format</strong>
          <small>
            {videoFormats.isLoading
              ? "Loading formats…"
              : (videoFormats.selectedFormat?.description ?? "Standard UVC stream")}
          </small>
        </div>
        <select
          className="device-select"
          aria-label="Select video format"
          value={videoFormats.selectedKey}
          disabled={videoFormats.formats.length === 0 || videoFormats.pending || videoFormats.isLoading}
          onChange={(event) => void videoFormats.setSelectedKey(event.target.value)}
        >
          {videoFormats.formats.length === 0 && (
            <option value="">{videoFormats.isLoading ? "Loading…" : "No formats"}</option>
          )}
          {videoFormats.formats.map((format) => {
            const key = formatKey(format);
            return (
              <option key={key} value={key}>
                {format.label}
              </option>
            );
          })}
        </select>
        {videoFormats.error && <small className="format-error">{videoFormats.error}</small>}
      </div>

      <button
        className="secondary-button"
        onClick={() => void devices.refresh()}
        disabled={devices.isLoading}
      >
        <RotateCw size={16} className={devices.isLoading ? "spin" : undefined} />
        {devices.isLoading ? "Scanning…" : "Refresh devices"}
      </button>

      <div className="device-meta">
        <Cpu size={16} />
        <span>
          {selectedDevice?.driver ?? "Awaiting driver"}
          {selectedDevice?.bus_info ? ` - ${selectedDevice.bus_info}` : ""}
        </span>
      </div>

      <div className="rail-divider" />

      <div className="rail-section-title">Capabilities Summary</div>
      <div className="capability-list">
        {capabilityRows.map((row) => {
          const Icon = row.icon;
          return (
            <div className="capability-row" key={row.label}>
              <Icon size={16} />
              <div>
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
              </div>
              <em className={row.ready ? "is-ok" : row.partial ? "is-partial" : ""}>
                {row.ready ? "OK" : row.partial ? "Partial" : "Wait"}
              </em>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
