import { useCallback } from "react";

import { AppShell } from "../components/layout/AppShell";
import { useAudio } from "../hooks/useAudio";
import { useAutomation } from "../hooks/useAutomation";
import { useControlPresets } from "../hooks/useControlPresets";
import { useControls } from "../hooks/useControls";
import { useDevices } from "../hooks/useDevices";
import { useFirmware } from "../hooks/useFirmware";
import { useHotplugEvents } from "../hooks/useHotplugEvents";
import { usePixyHid } from "../hooks/usePixyHid";
import { usePrivacySafety } from "../hooks/usePrivacySafety";
import { useVideoCapture } from "../hooks/useVideoCapture";
import { useVideoFormats } from "../hooks/useVideoFormats";
import { useVirtualCam } from "../hooks/useVirtualCam";
import { useCommandLogFeed } from "../lib/commandLog";

export function App() {
  const devices = useDevices();
  const controls = useControls(devices.selectedDeviceName);
  const videoFormats = useVideoFormats(devices.selectedDeviceName);
  const virtualCam = useVirtualCam();
  const videoCapture = useVideoCapture(devices.selectedDeviceName, videoFormats.selectedFormat, {
    // Under the relay, recording reads the shared frame tap — no need to
    // drop the preview while a recording runs.
    keepPreviewDuringRecording: virtualCam.status?.running === true,
  });
  const pixyHid = usePixyHid();
  const audio = useAudio();
  const automation = useAutomation();
  const firmware = useFirmware();
  const privacySafety = usePrivacySafety(pixyHid, audio);
  const controlPresets = useControlPresets();
  const handleVideoHotplug = useCallback(() => {
    void devices.refresh({ showLoading: false });
    // A replugged camera returns under the same device name, which means the
    // device-keyed hooks would not refetch on their own — stale controls and
    // formats otherwise persist across the unplug/replug boundary.
    void controls.refresh();
    void videoFormats.refresh();
  }, [controls.refresh, devices.refresh, videoFormats.refresh]);
  const handleHidHotplug = useCallback(() => {
    void pixyHid.refreshStatus({ showLoading: false });
  }, [pixyHid.refreshStatus]);

  useHotplugEvents({
    onVideo: handleVideoHotplug,
    onHid: handleHidHotplug
  });

  // Feed the shared command log at the app root so events are recorded even
  // while the diagnostics view (which renders the log) is hidden.
  useCommandLogFeed({
    devices,
    controls,
    videoFormats,
    videoCapture,
    pixyHid,
    audio,
    privacySafety
  });

  return (
    <AppShell
      devices={devices}
      controls={controls}
      videoFormats={videoFormats}
      videoCapture={videoCapture}
      pixyHid={pixyHid}
      audio={audio}
      virtualCam={virtualCam}
      automation={automation}
      firmware={firmware}
      privacySafety={privacySafety}
      controlPresets={controlPresets}
    />
  );
}
