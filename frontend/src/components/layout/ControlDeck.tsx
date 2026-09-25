import type { ReactNode } from "react";

import type { ControlGroup } from "../../domains/controls/grouping";
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
  /** The device picker, rendered in the side column (last on narrow screens). */
  deviceBay?: ReactNode;
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

/*
 * Wide screens: a main column (monitor, imaging, virtual camera) and a side
 * column (PTZ, Smart Pixy, device, firmware). Narrow screens flatten both
 * columns and reorder the slots so the operator sees monitor → PTZ → Smart
 * Pixy first and the device bay last (see .deck-slot ordering in styles.css).
 */
export function ControlDeck({
  deviceName,
  deviceBay,
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
  const groups = controls.groups.filter((group) => group.id !== "smart");
  const byId = (id: ControlGroup["id"]) => groups.find((group) => group.id === id);
  const ptz = byId("ptz");
  const image = byId("image");
  const focus = byId("focus");
  const exposure = byId("exposure");
  const other = byId("other");
  const renderGroup = (group: ControlGroup) => (
    <ControlGroupPanel group={group} controls={controls} pixyHid={pixyHid} controlPresets={controlPresets} />
  );

  return (
    <div className="operator-deck">
      <div className="operator-main">
        <div className="deck-slot slot-monitor">
          <VideoMonitor
            deviceName={deviceName}
            videoFormats={videoFormats}
            videoCapture={videoCapture}
            pixyHid={pixyHid}
            virtualCamRunning={virtualCam.status?.running === true}
          />
        </div>
        {image && <div className="deck-slot slot-image">{renderGroup(image)}</div>}
        {(focus || exposure) && (
          <div className="deck-slot slot-lens deck-pair">
            {focus && renderGroup(focus)}
            {exposure && renderGroup(exposure)}
          </div>
        )}
        {other && <div className="deck-slot slot-other">{renderGroup(other)}</div>}
        <div className="deck-slot slot-vcam">
          <VirtualCamPanel virtualCam={virtualCam} videoFormats={videoFormats} privacySafety={privacySafety} />
        </div>
      </div>
      <aside className="operator-side">
        {ptz && <div className="deck-slot slot-ptz">{renderGroup(ptz)}</div>}
        <div className="deck-slot slot-smart">
          <SmartPixyPanel pixyHid={pixyHid} audio={audio} privacySafety={privacySafety} />
        </div>
        {deviceBay && <div className="deck-slot slot-device">{deviceBay}</div>}
        <div className="deck-slot slot-firmware">
          <FirmwarePanel firmware={firmware} />
        </div>
      </aside>
    </div>
  );
}
