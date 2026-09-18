import { useEffect, useState } from "react";
import { Mic, PhoneCall, Shield } from "lucide-react";

import type { AutomationSettings, UseAutomationResult } from "../../hooks/useAutomation";

type Props = {
  automation: UseAutomationResult;
};

export function AutomationPanel({ automation }: Props) {
  const status = automation.status;
  const settings = status?.settings;
  const disabled = automation.pending || !settings;
  const [graceDraft, setGraceDraft] = useState<number | null>(null);

  useEffect(() => {
    setGraceDraft(null);
  }, [settings?.grace_seconds]);

  const patch = (update: Partial<AutomationSettings>) => {
    if (!settings) return;
    void automation.applySettings({ ...settings, ...update });
  };

  const commitGrace = () => {
    if (graceDraft === null || !settings || graceDraft === settings.grace_seconds) {
      return;
    }
    patch({ grace_seconds: graceDraft });
  };

  const graceValue = graceDraft ?? settings?.grace_seconds ?? 8;
  const unmuteMic = settings?.unmute_mic ?? true;

  return (
    <section className="smart-panel">
      <div className="panel-title-row">
        <PhoneCall size={18} />
        <h2>Call Automation</h2>
      </div>

      <div className="hid-status-row">
        <span className={`hid-dot ${status?.camera_in_use ? "is-ready" : status?.running ? "is-warn" : ""}`} />
        <div>
          <strong>
            {status?.camera_in_use ? "Call in progress" : status?.running ? "Watching for calls" : "Stopped"}
          </strong>
          <small>
            {status?.camera_in_use && status.holders.length
              ? `Held by ${status.holders.join(", ")}`
              : status?.running
                ? `Watching ${settings?.video_device ?? "camera"}`
                : lastActionText(status?.last_action)}
          </small>
        </div>
      </div>

      {status?.camera_in_use && (
        <small className="privacy-help">
          {status.mic_unmuted ? "Mic unmuted by automation · " : ""}
          {lastActionText(status.last_action)}
        </small>
      )}

      {automation.error && <div className="mini-error">{automation.error}</div>}

      <div className="smart-control-stack">
        <div className="smart-control smart-toggle-row">
          <div className="smart-label">
            <Shield size={16} />
            <span>Enabled</span>
          </div>
          <button
            className={`toggle-switch ${settings?.enabled ? "is-on" : ""}`}
            disabled={disabled}
            aria-pressed={settings?.enabled ?? false}
            aria-label="Call automation"
            onClick={() => patch({ enabled: !(settings?.enabled ?? false) })}
          >
            <span />
          </button>
        </div>
        <small className="privacy-help">
          Detects when an app (Meet, Zoom, OBS…) opens the camera and acts on call start/end. The
          PixyPilot preview and PipeWire never count as a call.
        </small>

        <div className="smart-control">
          <div className="smart-label">
            <span>On call start</span>
          </div>
          <div className="segmented">
            <button
              className={settings?.on_open === "tracking" ? "is-selected" : ""}
              disabled={disabled}
              onClick={() => patch({ on_open: "tracking" })}
            >
              Tracking
            </button>
            <button
              className={settings?.on_open === "none" ? "is-selected" : ""}
              disabled={disabled}
              onClick={() => patch({ on_open: "none" })}
            >
              Nothing
            </button>
          </div>
          <small className="privacy-help">
            Tracking opens the lens and enables auto-follow when a call grabs the camera.
          </small>
        </div>

        <div className="smart-control">
          <div className="smart-label">
            <span>On call end</span>
          </div>
          <div className="segmented">
            <button
              className={settings?.on_close === "privacy" ? "is-selected" : ""}
              disabled={disabled}
              onClick={() => patch({ on_close: "privacy" })}
            >
              Privacy
            </button>
            <button
              className={settings?.on_close === "previous" ? "is-selected" : ""}
              disabled={disabled}
              onClick={() => patch({ on_close: "previous" })}
            >
              Restore
            </button>
            <button
              className={settings?.on_close === "none" ? "is-selected" : ""}
              disabled={disabled}
              onClick={() => patch({ on_close: "none" })}
            >
              Nothing
            </button>
          </div>
          <small className="privacy-help">
            {settings?.on_close === "previous"
              ? `Returns to the mode saved when the call started${status?.saved_mode ? ` (${status.saved_mode})` : ""}.`
              : settings?.on_close === "privacy"
                ? "Parks the lens in privacy mode when the call releases the camera."
                : "Leaves the camera mode untouched when the call ends."}
          </small>
        </div>

        <div className="smart-control smart-toggle-row">
          <div className="smart-label">
            <Mic size={16} />
            <span>Unmute mic</span>
          </div>
          <button
            className={`toggle-switch ${unmuteMic ? "is-on" : ""}`}
            disabled={disabled}
            aria-pressed={unmuteMic}
            aria-label="Unmute mic during calls"
            onClick={() => patch({ unmute_mic: !unmuteMic })}
          >
            <span />
          </button>
        </div>
        <small className="privacy-help">
          Unmutes the PIXY mic while a call holds the camera, then re-mutes it afterwards — only if
          automation was the one that unmuted it.
        </small>

        <div className="smart-control">
          <div className="smart-label">
            <span>End delay {graceValue}s</span>
          </div>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={graceValue}
            disabled={disabled}
            aria-label="Call end delay seconds"
            onChange={(event) => setGraceDraft(Number(event.target.value))}
            onPointerUp={commitGrace}
            onKeyUp={(event) => {
              if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                commitGrace();
              }
            }}
            onBlur={commitGrace}
          />
          <small className="privacy-help">
            Waits this long after the last app lets go before running call-end actions — quick
            mute/unmute glitches in a call won't flap the lens.
          </small>
        </div>
      </div>

      {status?.last_action && !status.camera_in_use && (
        <div className="last-command">Last action: {status.last_action}</div>
      )}
    </section>
  );
}

function lastActionText(lastAction: string | null | undefined): string {
  if (!lastAction) {
    return "No call activity yet";
  }
  const [event, parts] = lastAction.split(":", 2);
  const label =
    parts
      ?.split("+")
      .map((part) => ACTION_LABELS[part] ?? part)
      .filter(Boolean)
      .join(", ") ?? "";
  if (event === "call-start") {
    return `Call started → ${label || "no action"}`;
  }
  if (event === "call-end") {
    return `Call ended → ${label || "no action"}`;
  }
  return lastAction;
}

const ACTION_LABELS: Record<string, string> = {
  tracking: "lens open + tracking",
  privacy: "privacy mode",
  unmute: "mic unmuted",
  remute: "mic re-muted",
  "skipped-hid-unwritable": "skipped (HID not writable)",
  "tracking-failed": "camera command failed",
  "unmute-failed": "mic unmute failed",
  "remute-failed": "mic re-mute failed",
  failed: "failed"
};
