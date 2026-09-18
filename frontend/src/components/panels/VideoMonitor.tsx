import {
  Crosshair,
  Eye,
  EyeOff,
  Loader2,
  RadioTower,
  Shield,
  Square,
  Unplug,
  Video
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { focusPointFromContainClick, type FocusPoint } from "../../domains/video/focusPoint";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import "./VideoMonitor.css";

const MAX_STREAM_RETRIES = 4;
const STREAM_RETRY_BASE_MS = 750;

type Props = {
  deviceName: string | null;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
};

export function VideoMonitor({ deviceName, videoFormats, videoCapture, pixyHid }: Props) {
  const selectedFormat = videoFormats.selectedFormat;
  const canUseVideo = Boolean(deviceName && selectedFormat);
  const isRecording = videoCapture.status?.recording === true;
  const isPrivacy = pixyHid.deviceTrackingState === "privacy";
  const [focusTarget, setFocusTarget] = useState<FocusPoint | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const canClickFocus =
    Boolean(videoCapture.streamUrl && selectedFormat) &&
    !isRecording &&
    !isPrivacy &&
    pixyHid.status?.writable === true &&
    pixyHid.status.known_controls.includes("focus_metering") &&
    pixyHid.pendingCommand === null;

  const focusMeteringPoint =
    pixyHid.focusMeteringMode === "selected_area" ? pixyHid.focusMeteringPoint : null;
  const marker: FocusPoint | null =
    focusTarget ??
    (focusMeteringPoint
      ? { x: (focusMeteringPoint.x / 127) * 100, y: (focusMeteringPoint.y / 127) * 100 }
      : null);

  const handleFocusClick = async (event: PointerEvent<HTMLDivElement>) => {
    if (!canClickFocus || !selectedFormat) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const point = focusPointFromContainClick(
      { width: rect.width, height: rect.height },
      { width: selectedFormat.width, height: selectedFormat.height },
      { x: event.clientX - rect.left, y: event.clientY - rect.top }
    );
    if (!point) {
      return;
    }

    await pixyHid.setFocusMeteringMode("selected_area", point);
    setFocusTarget({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100
    });
  };

  // Reset stream/focus bookkeeping whenever a new stream URL is issued.
  useEffect(() => {
    retryCountRef.current = 0;
    setStreamReady(false);
    setStreamFailed(false);
    setFocusTarget(null);
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, [videoCapture.streamUrl]);

  // A recording claims the camera exclusively: drop the preview stream instead
  // of hammering a busy device with reconnects (covers recordings started
  // elsewhere too — our own startRecording already disables the preview).
  const { previewEnabled, togglePreview } = videoCapture;
  useEffect(() => {
    if (isRecording && previewEnabled) {
      togglePreview();
    }
  }, [isRecording, previewEnabled, togglePreview]);

  // Forget the local click marker once focus metering leaves selected-area mode.
  useEffect(() => {
    if (pixyHid.focusMeteringMode !== "selected_area") {
      setFocusTarget(null);
    }
  }, [pixyHid.focusMeteringMode]);

  // 1s ticker for the recording elapsed readout.
  useEffect(() => {
    if (!isRecording) {
      return;
    }
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [isRecording]);

  useEffect(
    () => () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
    },
    []
  );

  const handleStreamError = () => {
    if (!videoCapture.previewEnabled || reconnectTimerRef.current !== null || streamFailed) {
      return;
    }
    retryCountRef.current += 1;
    if (retryCountRef.current > MAX_STREAM_RETRIES) {
      setStreamFailed(true);
      return;
    }
    const delay = Math.min(STREAM_RETRY_BASE_MS * retryCountRef.current, 3000);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      videoCapture.restartPreview();
    }, delay);
  };

  const handleStreamLoad = () => {
    retryCountRef.current = 0;
    setStreamReady(true);
    setStreamFailed(false);
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const handleRetryStream = () => {
    retryCountRef.current = 0;
    setStreamFailed(false);
    setStreamReady(false);
    videoCapture.restartPreview();
  };

  const recordingElapsed = isRecording ? formatElapsed(videoCapture.status?.started_at, nowMs) : null;
  const recordingReason =
    !isRecording && videoCapture.status?.reason && videoCapture.status.reason !== "No recording is running"
      ? videoCapture.status.reason
      : null;

  return (
    <section className="video-monitor control-panel accent-cyan">
      <div className="video-monitor-header">
        <div className="panel-title-row">
          <Video size={18} />
          <h2>Live Monitor</h2>
        </div>
        <div className="video-actions">
          <button
            className="secondary-button"
            disabled={!canUseVideo || isRecording}
            onClick={videoCapture.togglePreview}
            aria-label={videoCapture.previewEnabled ? "Hide stream" : "Show stream"}
            title={
              isRecording
                ? "Preview is paused while recording"
                : videoCapture.previewEnabled
                  ? "Hide stream"
                  : "Show stream"
            }
          >
            {videoCapture.previewEnabled ? <EyeOff size={16} /> : <Eye size={16} />}
            {videoCapture.previewEnabled ? "Hide" : "Show"}
          </button>
          <button
            className={`secondary-button record-button ${isRecording ? "is-recording" : ""}`}
            disabled={!canUseVideo || videoCapture.pending}
            onClick={() => void (isRecording ? videoCapture.stopRecording() : videoCapture.startRecording())}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
            title={isRecording ? "Stop recording" : "Start recording"}
          >
            {isRecording ? <Square size={15} /> : <RadioTower size={16} />}
            {isRecording ? "Stop" : "Record"}
          </button>
        </div>
      </div>

      <div
        className={`video-frame ${canClickFocus ? "can-click-focus" : ""} ${isPrivacy ? "is-privacy" : ""} ${streamFailed ? "stream-failed" : ""}`}
        style={selectedFormat ? { aspectRatio: `${selectedFormat.width} / ${selectedFormat.height}` } : undefined}
        onPointerUp={(event) => void handleFocusClick(event)}
        title={canClickFocus ? "Click to set focus target" : undefined}
      >
        {videoCapture.streamUrl ? (
          <>
            <img
              key={videoCapture.streamUrl}
              src={videoCapture.streamUrl}
              alt="Live camera stream"
              onError={handleStreamError}
              onLoad={handleStreamLoad}
            />
            {marker && !isPrivacy && (
              <span
                className="focus-target-region"
                style={{
                  left: `${clampFocusRegionPercent(marker.x)}%`,
                  top: `${clampFocusRegionPercent(marker.y)}%`
                }}
                aria-hidden="true"
              />
            )}
            {isRecording && (
              <span className="video-chip video-chip-recording" aria-live="polite">
                <span className="rec-dot" />
                REC {recordingElapsed}
              </span>
            )}
            {canClickFocus && !marker && (
              <span className="video-chip video-chip-focus">
                <Crosshair size={12} />
                Click to focus
              </span>
            )}
            {pixyHid.focusMeteringMode === "selected_area" && (
              <span
                className="video-chip video-chip-mode"
                onPointerUp={(event) => event.stopPropagation()}
              >
                Region focus
                <button
                  type="button"
                  className="chip-action"
                  onClick={(event) => {
                    event.stopPropagation();
                    void pixyHid.setFocusMeteringMode("center");
                  }}
                >
                  Center
                </button>
              </span>
            )}
            {!streamReady && !streamFailed && !isPrivacy && (
              <span className="video-connecting" aria-live="polite">
                <Loader2 size={18} />
                Connecting to camera…
              </span>
            )}
            {isPrivacy && (
              <span className="video-overlay is-privacy">
                <Shield size={26} />
                <strong>Lens closed</strong>
                <span>Privacy mode is on — the camera is shielding the image.</span>
              </span>
            )}
            {streamFailed && (
              <span className="video-overlay">
                <Unplug size={26} />
                <strong>Preview unavailable</strong>
                <span>The camera did not deliver frames — it may be busy in another app or unplugged.</span>
                <button type="button" className="secondary-button" onClick={handleRetryStream}>
                  Retry preview
                </button>
              </span>
            )}
          </>
        ) : (
          <div className="video-placeholder">
            <Video size={28} />
            <strong>
              {isRecording ? "Recording in progress" : canUseVideo ? "Preview paused" : "No capture device"}
            </strong>
            <span>
              {isRecording
                ? `Writing ${videoCapture.status?.path ?? "recording"}`
                : canUseVideo
                  ? "Show starts the stream and claims the camera"
                  : "Connect a camera to enable live preview"}
            </span>
          </div>
        )}
      </div>

      <div className="video-status-row">
        <span>
          {isRecording
            ? `Recording to ${videoCapture.status?.path ?? "disk"}`
            : canClickFocus
              ? "Click preview to set the focus point"
              : (selectedFormat?.label ?? "No stream format selected")}
        </span>
        <strong>{isRecording ? `Recording ${recordingElapsed}` : videoCapture.previewEnabled ? "Previewing" : "Idle"}</strong>
      </div>
      <div className={`device-ownership-note ${videoCapture.previewEnabled || isRecording ? "is-locked" : ""}`}>
        <Unplug size={14} />
        <span>
          {isRecording
            ? "Recording owns the camera. Stop recording before opening it in another app."
            : videoCapture.previewEnabled
              ? "Preview owns the camera. Hide preview before opening it in another app."
              : "Preview is stopped. The camera is available to other apps."}
        </span>
      </div>
      {!isRecording && videoCapture.status?.path && (
        <div className="video-record-path">Last recording: {videoCapture.status.path}</div>
      )}
      {recordingReason && <div className="mini-error">{recordingReason}</div>}
      {videoCapture.error && <div className="mini-error">{videoCapture.error}</div>}
    </section>
  );
}

function clampFocusRegionPercent(value: number) {
  return Math.min(86, Math.max(14, value));
}

function formatElapsed(startedAt: string | null | undefined, nowMs: number) {
  const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const totalSeconds = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((nowMs - startedMs) / 1000))
    : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
