import { ServerCog } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import { EditableRuntimeRow, ReadOnlyRuntimeRow } from "./RuntimeSettingRow";
import {
  groupRuntimeSettings,
  isLoopbackHost,
  isValidBindHost,
  runtimeSettings,
  type RuntimeSetting
} from "./runtimeSettings";

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

  // Warn about a saved host, or about a complete draft while editing it. The
  // Vite dev server proxies /api, so exposing it exposes the API as well.
  const exposedHosts = [
    { id: "server-host", label: "Bind host", saved: settings?.server.host },
    { id: "vite-host", label: "Vite host", saved: settings?.frontend.dev_server_host }
  ]
    .map(({ id, label, saved }) => ({
      id,
      label,
      host: editingId === id && isValidBindHost(draft) ? draft.trim() : saved ?? null
    }))
    .filter((entry): entry is { id: string; label: string; host: string } =>
      entry.host !== null && !isLoopbackHost(entry.host)
    );

  const startEdit = (row: RuntimeSetting) => {
    setEditingId(row.id);
    setDraft(row.value);
    setMessage(null);
  };

  const saveRow = async (row: RuntimeSetting) => {
    if (!row.apply) {
      return;
    }
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
      {exposedHosts.map((entry) => (
        <div key={entry.id} className="mini-warning bind-host-warning" role="alert">
          {entry.label} <code>{entry.host}</code> is not a loopback address. The API has no authentication:
          anyone who can reach this port on your network could view the camera, record, move it, and
          unmute the mic. Use 127.0.0.1 unless you trust every device on the network.
        </div>
      ))}
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
