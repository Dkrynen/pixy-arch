import { RefreshCw, Radar, SlidersHorizontal, FlaskConical, Settings } from "lucide-react";
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
  const [view, setView] = useState<"control" | "diagnostics" | "settings">("control");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Radar size={24} />
          </div>
          <div>
            <h1>Pixy Arch</h1>
            <p>Linux control deck for EMEET PIXY</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="view-switch" role="group" aria-label="Workspace view">
            <button
              className={view === "control" ? "is-selected" : ""}
              onClick={() => setView("control")}
              aria-pressed={view === "control"}
            >
              <SlidersHorizontal size={15} />
              Control Deck
            </button>
            <button
              className={view === "diagnostics" ? "is-selected" : ""}
              onClick={() => setView("diagnostics")}
              aria-pressed={view === "diagnostics"}
            >
              <FlaskConical size={15} />
              Diagnostics
            </button>
            <button
              className={view === "settings" ? "is-selected" : ""}
              onClick={() => setView("settings")}
              aria-pressed={view === "settings"}
            >
              <Settings size={15} />
              Settings
            </button>
          </div>
          <StatusPill
            tone={devices.selectedDevice ? "good" : "warn"}
            label={devices.selectedDevice ? "Device linked" : "No device"}
          />
          <StatusPill tone="info" label={`${activeControls}/${controls.controls.length} active`} />
          <button
            className="icon-button"
            onClick={() => void controls.refresh()}
            title="Refresh controls"
            aria-label="Refresh controls"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className={`command-grid view-${view}`}>
        <DeviceRail devices={devices} controls={controls} videoFormats={videoFormats} pixyHid={pixyHid} />

        <div className="main-console">
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
          {view === "control" ? (
            <ControlDeck
              deviceName={devices.selectedDeviceName}
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
        </div>
      </section>
    </main>
  );
}
