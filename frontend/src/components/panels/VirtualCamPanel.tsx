import { useState } from "react";
import { Camera, Presentation } from "lucide-react";

import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import type { UseVirtualCamResult } from "../../hooks/useVirtualCam";
import type { VideoFormatOption, VirtualCamTransform } from "../../types/api";
import "./VirtualCamPanel.css";

type Props = {
  virtualCam: UseVirtualCamResult;
  videoFormats: UseVideoFormatsResult;
  privacySafety: UsePrivacySafetyResult;
};

const rotateOptions: { value: VirtualCamTransform["rotate"]; label: string }[] = [
  { value: 0, label: "0°" },
  { value: 90, label: "90°" },
  { value: 180, label: "180°" },
  { value: 270, label: "270°" }
];

// V4L2 fourcc → ffmpeg -input_format decoder name (the backend normalizes
// too, but sending the decoder name keeps the request self-describing).
const PIXEL_FORMAT_TO_INPUT: Record<string, string> = {
  MJPG: "mjpeg",
  YUYV: "yuyv422",
  NV12: "nv12"
};

function formatFps(fps: number): string {
  // 60.00024000096 → "60"; 29.97 → "29.97"
  return String(Math.round(fps * 100) / 100);
}

function formatOptionLabel(format: VideoFormatOption): string {
  return `${format.width}×${format.height} · ${formatFps(format.fps)} fps · ${format.pixel_format}`;
}

