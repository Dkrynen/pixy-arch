import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fetchVideoRecordingStatus,
  startVideoRecording,
  stopVideoStream,
  stopVideoRecording,
  videoStreamUrl
} from "../lib/apiClient";
import type { VideoFormatOption, VideoRecordingStatus } from "../types/api";

export type UseVideoCaptureResult = {
  previewEnabled: boolean;
  streamUrl: string | null;
  status: VideoRecordingStatus | null;
  pending: boolean;
  error: string | null;
  togglePreview: () => void;
  restartPreview: () => void;
  refreshStatus: () => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
};

export function useVideoCapture(
  deviceName: string | null,
  selectedFormat: VideoFormatOption | null,
  options?: { keepPreviewDuringRecording?: boolean }
): UseVideoCaptureResult {
  const keepPreviewDuringRecording = options?.keepPreviewDuringRecording === true;
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [streamToken, setStreamToken] = useState(0);
  const [status, setStatus] = useState<VideoRecordingStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousDeviceNameRef = useRef<string | null>(deviceName);
  const resumePreviewAfterRecordingRef = useRef(false);

  const streamUrl = useMemo(() => {
    if (!previewEnabled || !deviceName || !selectedFormat) {
      return null;
    }
    return videoStreamUrl(deviceName, selectedFormat, streamToken);
  }, [deviceName, previewEnabled, selectedFormat, streamToken]);

  const refreshStatus = useCallback(async () => {
    setError(null);
    try {
      setStatus(await fetchVideoRecordingStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to inspect recording state");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Poll while recording so an unexpected ffmpeg exit (camera unplugged,
  // device claimed elsewhere) surfaces quickly instead of a stale "Recording".
  useEffect(() => {
    if (status?.recording !== true) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshStatus();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [status?.recording, refreshStatus]);

  useEffect(() => {
    const previousDeviceName = previousDeviceNameRef.current;
    resumePreviewAfterRecordingRef.current = false;
    setPreviewEnabled((enabled) => {
      if (enabled && previousDeviceName) {
        void stopVideoStream(previousDeviceName).catch(() => undefined);
      }
      return false;
    });
    setStreamToken((current) => current + 1);
    previousDeviceNameRef.current = deviceName;
  }, [deviceName]);

  useEffect(() => {
    setStreamToken((current) => current + 1);
  }, [selectedFormat]);

  const togglePreview = useCallback(() => {
    setPreviewEnabled((enabled) => {
      if (!enabled) {
        setStreamToken((current) => current + 1);
        setError(null);
      } else if (deviceName) {
        void stopVideoStream(deviceName).catch((err) => {
          setError(err instanceof Error ? err.message : "Unable to release preview stream");
        });
      }
      return !enabled;
    });
  }, [deviceName]);

  const restartPreview = useCallback(() => {
    setStreamToken((current) => current + 1);
  }, []);

  const startRecording = useCallback(async () => {
    if (!deviceName || !selectedFormat) {
      return;
    }
    setPending(true);
    setError(null);
    try {
      const nextStatus = await startVideoRecording(deviceName, selectedFormat);
      setStatus(nextStatus);
      if (nextStatus.recording && !keepPreviewDuringRecording) {
        // A direct recording owns the camera exclusively, so the preview
        // stream was already stopped server-side. Mirror that locally instead
        // of letting the img element retry against a busy device. Under the
        // virtual-cam relay the recorder reads the shared frame tap — no
        // exclusivity, so the preview stays live.
        setPreviewEnabled((enabled) => {
          resumePreviewAfterRecordingRef.current = enabled;
          return false;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start recording");
    } finally {
      setPending(false);
    }
  }, [deviceName, selectedFormat, keepPreviewDuringRecording]);

  const stopRecording = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      setStatus(await stopVideoRecording());
      if (resumePreviewAfterRecordingRef.current) {
        resumePreviewAfterRecordingRef.current = false;
        setStreamToken((current) => current + 1);
        setPreviewEnabled(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to stop recording");
    } finally {
      setPending(false);
    }
  }, []);

  return {
    previewEnabled,
    streamUrl,
    status,
    pending,
    error,
    togglePreview,
    restartPreview,
    refreshStatus,
    startRecording,
    stopRecording
  };
}
