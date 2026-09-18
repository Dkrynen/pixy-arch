import { PhoneCall } from "lucide-react";

import type { UseAutomationResult } from "../../hooks/useAutomation";
import type { AutomationSettings } from "../../types/api";

type Props = {
  automation: UseAutomationResult;
};

export function AutomationPanel({ automation }: Props) {
  const status = automation.status;
  const settings = status?.settings;
  const disabled = automation.pending || !settings;

  const patch = (update: Partial<AutomationSettings>) => {
    if (!settings) return;
    void automation.applySettings({ ...settings, ...update });
  };

  return (
    <section className="smart-panel">
      <div className="panel-title-row">
        <PhoneCall size={18} />
        <h2>Call Automation</h2>
      </div>

      <div className="hid-status-row">
        <span className={`hid-dot ${status?.camera_in_use ? "is-ready" : status?.running ? "is-warn" : ""}`} />
        <div>
          <strong>{status?.camera_in_use ? "Camera in use" : status?.running ? "Watching" : "Stopped"}</strong>
          <small>
            {status?.holders.length ? status.holders.join(", ") : status?.last_action ?? "No active holders"}
          </small>
        </div>
      </div>

      {automation.error && <div className="mini-error">{automation.error}</div>}

      <div className="smart-control-stack">
        <div className="smart-control smart-toggle-row">
          <div className="smart-label">
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
        </div>

        <div className="smart-control">
          <div className="smart-label">
            <span>Grace {settings?.grace_seconds ?? 0}s</span>
          </div>
          <input
            type="range"
            min={0}
            max={30}
            step={1}
            value={settings?.grace_seconds ?? 8}
            disabled={disabled}
            onChange={(event) => patch({ grace_seconds: Number(event.target.value) })}
          />
        </div>
      </div>
    </section>
  );
}
