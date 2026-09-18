import { useState } from "react";
import { Camera, Presentation } from "lucide-react";

import type { UseVideoFormatsResult } from "../../hooks/useVideoFormats";
import type { UseVirtualCamResult } from "../../hooks/useVirtualCam";
import type { VirtualCamTransform } from "../../types/api";

type Props = {
  virtualCam: UseVirtualCamResult;
  videoFormats: UseVideoFormatsResult;
};

const rotateOptions: { value: VirtualCamTransform["rotate"]; label: string }[] = [
  { value: 0, label: "0°" },
  { value: 90, label: "90°" },
  { value: 180, label: "180°" },
  { value: 270, label: "270°" }
];

export function VirtualCamPanel({ virtualCam, videoFormats }: Props) {
  const status = virtualCam.status;
  const running = status?.running ?? false;
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
      output_width: quality?.width,
      output_height: quality?.height,
    });
  };

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
          <small>{status?.sink_path ?? status?.reason ?? "Checking v4l2loopback"}</small>
        </div>
      </div>

      {virtualCam.error && <div className="mini-error">{virtualCam.error}</div>}

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
            <span>Quality</span>
          </div>
          <select
            className="vcam-quality-select"
            value={qualityIndex ?? defaultIndex}
            disabled={disabled || running || formats.length === 0}
            onChange={(event) => setQualityIndex(Number(event.target.value))}
          >
            {formats.map((format, index) => (
              <option key={`${format.pixel_format}-${format.width}x${format.height}-${format.fps}`} value={index}>
                {format.label}
              </option>
            ))}
            {formats.length === 0 && quality && <option value={0}>{quality.label}</option>}
          </select>
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
              Stop virtual camera
            </button>
          ) : (
            <button
              className="primary-action"
              disabled={disabled || !(status?.available ?? false)}
              onClick={start}
            >
              Start virtual camera
            </button>
          )}
          {running ? (
            <small className="vcam-obs-hint">
              In OBS: add a Video Capture Device source and pick{" "}
              <strong>{status?.sink_path ?? "the virtual camera"}</strong>. PTZ, tracking, privacy and
              image controls here keep working while OBS records.
            </small>
          ) : (
            <small className="vcam-obs-hint">
              Feeds OBS or any recorder through {status?.sink_path ?? "/dev/video10"} while controls
              stay live. Takes exclusive hold of the camera — preview pauses while streaming.
            </small>
          )}
        </div>
      </div>
    </section>
  );
}
