import {
  Crosshair,
  Expand,
  Eye,
  EyeOff,
  Loader2,
  Maximize,
  Minimize,
  Shield,
  Shrink,
  Square,
  Unplug,
  Video
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import {
  focusPointFromContainClick,
  focusPointFromCoverClick,
  type FocusPoint
} from "../../domains/video/focusPoint";
import type { UsePixyHidResult } from "../../hooks/usePixyHid";
import type { UseVideoCaptureResult } from "../../hooks/useVideoCapture";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import { fetchStreamError } from "../../lib/apiClient";
import "./VideoMonitor.css";

const MAX_STREAM_RETRIES = 4;
const STREAM_RETRY_BASE_MS = 750;

type Props = {
  deviceName: string | null;
  videoFormats: UseVideoFormatsResult;
  videoCapture: UseVideoCaptureResult;
  pixyHid: UsePixyHidResult;
  virtualCamRunning?: boolean;
  /** Injectable for tests; reads the backend's reason for a failed stream. */
  probeStreamError?: (url: string) => Promise<string | null>;
};

export function VideoMonitor({
  deviceName,
  videoFormats,
  videoCapture,
  pixyHid,
  virtualCamRunning,
  probeStreamError = fetchStreamError
}: Props) {
  const selectedFormat = videoFormats.selectedFormat;
  const canUseVideo = Boolean(deviceName && selectedFormat);
  const isRecording = videoCapture.status?.recording === true;
  const isPrivacy = pixyHid.deviceTrackingState === "privacy";
  const [focusTarget, setFocusTarget] = useState<FocusPoint | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamFailureReason, setStreamFailureReason] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [fillFrame, setFillFrame] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const retryCountRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  // Set when a streamUrl change came from our own auto-retry so the reset
  // effect preserves the retry counter — without it every retry resets the
  // count to 0 and the "unavailable" state is unreachable.
  const retryingRef = useRef(false);
  const [streamDims, setStreamDims] = useState<{ width: number; height: number } | null>(null);
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

  // Relay frames arrive at the feeder's native dims, not the requested
  // format — naturalWidth/Height is the truth for click mapping + aspect.
  const imageDims = streamDims ??
    (selectedFormat ? { width: selectedFormat.width, height: selectedFormat.height } : null);

  const handleFocusClick = async (event: PointerEvent<HTMLDivElement>) => {
    if (!canClickFocus || !imageDims) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    const mapClick = fillFrame ? focusPointFromCoverClick : focusPointFromContainClick;
    const point = mapClick(
      { width: rect.width, height: rect.height },
      imageDims,
      { x: event.clientX - rect.left, y: event.clientY - rect.top }
    );
    if (!point) {
      return;
    }

    if ((await pixyHid.setFocusMeteringMode("selected_area", point)) === false) {
      // The command failed (reason shown by the HID error strip): no marker.
      return;
    }
    setFocusTarget({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100
    });
  };

  // Keep isFullscreen in sync with the browser (Esc exits without our button).
  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === frameRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === frameRef.current) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void frameRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  // Reset stream/focus bookkeeping whenever a new stream URL is issued —
  // except auto-retry URL bumps, which must keep the retry counter alive.
  useEffect(() => {
    if (!retryingRef.current) {
      retryCountRef.current = 0;
    }
    retryingRef.current = false;
    setStreamReady(false);
    setStreamFailed(false);
    setStreamFailureReason(null);
    setStreamDims(null);
    setFocusTarget(null);
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, [videoCapture.streamUrl]);

  // A direct recording claims the camera exclusively: drop the preview stream
  // instead of hammering a busy device with reconnects. Under the virtual-cam
  // relay the recorder reads the shared frame tap, so preview can stay live.
  const { previewEnabled, togglePreview } = videoCapture;
  useEffect(() => {
    if (isRecording && previewEnabled && !virtualCamRunning) {
      togglePreview();
    }
  }, [isRecording, previewEnabled, virtualCamRunning, togglePreview]);

  // The stream endpoint switches between the relay tap and a direct device
  // read when the virtual cam starts/stops — reload the preview so a
  // cleanly-ended relay stream never freezes on its last frame.
  const prevVirtualCamRef = useRef(virtualCamRunning);
  useEffect(() => {
    const prev = prevVirtualCamRef.current;
    prevVirtualCamRef.current = virtualCamRunning;
    if (prev !== virtualCamRunning && previewEnabled) {
      videoCapture.restartPreview();
    }
  }, [virtualCamRunning, previewEnabled, videoCapture]);

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

  // Once retries are exhausted, ask the backend why (e.g. 422 bad format,
  // 503 camera busy) so the overlay can say more than "no frames".
  const failedStreamUrl = streamFailed ? videoCapture.streamUrl : null;
  useEffect(() => {
    if (!failedStreamUrl) {
      return;
    }
    let cancelled = false;
    void probeStreamError(failedStreamUrl).then((reason) => {
      if (!cancelled && reason) {
        setStreamFailureReason(reason);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [failedStreamUrl, probeStreamError]);

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
      retryingRef.current = true;
      videoCapture.restartPreview();
    }, delay);
  };

  const handleStreamLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    retryCountRef.current = 0;
    setStreamReady(true);
    setStreamFailed(false);
    const img = event.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setStreamDims({ width: img.naturalWidth, height: img.naturalHeight });
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const handleRetryStream = () => {
    retryCountRef.current = 0;
    setStreamFailed(false);
    setStreamFailureReason(null);
    setStreamReady(false);
    videoCapture.restartPreview();
  };

  const recordingElapsed = isRecording ? formatElapsed(videoCapture.status?.started_at, nowMs) : null;
  const recordingReason =
    !isRecording && videoCapture.status?.reason && videoCapture.status.reason !== "No recording is running"
      ? videoCapture.status.reason
      : null;

  const statusChip = isRecording
    ? { tone: "danger", label: `Recording ${recordingElapsed}` }
    : isPrivacy
      ? { tone: "warn", label: "Privacy" }
      : videoCapture.previewEnabled
        ? streamFailed
          ? { tone: "danger", label: "No signal" }
          : { tone: "good", label: "Live" }
        : { tone: "neutral", label: "Idle" };
  const formatText = selectedFormat
    ? `${selectedFormat.width}×${selectedFormat.height} · ${Math.round(selectedFormat.fps * 100) / 100} fps · ${selectedFormat.pixel_format}`
    : null;
  const statusText = isRecording
    ? `Recording to ${videoCapture.status?.path ?? "disk"}`
    : canClickFocus
      ? "Click the preview to set the focus point"
      : (selectedFormat?.label ?? "No stream format selected");

  return (
    <section className="video-monitor control-panel">
      <div className="video-monitor-header">
        <div className="panel-title-row">
          <Video size={16} />
          <h2>Live monitor</h2>
          <strong className={`monitor-state tone-${statusChip.tone}`} aria-live="polite">
            <span className="monitor-state-dot" aria-hidden="true" />
            {statusChip.label}
          </strong>
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
            {videoCapture.previewEnabled ? <EyeOff size={15} /> : <Eye size={15} />}
            <span className="button-label">{videoCapture.previewEnabled ? "Hide" : "Show"}</span>
          </button>
          <button
            className="icon-button"
            disabled={!videoCapture.streamUrl}
            onClick={() => setFillFrame((current) => !current)}
            aria-pressed={fillFrame}
            aria-label={fillFrame ? "Fit frame (show whole image)" : "Fill frame (crop to fill)"}
            title={fillFrame ? "Fit — show the whole image" : "Fill — crop to remove black bars"}
          >
            {fillFrame ? <Shrink size={15} /> : <Expand size={15} />}
          </button>
          <button
            className="icon-button"
            disabled={!videoCapture.streamUrl}
            onClick={toggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen preview"}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen preview"}
          >
            {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
          <button
            className={`secondary-button record-button ${isRecording ? "is-recording" : ""}`}
            disabled={!canUseVideo || videoCapture.pending}
            onClick={() => void (isRecording ? videoCapture.stopRecording() : videoCapture.startRecording())}
            aria-label={isRecording ? "Stop recording" : "Start recording"}
            title={isRecording ? "Stop recording" : "Start recording"}
          >
            {isRecording ? <Square size={12} fill="currentColor" /> : <span className="record-glyph" aria-hidden="true" />}
            <span className="button-label">{isRecording ? "Stop" : "Record"}</span>
          </button>
        </div>
      </div>

      <div
        ref={frameRef}
        className={`video-frame ${fillFrame ? "fit-cover" : ""} ${canClickFocus ? "can-click-focus" : ""} ${isPrivacy ? "is-privacy" : ""} ${streamFailed ? "stream-failed" : ""} ${isRecording ? "is-recording" : ""}`}
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
            {streamReady && !isPrivacy && !streamFailed && (
              <span className="video-scrim" aria-hidden="true" />
            )}
            {streamReady && formatText && !streamFailed && !isPrivacy && (
              <span className="video-chip video-chip-format" aria-hidden="true">
                {formatText}
              </span>
            )}
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
                <Loader2 size={20} />
                Connecting to camera…
              </span>
            )}
            {isPrivacy && (
              <span className="video-overlay is-privacy">
                <span className="video-overlay-icon">
                  <Shield size={22} />
                </span>
                <strong>Lens closed</strong>
                <span>Privacy mode is on — the camera is shielding the image.</span>
              </span>
            )}
            {streamFailed && (
              <span className="video-overlay is-failed">
                <span className="video-overlay-icon">
                  <Unplug size={22} />
                </span>
                <strong>Preview unavailable</strong>
                <span>
                  {streamFailureReason ??
                    "The camera did not deliver frames — it may be busy in another app or unplugged."}
                </span>
                <button type="button" className="secondary-button" onClick={handleRetryStream}>
                  Retry preview
                </button>
              </span>
            )}
          </>
        ) : (
          <div className={`video-placeholder ${isRecording ? "is-recording" : ""}`}>
            <span className="video-overlay-icon">
              {isRecording ? <span className="rec-dot" aria-hidden="true" /> : <Video size={22} />}
            </span>
            <strong>
              {isRecording ? "Recording in progress" : canUseVideo ? "Preview paused" : "No capture device"}
            </strong>
            <span>
              {isRecording
                ? `Writing ${videoCapture.status?.path ?? "recording"}`
                : canUseVideo
                  ? virtualCamRunning
                    ? "Show starts the stream"
                    : "Show starts the stream and claims the camera"
                  : "Connect a camera to enable live preview"}
            </span>
            {canUseVideo && !isRecording && (
              <button
                type="button"
                className="secondary-button"
                onClick={videoCapture.togglePreview}
                aria-label="Start preview"
              >
                <Eye size={15} />
                Start preview
              </button>
            )}
          </div>
        )}
      </div>

      <div className="video-footer">
        <div className={`device-ownership-note ${(videoCapture.previewEnabled || isRecording) && !virtualCamRunning ? "is-locked" : ""}`}>
          <Unplug size={14} />
          <span>
            {isRecording
              ? virtualCamRunning
                ? "Recording from the camera tap — other apps can keep using the virtual camera."
                : "Recording owns the camera. Stop recording before opening it in another app."
              : videoCapture.previewEnabled
                ? virtualCamRunning
                  ? "Preview shares the camera tap — other apps can attach to the virtual camera."
                  : "Preview owns the camera. Hide preview before opening it in another app."
                : virtualCamRunning
                  ? "The virtual camera is streaming — other apps can attach to it."
                  : "Preview is stopped. The camera is available to other apps."}
          </span>
        </div>
        {(isRecording || !(streamReady && formatText)) && (
          <span className="video-status-text" title={statusText}>
            {statusText}
          </span>
        )}
      </div>
      {!isRecording && videoCapture.status?.path && (
        <div className="video-record-path" title={videoCapture.status.path}>
          Last recording: {videoCapture.status.path}
        </div>
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
