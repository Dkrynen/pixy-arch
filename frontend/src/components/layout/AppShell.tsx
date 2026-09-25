import { FlaskConical, RefreshCw, Settings, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { countActiveControls } from "../../domains/controls/grouping";
import type { UseAudioResult } from "../../hooks/useAudio";
import type { UseAutomationResult } from "../../hooks/useAutomation";
import type { UseControlPresetsResult } from "../../hooks/useControlPresets";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UseDevicesResult } from "../../hooks/useDevices";
import type { UseFirmwareResult } from "../../hooks/useFirmware";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import type { UseVirtualCamResult } from "../../hooks/useVirtualCam";
import { DeviceRail } from "../panels/DeviceRail";
import { StatusPill } from "../ui/StatusPill";
import { ControlDeck } from "./ControlDeck";
import { DiagnosticsDeck } from "./DiagnosticsDeck";
import { SettingsDeck } from "../settings/SettingsDeck";

type Props = {
  devices: UseDevicesResult;
  controls: UseControlsResult;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
  audio: UseAudioResult;
  virtualCam: UseVirtualCamResult;
  automation: UseAutomationResult;
  firmware: UseFirmwareResult;
  privacySafety: UsePrivacySafetyResult;
  controlPresets: UseControlPresetsResult;
};

type View = "control" | "diagnostics" | "settings";

const VIEWS: { id: View; label: string; icon: typeof SlidersHorizontal }[] = [
  { id: "control", label: "Control Deck", icon: SlidersHorizontal },
  { id: "diagnostics", label: "Diagnostics", icon: FlaskConical },
  { id: "settings", label: "Settings", icon: Settings }
];

export function AppShell({
  devices,
  controls,
  videoFormats,
  videoCapture,
  pixyHid,
  audio,
  virtualCam,
  automation,
  firmware,
  privacySafety,
  controlPresets
}: Props) {
  const activeControls = countActiveControls(controls.controls);
  const [view, setView] = useState<View>("control");
  const isRecording = videoCapture.status?.recording === true;
  const isPrivacy = pixyHid.deviceTrackingState === "privacy";
  const offline = devices.error !== null && devices.devices.length === 0;
  const connection = offline
    ? { tone: "danger" as const, label: "Offline", title: devices.error ?? "Backend unreachable" }
    : devices.selectedDevice
      ? {
          tone: "good" as const,
          label: "Connected",
          title: `${devices.selectedDevice.name.split(":")[0]} on ${devices.selectedDevice.path} · ${activeControls} of ${controls.controls.length} controls active`
        }
      : { tone: "warn" as const, label: "No camera", title: "Connect the PIXY over USB" };

  const deviceBay = (
    <DeviceRail devices={devices} controls={controls} videoFormats={videoFormats} pixyHid={pixyHid} />
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none">
                <circle cx="12" cy="12" r="7.25" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="2.75" fill="currentColor" />
                <circle cx="12" cy="3.4" r="1.4" fill="currentColor" />
              </svg>
            </div>
            <div className="brand-text">
              <h1>Pixy Arch</h1>
              <p>EMEET PIXY control deck</p>
            </div>
          </div>
          <div className="view-switch" role="group" aria-label="Workspace view">
            {VIEWS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={view === id ? "is-selected" : ""}
                onClick={() => setView(id)}
                aria-pressed={view === id}
              >
                <Icon size={15} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <div className="topbar-actions">
            {isRecording && <StatusPill tone="danger" label="Recording" pulse title={videoCapture.status?.path ?? undefined} />}
            {isPrivacy && <StatusPill tone="warn" label="Privacy" title="Lens closed — privacy mode is on" />}
            <StatusPill tone={connection.tone} label={connection.label} title={connection.title} />
            <button
              className="icon-button ghost-button"
              onClick={() => void controls.refresh()}
              title="Refresh controls"
              aria-label="Refresh controls"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </header>

      <main className={`workspace view-${view}`}>
        {(controls.error || devices.error || controlPresets.error) && (
          <div className="error-stack">
            {controls.error && (
              <div className="error-strip" role="alert">
                {controls.error}
              </div>
            )}
            {devices.error && (
              <div className="error-strip" role="alert">
                {devices.error}
              </div>
            )}
            {controlPresets.error && (
              <div className="error-strip" role="alert">
                {controlPresets.error}
              </div>
            )}
          </div>
        )}
        {view === "control" ? (
          <ControlDeck
            deviceName={devices.selectedDeviceName}
            deviceBay={deviceBay}
            controls={controls}
            videoFormats={videoFormats}
            videoCapture={videoCapture}
            pixyHid={pixyHid}
            audio={audio}
            virtualCam={virtualCam}
            firmware={firmware}
            privacySafety={privacySafety}
            controlPresets={controlPresets}
          />
        ) : view === "diagnostics" ? (
          <DiagnosticsDeck
            deviceName={devices.selectedDeviceName}
            deviceBay={deviceBay}
            controls={controls}
            videoFormats={videoFormats}
            videoCapture={videoCapture}
            pixyHid={pixyHid}
            audio={audio}
            privacySafety={privacySafety}
          />
        ) : (
          <SettingsDeck privacySafety={privacySafety} automation={automation} />
        )}
      </main>
    </div>
  );
}
