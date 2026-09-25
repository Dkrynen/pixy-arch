import { RadioTower } from "lucide-react";
import type { ReactNode } from "react";

import type { UseAudioResult } from "../../hooks/useAudio";
import type { UseControlsResult } from "../../hooks/useControls";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import { countActiveControls } from "../../domains/controls/grouping";
import { CommandLogPanel } from "../panels/CommandLogPanel";
import { ExperimentalPanel } from "../panels/ExperimentalPanel";
import { HidDiagnosticsPanel } from "../panels/HidDiagnosticsPanel";
import { PcapImportPanel } from "../panels/PcapImportPanel";

type Props = {
  deviceName: string | null;
  /** The device picker, shown in the side column. */
  deviceBay?: ReactNode;
  controls: UseControlsResult;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
  audio: UseAudioResult;
  privacySafety: UsePrivacySafetyResult;
};

export function DiagnosticsDeck({
  deviceName,
  deviceBay,
  controls,
  videoFormats,
  videoCapture,
  pixyHid,
  audio,
  privacySafety
}: Props) {
  return (
    <div className="operator-deck diagnostics-console">
      <div className="operator-main">
        <div className="diagnostics-grid">
          <HidDiagnosticsPanel />
          <ExperimentalPanel deviceName={deviceName} />
        </div>
        <CommandLogPanel
          controls={controls}
          videoFormats={videoFormats}
          videoCapture={videoCapture}
          pixyHid={pixyHid}
          audio={audio}
          privacySafety={privacySafety}
        />
      </div>
      <aside className="operator-side">
        <SignalPanel controls={controls} pixyHid={pixyHid} videoCapture={videoCapture} deviceName={deviceName} />
        <PcapImportPanel />
        {deviceBay}
      </aside>
    </div>
  );
}

function SignalPanel({
  controls,
  pixyHid,
  videoCapture,
  deviceName
}: {
  controls: UseControlsResult;
  pixyHid: UsePixyHidResult;
  videoCapture: UseVideoCaptureResult;
  deviceName: string | null;
}) {
  const hidState = pixyHid.status?.writable ? "Linked" : pixyHid.status?.available ? "Limited" : "Absent";
  return (
    <section className="signal-panel">
      <div className="panel-title-row">
        <RadioTower size={16} />
        <h2>Signal</h2>
      </div>
      <dl className="telemetry-stack">
        <div>
          <dt>V4L2</dt>
          <dd className={controls.isLoading ? "" : "is-good"}>{controls.isLoading ? "Scanning" : "Ready"}</dd>
        </div>
        <div>
          <dt>Controls</dt>
          <dd title={`${countActiveControls(controls.controls)} active`}>{controls.controls.length}</dd>
        </div>
        <div>
          <dt>HID</dt>
          <dd className={pixyHid.status?.writable ? "is-good" : "is-warn"} title={pixyHid.status?.path ?? undefined}>
            {hidState}
          </dd>
        </div>
        <div>
          <dt>Stream</dt>
          <dd className={videoCapture.previewEnabled ? "is-good" : ""}>{videoCapture.previewEnabled ? "Live" : "Idle"}</dd>
        </div>
        <div className="telemetry-wide">
          <dt>Device</dt>
          <dd>{deviceName ? `/dev/${deviceName}` : "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
