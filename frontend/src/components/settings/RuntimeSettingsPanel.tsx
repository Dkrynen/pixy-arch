import { ServerCog } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import { EditableRuntimeRow, ReadOnlyRuntimeRow } from "./RuntimeSettingRow";
import { groupRuntimeSettings, runtimeSettings, type RuntimeSetting } from "./runtimeSettings";

type Props = {
  privacySafety: UsePrivacySafetyResult;
};

export function RuntimeSettingsPanel({ privacySafety }: Props) {
  const settings = privacySafety.settings;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const rows = settings ? runtimeSettings(settings) : [];
  const groups = groupRuntimeSettings(rows);
  const pending = privacySafety.settingsPending;

  useEffect(() => {
    if (!message) {
      return;
    }
    const timer = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const startEdit = (row: RuntimeSetting) => {
    setEditingId(row.id);
    setDraft(row.value);
    setMessage(null);
  };

  const saveRow = async (row: RuntimeSetting) => {
    try {
      await privacySafety.saveSettings(row.apply(draft));
      setEditingId(null);
      setMessage(`${row.label} saved`);
    } catch {
      // saveSettings already surfaced the reason via settingsError — keep the
      // row open so the user can fix or cancel instead of losing the draft.
      setMessage(null);
    }
  };

  return (
    <section className="runtime-panel">
      <div className="panel-title-row">
        <ServerCog size={18} />
        <h2>Runtime Config</h2>
      </div>
      <div className="runtime-mode">
        <strong>{settings?.server.url ?? "http://127.0.0.1:8000"}</strong>
        <span>{settings?.frontend.single_port ? "Single address" : "Developer mode"}</span>
      </div>
      {privacySafety.settingsError && <div className="mini-error">{privacySafety.settingsError}</div>}
      {message && <div className="mini-success">{message}</div>}
      <div className="runtime-list">
        <ReadOnlyRuntimeRow label="YAML" value={settings?.config.path ?? "config/pixypilot.yaml"} />
        {groups.map((group) => (
          <Fragment key={group.group}>
            <span className="rail-section-title">{group.group}</span>
            {group.rows.map((row) => (
              <EditableRuntimeRow
                key={row.id}
                row={row}
                disabled={pending}
                editing={editingId === row.id}
                draft={draft}
                onCancel={() => setEditingId(null)}
                onDraftChange={setDraft}
                onEdit={() => startEdit(row)}
                onSave={() => void saveRow(row)}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </section>
  );
}
