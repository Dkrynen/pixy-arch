import { useState } from "react";
import { Camera, Presentation } from "lucide-react";

import type { UseVirtualCamResult } from "../../hooks/useVirtualCam";
import type { VirtualCamTransform } from "../../types/api";

type Props = {
  virtualCam: UseVirtualCamResult;
};

const rotateOptions: { value: VirtualCamTransform["rotate"]; label: string }[] = [
  { value: 0, label: "0°" },
  { value: 90, label: "90°" },
  { value: 180, label: "180°" },
  { value: 270, label: "270°" }
];

export function VirtualCamPanel({ virtualCam }: Props) {
  const status = virtualCam.status;
  const running = status?.running ?? false;
  const [pipeline, setPipeline] = useState<"transform" | "whiteboard">("transform");
  const [transform, setTransform] = useState<VirtualCamTransform>({ mirror: false, rotate: 0, zoom: 1.0 });
  const disabled = virtualCam.pending;

  const start = () => {
    void virtualCam.start({ pipeline, transform });
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
          {status?.source_device && running && <small>Owning {status.source_device} — preview reads the loopback output</small>}
        </div>
      </div>
    </section>
  );
}