export function VirtualCamPanel({ virtualCam, videoFormats, privacySafety }: Props) {
  const status = virtualCam.status;
  const running = status?.running ?? false;
  const autostart = privacySafety.settings?.virtualcam.autostart ?? true;
  const toggleAutostart = (enabled: boolean) => {
    void privacySafety.saveSettings({ virtualcam: { autostart: enabled } }).catch(() => undefined);
  };
  const [pipeline, setPipeline] = useState<"transform" | "whiteboard">("transform");
  const [transform, setTransform] = useState<VirtualCamTransform>({ mirror: false, rotate: 0, zoom: 1.0 });
  const formats = videoFormats.formats;
  const defaultIndex = Math.max(
    0,
    formats.findIndex(
      (format) =>
        format.pixel_format === videoFormats.selectedFormat?.pixel_format &&
        format.width === videoFormats.selectedFormat?.width &&
        format.height === videoFormats.selectedFormat?.height &&
        format.fps === videoFormats.selectedFormat?.fps
    )
  );
  const [qualityIndex, setQualityIndex] = useState<number | null>(null);
  const quality = formats[qualityIndex ?? defaultIndex] ?? videoFormats.selectedFormat ?? null;
  const disabled = virtualCam.pending;

  const start = () => {
    void virtualCam.start({
      pipeline,
      transform,
      input_width: quality?.width,
      input_height: quality?.height,
      input_fps: quality?.fps,
      input_format: quality ? PIXEL_FORMAT_TO_INPUT[quality.pixel_format] ?? quality.pixel_format.toLowerCase() : undefined,
      output_width: quality?.width,
      output_height: quality?.height
    });
  };

  const negotiated =
    running && status?.output_width && status?.output_height
      ? `${status.output_width}×${status.output_height}`
      : null;
  const consumers = status?.consumers ?? 0;

  return (
    <section className="smart-panel">
      <div className="panel-title-row">
        <Camera size={18} />
        <h2>Virtual Camera</h2>
      </div>

      <div className="hid-status-row">
        <span className={`hid-dot ${running ? "is-ready" : status?.available ? "is-warn" : ""}`} />
        <div>
          <strong>{running ? `Streaming (${status?.pipeline})` : status?.available ? "Ready" : "No loopback device"}</strong>
          <small>
            {running
              ? `${status?.source_device ?? "camera"} → ${status?.sink_path ?? "loopback"}`
              : status?.sink_path ?? status?.reason ?? "Checking v4l2loopback"}
          </small>
          {running && (
            <small className="vcam-runtime-stats">
              {negotiated ?? "format pending"}
              {status?.output_pixel_format ? ` · ${status.output_pixel_format}` : ""}
              {status?.fps ? ` · ${formatFps(status.fps)} fps` : ""}
              {` · ${consumers} ${consumers === 1 ? "consumer" : "consumers"}`}
              {status?.frames != null ? ` · ${status.frames} frames` : ""}
            </small>
          )}
        </div>
      </div>

      {virtualCam.error && <div className="mini-error">{virtualCam.error}</div>}
      {!running && status?.last_error && (
        <div className="vcam-last-error" role="status">
          Last run ended: {status.last_error}
        </div>
      )}

      <div className="smart-control-stack">
        <div className="smart-control">
          <div className="smart-label">
            <Presentation size={16} />
            <span>Mode</span>
          </div>
          <div className="segmented">
            <button
              className={pipeline === "transform" ? "is-selected" : ""}
              disabled={disabled || running}
              onClick={() => setPipeline("transform")}
            >
              Transform
            </button>
            <button
              className={pipeline === "whiteboard" ? "is-selected" : ""}
              disabled={disabled || running}
              onClick={() => setPipeline("whiteboard")}
            >
              Whiteboard
            </button>
          </div>
        </div>

        <div className="smart-control">
          <div className="smart-label">
            <span>Camera format</span>
          </div>
          <select
            className="vcam-quality-select"
            value={qualityIndex ?? defaultIndex}
            disabled={disabled || running || formats.length === 0}
            onChange={(event) => setQualityIndex(Number(event.target.value))}
          >
            {formats.map((format, index) => (
              <option key={`${format.pixel_format}-${format.width}x${format.height}-${format.fps}`} value={index}>
                {formatOptionLabel(format)}
              </option>
            ))}
            {formats.length === 0 && quality && <option value={0}>{formatOptionLabel(quality)}</option>}
          </select>
          <small className="vcam-field-hint">
            Resolution, frame rate and encoding captured from the Pixy — output matches it.
          </small>
        </div>

        {pipeline === "transform" && (
          <>
            <div className="smart-control smart-toggle-row">
              <div className="smart-label">
                <span>Mirror</span>
              </div>
              <button
                className={`toggle-switch ${transform.mirror ? "is-on" : ""}`}
                disabled={disabled || running}
                aria-pressed={transform.mirror}
                aria-label="Mirror"
                onClick={() => setTransform((t) => ({ ...t, mirror: !t.mirror }))}
              >
                <span />
              </button>
            </div>

            <div className="smart-control">
              <div className="smart-label">
                <span>Rotate</span>
              </div>
              <div className="segmented">
                {rotateOptions.map((option) => (
                  <button
                    key={option.value}
                    className={transform.rotate === option.value ? "is-selected" : ""}
                    disabled={disabled || running}
                    onClick={() => setTransform((t) => ({ ...t, rotate: option.value }))}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="smart-control">
              <div className="smart-label">
                <span>Zoom {transform.zoom.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={1}
                max={4}
                step={0.1}
                value={transform.zoom}
                disabled={disabled || running}
                onChange={(event) => setTransform((t) => ({ ...t, zoom: Number(event.target.value) }))}
              />
            </div>
          </>
        )}

        <div className="smart-control">
          {running ? (
            <button className="primary-action" disabled={disabled} onClick={() => void virtualCam.stop()}>
              {virtualCam.pending ? "Stopping…" : "Stop virtual camera"}
            </button>
          ) : (
            <button
              className="primary-action"
              disabled={disabled || !(status?.available ?? false)}
              onClick={start}
            >
              {virtualCam.pending ? "Starting…" : "Start virtual camera"}
            </button>
          )}
          <small className="vcam-obs-hint">
            {running ? (
              <>
                In OBS: add a Video Capture Device source and pick{" "}
                <strong>{status?.sink_path ?? "the virtual camera"}</strong>. The live monitor shows
                this same feed while the pipeline runs.
              </>
            ) : (
              <>
                The loopback only advertises a camera while it is streaming — keep it running
                (or enable startup below) for OBS to see it.
              </>
            )}
          </small>
        </div>

        <div className="smart-control smart-toggle-row">
          <div className="smart-label">
            <span>Run at startup</span>
          </div>
          <button
            className={`toggle-switch ${autostart ? "is-on" : ""}`}
            disabled={privacySafety.settingsPending || !privacySafety.settingsLoaded}
            aria-pressed={autostart}
            aria-label="Run virtual camera at startup"
            onClick={() => toggleAutostart(!autostart)}
          >
            <span />
          </button>
          <small className="vcam-field-hint">
            {autostart
              ? "Always streaming — OBS sees the camera as soon as the service is up."
              : "Start the pipeline manually; the device appears in OBS only while streaming."}
          </small>
        </div>
      </div>
    </section>
  );
}
