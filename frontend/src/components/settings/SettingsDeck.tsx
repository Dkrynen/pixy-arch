import { FileCog } from "lucide-react";

import type { UseAutomationResult } from "../../hooks/useAutomation";
import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import { AutomationPanel } from "../panels/AutomationPanel";
import { RuntimeSettingsPanel } from "./RuntimeSettingsPanel";

type Props = {
  privacySafety: UsePrivacySafetyResult;
  automation: UseAutomationResult;
};

export function SettingsDeck({ privacySafety, automation }: Props) {
  const settings = privacySafety.settings;

  return (
    <div className="settings-console">
      <section className="settings-summary-panel">
        <div className="panel-title-row">
          <FileCog size={16} />
          <h2>Settings</h2>
        </div>
        <dl className="settings-summary-grid">
          <SettingsSummaryItem
            label="Startup"
            value={settings?.safety.start_in_privacy ? "Start private" : "No auto privacy"}
            tone={settings?.safety.start_in_privacy ? "good" : "warn"}
          />
          <SettingsSummaryItem
            label="Server"
            value={settings?.server.url ?? "http://127.0.0.1:8000"}
            tone={settings?.frontend.single_port ? "good" : "warn"}
            mono
          />
          <SettingsSummaryItem
            label="Mode"
            value={settings?.frontend.single_port ? "Single address" : "Developer mode"}
            tone={settings?.frontend.single_port ? "good" : "warn"}
          />
          <SettingsSummaryItem label="HID" value={settings?.hid.path ?? "Auto detect"} tone="info" />
        </dl>
      </section>
      <div className="settings-grid">
        <RuntimeSettingsPanel privacySafety={privacySafety} />
        <AutomationPanel automation={automation} />
      </div>
    </div>
  );
}

function SettingsSummaryItem({
  label,
  value,
  tone,
  mono = false
}: {
  label: string;
  value: string;
  tone: "good" | "warn" | "info";
  mono?: boolean;
}) {
  return (
    <div className={`settings-summary-item tone-${tone}`}>
      <dt>{label}</dt>
      <dd className={mono ? "is-mono" : undefined} title={value}>
        <span className="status-dot" aria-hidden="true" />
        {value}
      </dd>
    </div>
  );
}
