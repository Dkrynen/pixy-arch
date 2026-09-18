import { RadioTower } from "lucide-react";

import type { UseAudioResult } from "../../hooks/useAudio";
import type { UseControlPresetsResult } from "../../hooks/useControlPresets";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UseFirmwareResult } from "../../hooks/useFirmware";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import type { UseVirtualCamResult } from "../../hooks/useVirtualCam";
import { ControlGroupPanel } from "../controls/ControlGroupPanel";
import { FirmwarePanel } from "../panels/FirmwarePanel";
import { SmartPixyPanel } from "../panels/SmartPixyPanel";
import { VideoMonitor } from "../panels/VideoMonitor";
import { VirtualCamPanel } from "../panels/VirtualCamPanel";

type Props = {
  deviceName: string | null;
  controls: UseControlsResult;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
  audio: UseAudioResult;
  virtualCam: UseVirtualCamResult;
  firmware: UseFirmwareResult;
  privacySafety: UsePrivacySafetyResult;
  controlPresets: UseControlPresetsResult;
};

export function ControlDeck({
  deviceName,
  controls,
  videoFormats,
  videoCapture,
  pixyHid,
  audio,
  virtualCam,
  firmware,
  privacySafety,
  controlPresets
}: Props) {
  return (
    <div className="operator-deck">
      <div className="operator-main">
        <VideoMonitor
          deviceName={deviceName}
          videoFormats={videoFormats}
          videoCapture={videoCapture}
          pixyHid={pixyHid}
        />
        <div className="control-grid">
          {controls.groups.filter((group) => group.id !== "smart").map((group) => (
            <ControlGroupPanel
              key={group.id}
              group={group}
              controls={controls}
              pixyHid={pixyHid}
              controlPresets={controlPresets}
            />
          ))}
        </div>
        <div className="deck-pair">
          <VirtualCamPanel
            virtualCam={virtualCam}
            videoFormats={videoFormats}
            privacySafety={privacySafety}
          />
          <FirmwarePanel firmware={firmware} />
        </div>
      </div>
      <aside className="operator-side">
        <SignalPanel controls={controls} videoCapture={videoCapture} />
        <SmartPixyPanel pixyHid={pixyHid} audio={audio} privacySafety={privacySafety} />
      </aside>
    </div>
  );
}

function SignalPanel({
  controls,
  videoCapture
}: {
  controls: UseControlsResult;
  videoCapture: UseVideoCaptureResult;
}) {
  return (
    <div className="signal-panel compact-signal-panel">
      <div className="panel-title-row">
        <RadioTower size={18} />
        <h2>Signal</h2>
      </div>
      <div className="telemetry-stack">
        <div>
          <span>V4L2</span>
          <strong>{controls.isLoading ? "Scanning" : "Ready"}</strong>
        </div>
        <div>
          <span>Controls</span>
          <strong>{controls.controls.length}</strong>
        </div>
        <div>
          <span>Stream</span>
          <strong>{videoCapture.previewEnabled ? "Live" : "Idle"}</strong>
        </div>
      </div>
    </div>
  );
}
