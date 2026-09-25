import type { UsePrivacySafetyResult } from "../../hooks/usePrivacySafety";
import type { AppSettingsUpdate } from "../../types/api";

export type RuntimeSetting = {
  id: string;
  label: string;
  value: string;
  detail: string;
  group: string;
  /** Builds the PATCH body; absent for rows the API does not accept (YAML-only). */
  apply?: (value: string) => AppSettingsUpdate;
  /** Shown instead of an edit button on display-only rows. */
  readOnlyHint?: string;
  inputMode?: "text" | "number" | "select";
  options?: { label: string; value: string }[];
};

export const YAML_ONLY_HINT = "Edit config/pixypilot.yaml to change";

export function runtimeSettings(settings: NonNullable<UsePrivacySafetyResult["settings"]>): RuntimeSetting[] {
  return [
    {
      id: "startup-privacy",
      label: "Startup",
      value: String(settings.safety.start_in_privacy),
      detail: "live",
      group: "Safety",
      inputMode: "select",
      options: [
        { label: "Start private", value: "true" },
        { label: "Do not auto-park", value: "false" }
      ],
      apply: (value) => ({ safety: { start_in_privacy: value === "true" } })
    },
    {
      id: "server-host",
      label: "Bind host",
      value: settings.server.host,
      detail: "restart",
      group: "Backend",
      apply: (value) => ({ server: { host: cleanText(value, settings.server.host) } })
    },
    {
      id: "server-port",
      label: "Bind port",
      value: String(settings.server.port),
      detail: "restart",
      group: "Backend",
      inputMode: "number",
      apply: (value) => ({ server: { port: toPort(value, settings.server.port) } })
    },
    {
      id: "vite-host",
      label: "Vite host",
      value: settings.frontend.dev_server_host,
      detail: "dev restart",
      group: "Frontend",
      apply: (value) => ({ frontend: { dev_server: { host: cleanText(value, settings.frontend.dev_server_host) } } })
    },
    {
      id: "vite-port",
      label: "Vite port",
      value: String(settings.frontend.dev_server_port),
      detail: "dev restart",
      group: "Frontend",
      inputMode: "number",
      apply: (value) => ({ frontend: { dev_server: { port: toPort(value, settings.frontend.dev_server_port) } } })
    },
    {
      id: "frontend-dist",
      label: "UI dist",
      value: settings.frontend.dist_path,
      detail: "yaml",
      group: "Frontend",
      readOnlyHint: YAML_ONLY_HINT
    },
    {
      id: "presets",
      label: "Presets",
      value: settings.storage.presets_path,
      detail: "yaml",
      group: "Storage",
      readOnlyHint: YAML_ONLY_HINT
    },
    {
      id: "recordings",
      label: "Recordings",
      value: settings.storage.recordings_dir,
      detail: "live",
      group: "Storage",
      apply: (value) => ({ storage: { recordings: cleanText(value, settings.storage.recordings_dir) } })
    },
    {
      id: "hid-path",
      label: "HID path",
      value: settings.hid.path ?? "",
      detail: "live",
      group: "HID",
      apply: (value) => ({ hid: { path: value.trim() || null } })
    },
    {
      id: "hid-gap",
      label: "HID gap",
      value: String(settings.hid.report_gap_ms),
      detail: "live",
      group: "HID",
      inputMode: "number",
      apply: (value) => ({ hid: { report_gap_ms: toBoundedInt(value, settings.hid.report_gap_ms, 0, 1000) } })
    }
  ];
}

export function groupRuntimeSettings(rows: RuntimeSetting[]): { group: string; rows: RuntimeSetting[] }[] {
  const groups: { group: string; rows: RuntimeSetting[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.group === row.group) {
      last.rows.push(row);
    } else {
      groups.push({ group: row.group, rows: [row] });
    }
  }
  return groups;
}

export function displayRuntimeValue(row: RuntimeSetting) {
  if (row.inputMode !== "select") {
    return row.value || "auto";
  }
  return row.options?.find((option) => option.value === row.value)?.label ?? row.value;
}

export function runtimeDraftIsValid(row: RuntimeSetting, draft: string) {
  if (!row.apply) {
    return false;
  }
  if (row.inputMode === "number") {
    const parsed = Number(draft);
    const max = row.id === "hid-gap" ? 1000 : 65535;
    const min = row.id === "hid-gap" ? 0 : 1;
    return Number.isInteger(parsed) && parsed >= min && parsed <= max;
  }
  if (row.id === "server-host" || row.id === "vite-host") {
    return isValidBindHost(draft);
  }
  if (row.id === "hid-path") {
    // Mirrors the API: a /dev/hidrawN node, or empty for auto-detect.
    const trimmed = draft.trim();
    return trimmed === "" || /^\/dev\/hidraw\d+$/.test(trimmed);
  }
  if (row.inputMode !== "select") {
    return draft.trim().length > 0;
  }
  return true;
}

const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The API only binds to an IP literal or `localhost`; the backend has the final say. */
export function isValidBindHost(value: string): boolean {
  const host = value.trim();
  if (host.toLowerCase() === "localhost" || IPV4_PATTERN.test(host)) {
    return true;
  }
  // IPv6: hex groups and colons (optionally an embedded IPv4 tail or %zone).
  return host.includes(":") && /^[0-9a-f:.]+(%[\w.-]+)?$/i.test(host);
}

/** True for hosts only this machine can reach (127.0.0.0/8, ::1, localhost). */
export function isLoopbackHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return IPV4_PATTERN.test(host) && host.startsWith("127.");
}

function cleanText(value: string, fallback: string) {
  return value.trim() || fallback;
}

function toPort(value: string, fallback: number) {
  return toBoundedInt(value, fallback, 1, 65535);
}

function toBoundedInt(value: string, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
